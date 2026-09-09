import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { p2tr, Transaction } from "@scure/btc-signer";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import { deriveCpfpFundingKey } from "../src/cpfp-funding.ts";
import {
  constructSparkPackages,
  decodeDirectPathFromTreeNode,
  decodeRefundFromTreeNode,
  reattachPendingRefunds,
  type RefundReattachDeps,
} from "../src/spark-packages.ts";
import type { CpfpUtxo, LeafPackage, RecoveryBundle } from "../src/types.ts";

describe("Spark package construction", () => {
  it("rejects unsupported Spark networks before constructing packages", async () => {
    await expect(
      constructSparkPackages({
        bundle: {
          network: "NOT_A_NETWORK",
          leaves: [{ treeNodeHex: "00" }],
        } as unknown as RecoveryBundle,
        cpfpUtxos: [],
        feeRate: 1,
      }),
    ).rejects.toThrow(/Unsupported Spark network/);
  });
});

// The SDK's package builder drops a leaf's refund once its exit chain is on chain
// (it only emits the refund next to the still-un-broadcast node). reattachPendingRefunds
// puts the refund back so callers can still broadcast it after its timelock matures.
// Without this, auto-exit reads the empty list as "exit complete" and never sends
// the refund — the bug these tests guard against.
describe("reattachPendingRefunds", () => {
  const CPFP_UTXO: CpfpUtxo = {
    txid: "ab".repeat(32),
    vout: 0,
    value: 50_000n,
    script: `0014${"00".repeat(20)}`,
    publicKey: `02${"00".repeat(32)}`,
  };
  const bundle = {
    network: "REGTEST",
    leaves: [{ id: "L1", treeNodeHex: "aa" }],
  } as unknown as RecoveryBundle;

  const baseDeps = (): RefundReattachDeps => ({
    isTxBroadcast: async () => false,
    buildRefundFeeBump: (hex) => `psbt-${hex}`,
    refundForLeaf: () => ({
      txHex: "refundhex",
      completionVariants: [
        { txid: "cpfp-refund-txid", txHex: "refundhex" },
        { txid: "direct-refund-txid", txHex: "directrefundhex" },
      ],
    }),
  });

  it("re-attaches a leaf's refund when its exit chain is broadcast but the refund is not", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    const buildRefundFeeBump = vi.fn((hex: string) => `psbt-${hex}`);
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      buildRefundFeeBump,
    });
    expect(packages[0]!.txPackages).toEqual([
      { tx: "refundhex", feeBumpPsbt: "psbt-refundhex" },
    ]);
    expect(buildRefundFeeBump).toHaveBeenCalledOnce();
  });

  it("leaves the package list empty when the refund is already on chain (exit complete)", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    const buildRefundFeeBump = vi.fn();
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      isTxBroadcast: async () => true,
      buildRefundFeeBump,
    });
    expect(packages[0]!.txPackages).toEqual([]);
    expect(packages[0]!.sweepTx).toBe("refundhex");
    expect(buildRefundFeeBump).not.toHaveBeenCalled();
  });

  it("re-attaches when the completion check throws (non-JSON 404 from the esplora endpoint)", async () => {
    // The real SDK isTxBroadcast throws on mainnet when mempool.space answers a
    // not-found txid with a plain-text 404; that is the not-yet-broadcast case,
    // so the refund must still be re-attached, not dropped by a propagated throw.
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      isTxBroadcast: async () => {
        throw new SyntaxError('Unexpected token \'T\', "Transaction not found" is not valid JSON');
      },
    });
    expect(packages[0]!.txPackages).toEqual([
      { tx: "refundhex", feeBumpPsbt: "psbt-refundhex" },
    ]);
  });

  it("treats the exit as complete when the direct-refund variant is the one on chain", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    const buildRefundFeeBump = vi.fn();
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      // CPFP refund absent, but the direct variant (2nd id) is on chain.
      isTxBroadcast: async (txid) => txid === "direct-refund-txid",
      buildRefundFeeBump,
    });
    expect(packages[0]!.txPackages).toEqual([]);
    expect(packages[0]!.sweepTx).toBe("directrefundhex");
    expect(buildRefundFeeBump).not.toHaveBeenCalled();
  });

  it("keeps a leaf's existing package when no terminal refund variant is broadcast", async () => {
    const packages: LeafPackage[] = [
      { leafId: "L1", txPackages: [{ tx: "node", feeBumpPsbt: "p" }] },
    ];
    const refundForLeaf = vi.fn(() => ({
      txHex: "refundhex",
      completionVariants: [{ txid: "cpfp-refund-txid", txHex: "refundhex" }],
    }));
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      refundForLeaf,
    });
    expect(packages[0]!.txPackages).toEqual([{ tx: "node", feeBumpPsbt: "p" }]);
    expect(packages[0]!.sweepTx).toBeUndefined();
    expect(refundForLeaf).toHaveBeenCalledOnce();
  });

  it("replaces an impossible SDK package with the exact alternate refund on chain", async () => {
    const packages: LeafPackage[] = [
      { leafId: "L1", txPackages: [{ tx: "losing-node-branch", feeBumpPsbt: "p" }] },
    ];
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      isTxBroadcast: async (txid) => txid === "direct-refund-txid",
    });
    expect(packages[0]).toMatchObject({
      leafId: "L1",
      txPackages: [],
      sweepTx: "directrefundhex",
    });
  });

  it("throws when a pending refund has no funding UTXO (empty would read as complete)", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    await expect(
      reattachPendingRefunds(packages, bundle, [], 5, "REGTEST", baseDeps()),
    ).rejects.toThrow(/no funding UTXO left for 1 pending refund.*L1/);
    expect(packages[0]!.txPackages).toEqual([]); // not falsely funded
  });

  const twoLeafBundle = {
    network: "REGTEST",
    leaves: [
      { id: "L1", treeNodeHex: "aa" },
      { id: "L2", treeNodeHex: "bb" },
    ],
  } as unknown as RecoveryBundle;

  it("funds each leaf's refund from a DISTINCT UTXO (no shared-UTXO double-spend)", async () => {
    const packages: LeafPackage[] = [
      { leafId: "L1", txPackages: [] },
      { leafId: "L2", txPackages: [] },
    ];
    const utxoA = { ...CPFP_UTXO, txid: "aa".repeat(32) };
    const utxoB = { ...CPFP_UTXO, txid: "bb".repeat(32) };
    const fundedBy: string[] = [];
    await reattachPendingRefunds(packages, twoLeafBundle, [utxoA, utxoB], 5, "REGTEST", {
      ...baseDeps(),
      buildRefundFeeBump: (_hex, utxos) => {
        fundedBy.push(utxos[0]!.txid);
        return `psbt-${utxos[0]!.txid}`;
      },
    });
    expect(fundedBy).toEqual([utxoA.txid, utxoB.txid]); // distinct inputs, no conflict
    expect(packages[0]!.txPackages).toHaveLength(1);
    expect(packages[1]!.txPackages).toHaveLength(1);
  });

  it("funds what it can, then throws naming the leaves left unfunded when UTXOs run out", async () => {
    const packages: LeafPackage[] = [
      { leafId: "L1", txPackages: [] },
      { leafId: "L2", txPackages: [] },
    ];
    await expect(
      reattachPendingRefunds(packages, twoLeafBundle, [CPFP_UTXO], 5, "REGTEST", baseDeps()),
    ).rejects.toThrow(/no funding UTXO left for 1 pending refund.*L2/);
    expect(packages[0]!.txPackages).toHaveLength(1); // first still funded before the throw
    expect(packages[1]!.txPackages).toEqual([]); // no UTXO left, not falsely funded
  });

  // A swallowed decode/fee-bump error would leave txPackages empty, which the
  // caller reads as "exit complete" — silently re-stranding the refund. These
  // assert the failure is surfaced (with leaf context), not swallowed.
  it("surfaces (does not swallow) a refund-decode failure, tagged with the leaf id", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    await expect(
      reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
        ...baseDeps(),
        refundForLeaf: () => {
          throw new Error("invalid wire type");
        },
      }),
    ).rejects.toThrow(/leaf L1.*invalid wire type/);
  });

  it("surfaces (does not swallow) a fee-bump build failure, tagged with the leaf id", async () => {
    const packages: LeafPackage[] = [{ leafId: "L1", txPackages: [] }];
    await expect(
      reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
        ...baseDeps(),
        buildRefundFeeBump: () => {
          throw new Error("No UTXOs available for fee bump");
        },
      }),
    ).rejects.toThrow(/leaf L1.*No UTXOs available/);
  });
});

describe("decodeRefundFromTreeNode", () => {
  it("recognizes an unsigned alternative refund by the same txid as its signed form", () => {
    const signed = testTransaction(9000n);
    const unsignedHex = bytesToHex(signed.toBytes(true, false));
    expect(() => Transaction.fromRaw(hexToBytes(unsignedHex)).id).toThrow("not finalized");
    const treeNodeHex = bytesToHex(TreeNode.encode(TreeNode.create({
      refundTx: hexToBytes(testTransaction(10000n).hex),
      directFromCpfpRefundTx: hexToBytes(unsignedHex),
    })).finish());
    expect(decodeRefundFromTreeNode(treeNodeHex)?.completionVariants[1]).toEqual({ txid: signed.id, txHex: unsignedHex });
  });
  it("includes directRefundTx as a terminal sweep variant", () => {
    const refundTx = testTransaction(10_000n);
    const directFromCpfpRefundTx = testTransaction(9_000n);
    const directRefundTx = testTransaction(8_000n);
    const treeNodeHex = bytesToHex(
      TreeNode.encode(
        TreeNode.create({
          refundTx: hexToBytes(refundTx.hex),
          directFromCpfpRefundTx: hexToBytes(directFromCpfpRefundTx.hex),
          directRefundTx: hexToBytes(directRefundTx.hex),
        }),
      ).finish(),
    );

    const decoded = decodeRefundFromTreeNode(treeNodeHex);
    expect(decoded?.completionVariants).toEqual([
      { txid: refundTx.id, txHex: refundTx.hex },
      { txid: directFromCpfpRefundTx.id, txHex: directFromCpfpRefundTx.hex },
      { txid: directRefundTx.id, txHex: directRefundTx.hex },
    ]);
  });
});

function testTransaction(amount: bigint): Transaction {
  const privateKey = new Uint8Array(32).fill(2);
  const xonly = secp256k1.getPublicKey(privateKey, true).slice(1);
  const output = p2tr(xonly);
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: "00".repeat(32),
    index: 0,
    witnessUtxo: { amount: amount + 1_000n, script: output.script },
    tapInternalKey: xonly,
  });
  tx.addOutput({ script: output.script, amount });
  tx.sign(privateKey);
  tx.finalize();
  return tx;
}

// The direct path is the operator chainwatcher's self-fee-paying exit route,
// embedded in the TreeNode next to the CPFP transactions. auto-exit uses this
// decode to recognize when the operator won the broadcast race.
describe("decodeDirectPathFromTreeNode", () => {
  const KEY = deriveCpfpFundingKey({
    seed: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    network: "REGTEST",
    accountNumber: 0,
  });

  function buildTx(prevTxid: string, sequence?: number) {
    const tx = new Transaction();
    tx.addInput({
      txid: prevTxid,
      index: 0,
      ...(sequence !== undefined ? { sequence } : {}),
      witnessUtxo: { script: hexToBytes(KEY.script), amount: 50_000n },
    });
    tx.addOutput({ script: hexToBytes(KEY.script), amount: 49_000n });
    tx.sign(KEY.privateKey);
    tx.finalize();
    return { bytes: hexToBytes(tx.hex), hex: tx.hex, id: tx.id };
  }

  const encodeNode = (partial: Parameters<typeof TreeNode.fromPartial>[0]) =>
    bytesToHex(TreeNode.encode(TreeNode.fromPartial(partial)).finish());

  it("returns the direct txid and the direct refund tx from a TreeNode", () => {
    const directTx = buildTx("ab".repeat(32));
    const directRefundTx = buildTx("cd".repeat(32), 550);
    const treeNodeHex = encodeNode({
      id: "L1",
      directTx: directTx.bytes,
      directRefundTx: directRefundTx.bytes,
    });

    const decoded = decodeDirectPathFromTreeNode(treeNodeHex);
    expect(decoded).toEqual({
      directTxid: directTx.id,
      directRefundTxHex: directRefundTx.hex,
      directRefundTxid: directRefundTx.id,
    });
  });

  it("returns null when the TreeNode carries no direct path", () => {
    const nodeOnly = encodeNode({ id: "L1", nodeTx: buildTx("ab".repeat(32)).bytes });
    expect(decodeDirectPathFromTreeNode(nodeOnly)).toBeNull();

    const missingRefund = encodeNode({
      id: "L1",
      directTx: buildTx("ab".repeat(32)).bytes,
    });
    expect(decodeDirectPathFromTreeNode(missingRefund)).toBeNull();
  });
});
