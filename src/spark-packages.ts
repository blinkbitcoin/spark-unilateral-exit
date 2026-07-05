import { getNodeHexStrings } from "./bundle.ts";
import { hexToBytes } from "@noble/curves/utils";
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
  const { constructUnilateralExitFeeBumpPackages, Network } =
    (await import("@buildonspark/spark-sdk")) as unknown as SparkSdkModule;

  const network = normalizeNetwork(bundle.network, Network);
  const bundleSparkClient = sparkClient ?? createBundleSparkClient(bundle);
  return constructUnilateralExitFeeBumpPackages(
    getNodeHexStrings(bundle),
    cpfpUtxos,
    { satPerVbyte: feeRate },
    network,
    bundleSparkClient,
  );
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
