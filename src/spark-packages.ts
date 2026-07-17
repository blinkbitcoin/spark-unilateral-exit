import { getNodeHexStrings } from "./bundle.ts";
import { errMessage } from "./errors.ts";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import type { CpfpUtxo, LeafPackage, RecoveryBundle } from "./types.ts";

const NETWORKS = new Set(["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"]);

// Narrow local view of the pieces of the Spark SDK this module uses. The SDK is
// imported dynamically at runtime; skipLibCheck means its own types are not
// verified here, so we describe just the seam we depend on.
interface SparkSdkModule {
  constructUnilateralExitFeeBumpPackages: (
    nodeHexStrings: string[],
    cpfpUtxos: CpfpUtxo[],
    feeConfig: { satPerVbyte: number },
    network: unknown,
    sparkClient: unknown,
  ) => Promise<LeafPackage[]>;
  // Builds the CPFP fee-bump PSBT for a 0-fee Spark transaction (used here to
  // pay for the refund once its exit chain is already broadcast).
  constructFeeBumpTx: (
    txHex: string,
    utxos: CpfpUtxo[],
    feeConfig: { satPerVbyte: number },
    previousFeeBumpTx: unknown,
    logger: unknown,
  ) => { feeBumpPsbt: string; usedUtxos: unknown[] };
  // True when a transaction is already in the mempool or a block.
  isTxBroadcast: (txid: string, network: unknown) => Promise<boolean>;
  Network: Record<string, unknown>;
}

interface SparkNodeQueryRequest {
  source?: { $case?: string; nodeIds?: { nodeIds?: string[] } };
  includeParents?: boolean;
}

interface SparkBundleClient {
  query_nodes(request?: SparkNodeQueryRequest): Promise<{
    nodes: Record<string, TreeNode>;
    offset: number;
  }>;
}

interface ConstructSparkPackagesOptions {
  bundle: RecoveryBundle;
  cpfpUtxos: CpfpUtxo[];
  feeRate: number;
  sparkClient?: unknown;
}

export async function constructSparkPackages({
  bundle,
  cpfpUtxos,
  feeRate,
  sparkClient,
}: ConstructSparkPackagesOptions): Promise<LeafPackage[]> {
  const sdk = (await import(
    "@buildonspark/spark-sdk"
  )) as unknown as SparkSdkModule;

  const network = normalizeNetwork(bundle.network, sdk.Network);
  const bundleSparkClient = sparkClient ?? createBundleSparkClient(bundle);
  const packages = await sdk.constructUnilateralExitFeeBumpPackages(
    getNodeHexStrings(bundle),
    cpfpUtxos,
    { satPerVbyte: feeRate },
    network,
    bundleSparkClient,
  );

  await reattachPendingRefunds(packages, bundle, cpfpUtxos, feeRate, network, {
    isTxBroadcast: sdk.isTxBroadcast,
    buildRefundFeeBump: (refundTxHex, utxos, rate) =>
      sdk.constructFeeBumpTx(
        refundTxHex,
        utxos,
        { satPerVbyte: rate },
        undefined,
        undefined,
      ).feeBumpPsbt,
    refundForLeaf: decodeRefundFromTreeNode,
  });
  return packages;
}

// Dependencies the refund re-attachment needs, isolated behind an interface so it
// can be unit-tested without the real Spark SDK (mirrors how auto-exit.ts injects
// its chain/crypto seams).
export interface RefundReattachDeps {
  // True when a transaction is already on chain (mempool or confirmed).
  isTxBroadcast: (txid: string, network: unknown) => Promise<boolean>;
  // Build the CPFP fee-bump PSBT that pays for the 0-fee refund transaction.
  buildRefundFeeBump: (
    refundTxHex: string,
    cpfpUtxos: CpfpUtxo[],
    feeRate: number,
  ) => string;
  // Resolve a leaf's refund from its TreeNode hex: the CPFP refund transaction to
  // broadcast, plus the txids of every refund variant whose presence on chain
  // means the exit is already complete (e.g. the operator chainwatcher completes
  // it with the self-fee-paying direct variant, which spends the same node output).
  refundForLeaf: (
    treeNodeHex: string,
  ) => { txHex: string; completedTxids: string[] } | null;
}

// The SDK's package builder skips any node whose transaction is already on chain,
// and it only emits a leaf's refund alongside that leaf's (still-un-broadcast)
// node step. So once a leaf's exit chain has been broadcast the builder returns an
// EMPTY package list for it — even though the refund is a separate, CSV-timelocked
// transaction that still has to be broadcast once it matures. Re-attach that
// refund here (unless it is itself already on chain, i.e. the exit is truly
// complete) so callers can carry it to the chain. Without this, auto-exit sees an
// empty list, reports "all transactions broadcast", and the refund is never sent —
// the exact behavior its mocked constructPackages already assumes cannot happen.
//
// Note: auto-exit constructs one leaf per call, so the single funding UTXO funds
// exactly one refund here. Constructing many leaves at once with all their nodes
// already broadcast would fund each refund independently from the same UTXO(s);
// pass one UTXO per pending refund in that (uncommon) case.
export async function reattachPendingRefunds(
  packages: LeafPackage[],
  bundle: RecoveryBundle,
  cpfpUtxos: CpfpUtxo[],
  feeRate: number,
  network: unknown,
  deps: RefundReattachDeps,
): Promise<void> {
  const leafById = new Map(
    (bundle.leaves ?? []).map((leaf) => [leaf.id, leaf] as const),
  );
  // Fund one refund fee-bump per available UTXO. Refund fee-bump children are
  // v3/TRUC, so they can't be chained through a single UTXO's change (TRUC allows
  // only one unconfirmed ancestor); each re-attached refund gets its own funding
  // input. auto-exit constructs one leaf per call, so this is exactly one UTXO for
  // one refund there. A multi-leaf `package` run wants one UTXO per pending refund
  // — including the mixed case: if the same call has both still-broadcasting leaves
  // (whose node fee-bumps the SDK funds from cpfpUtxos) and fully-broadcast leaves
  // (whose refunds we fund here), both can pick the same UTXO and the two children
  // conflict at broadcast. No funds are lost (they stay in the node/refund outputs);
  // re-run with one distinct UTXO per pending refund. auto-exit is immune (1/call).
  const availableUtxos = [...cpfpUtxos];
  const unfundedLeafIds: string[] = [];
  for (const pkg of packages) {
    // A non-empty list means the exit chain is still being broadcast; the SDK
    // emits the refund itself on the round that broadcasts the leaf node.
    if ((pkg.txPackages?.length ?? 0) > 0) continue;
    if (pkg.leafId == null) continue;
    const leaf = leafById.get(pkg.leafId);
    if (!leaf?.treeNodeHex) continue;
    // Decoding the refund can throw on malformed bundle data. Re-throw with leaf
    // context rather than swallowing: a caught-and-skipped leaf would leave
    // txPackages empty, which the caller reads as "exit complete" — silently
    // re-stranding the refund this function exists to rescue. Surfacing the error
    // lets auto-exit retry and then flag the leaf instead of losing it.
    let refund: ReturnType<RefundReattachDeps["refundForLeaf"]>;
    try {
      refund = deps.refundForLeaf(leaf.treeNodeHex);
    } catch (err) {
      throw new Error(
        `reattachPendingRefunds: cannot decode refund for leaf ${pkg.leafId}: ${errMessage(err)}`,
        { cause: err },
      );
    }
    if (!refund) continue;
    // If any refund variant is already on chain, the exit is genuinely complete;
    // leave the list empty so the caller reports success instead of looping on a
    // refund that can no longer spend the (already-spent) node output.
    let alreadyExited = false;
    for (const txid of refund.completedTxids) {
      // The SDK's isTxBroadcast rejects (rather than returning false) when the
      // esplora endpoint answers a not-found txid with a non-JSON 404 body — e.g.
      // mempool.space on mainnet returns "Transaction not found", and .json()
      // throws. That is precisely the "refund not yet broadcast" case this
      // re-attach exists for, so treat a throw as not-on-chain and re-attach,
      // exactly as the SDK's own node-tx check swallows the same error. A refund
      // that IS on chain returns parseable JSON. The catch also masks transport
      // errors (esplora unreachable, timeouts), where an already-broadcast
      // refund gets re-attached anyway; that is benign — its broadcast then
      // fails missing-or-spent and the leaf is deferred and retried.
      let broadcast = false;
      try {
        broadcast = await deps.isTxBroadcast(txid, network);
      } catch {
        broadcast = false;
      }
      if (broadcast) {
        alreadyExited = true;
        break;
      }
    }
    if (alreadyExited) continue;
    // Out of funding: never double-spend one UTXO across refunds, and never
    // leave the package silently empty (the caller reads empty as "exit
    // complete"). Record the leaf and throw below, same surface-don't-swallow
    // treatment as the decode and fee-bump failures.
    const utxo = availableUtxos.shift();
    if (!utxo) {
      unfundedLeafIds.push(String(pkg.leafId));
      continue;
    }
    // Same rationale as the decode above: surface a fee-bump failure rather than
    // skip (a skip reads as complete and re-strands the refund).
    let feeBumpPsbt: string;
    try {
      feeBumpPsbt = deps.buildRefundFeeBump(refund.txHex, [utxo], feeRate);
    } catch (err) {
      throw new Error(
        `reattachPendingRefunds: cannot build refund fee-bump for leaf ${pkg.leafId}: ${errMessage(err)}`,
        { cause: err },
      );
    }
    pkg.txPackages = [
      ...(pkg.txPackages ?? []),
      { tx: refund.txHex, feeBumpPsbt },
    ];
  }
  if (unfundedLeafIds.length > 0) {
    throw new Error(
      `reattachPendingRefunds: no funding UTXO left for ${unfundedLeafIds.length} pending refund(s) ` +
        `(leaves: ${unfundedLeafIds.join(", ")}); re-run with one CPFP UTXO per pending refund`,
    );
  }
}

function decodeRefundFromTreeNode(
  treeNodeHex: string,
): { txHex: string; completedTxids: string[] } | null {
  const node = TreeNode.decode(hexToBytes(treeNodeHex));
  if (!node.refundTx || node.refundTx.length === 0) return null;
  const txHex = bytesToHex(node.refundTx);
  const completedTxids = [refundTxidFromHex(txHex)];
  // The operator chainwatcher completes the exit with the self-fee-paying direct
  // refund (a different txid spending the same node output); treat it as done too.
  if (node.directFromCpfpRefundTx && node.directFromCpfpRefundTx.length > 0) {
    completedTxids.push(
      refundTxidFromHex(bytesToHex(node.directFromCpfpRefundTx)),
    );
  }
  return { txHex, completedTxids };
}

// Spark refund transactions are v3 (TRUC) with a P2A anchor output, so the parser
// must allow unknown outputs/inputs (mirrors auto-exit.ts parseTransaction).
function refundTxidFromHex(txHex: string): string {
  return Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  }).id;
}

function createBundleSparkClient(
  bundle: RecoveryBundle,
): SparkBundleClient | undefined {
  const encodedNodes = new Map<string, string>();
  for (const leaf of bundle.leaves ?? []) {
    if (leaf?.id && leaf?.treeNodeHex) encodedNodes.set(leaf.id, leaf.treeNodeHex);
  }
  for (const node of bundle.nodes ?? []) {
    if (node?.id && node?.treeNodeHex) encodedNodes.set(node.id, node.treeNodeHex);
  }
  if (encodedNodes.size === 0) return undefined;

  const decodedNodes = new Map<string, TreeNode>();
  const decodeNode = (id: string): TreeNode | undefined => {
    if (decodedNodes.has(id)) return decodedNodes.get(id);
    const hex = encodedNodes.get(id);
    if (!hex) return undefined;
    const node = TreeNode.decode(hexToBytes(hex));
    decodedNodes.set(id, node);
    return node;
  };

  return {
    async query_nodes(request?: SparkNodeQueryRequest) {
      const requestedIds =
        request?.source?.$case === "nodeIds"
          ? (request.source.nodeIds?.nodeIds ?? [])
          : Array.from(encodedNodes.keys());
      const nodes: Record<string, TreeNode> = {};
      for (const id of requestedIds) {
        addNodeAndParents({ id, nodes, decodeNode, includeParents: request?.includeParents });
      }
      return { nodes, offset: 0 };
    },
  };
}

function addNodeAndParents({
  id,
  nodes,
  decodeNode,
  includeParents,
}: {
  id: string;
  nodes: Record<string, TreeNode>;
  decodeNode: (id: string) => TreeNode | undefined;
  includeParents?: boolean;
}) {
  let current = decodeNode(id);
  while (current) {
    nodes[current.id] = current;
    if (!includeParents || !current.parentNodeId) return;
    current = decodeNode(current.parentNodeId);
  }
}

function normalizeNetwork(
  network: string,
  sparkNetwork: Record<string, unknown>,
): unknown {
  const normalized = String(network).toUpperCase();
  if (!NETWORKS.has(normalized)) {
    throw new Error(`Unsupported Spark network: ${network}`);
  }
  return sparkNetwork[normalized];
}
