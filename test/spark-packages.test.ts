import { describe, expect, it, vi } from "vitest";

import {
  constructSparkPackages,
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
      completedTxids: ["cpfp-refund-txid", "direct-refund-txid"],
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
    expect(buildRefundFeeBump).not.toHaveBeenCalled();
  });

  it("does not touch a leaf whose exit chain is still being broadcast", async () => {
    const packages: LeafPackage[] = [
      { leafId: "L1", txPackages: [{ tx: "node", feeBumpPsbt: "p" }] },
    ];
    const refundForLeaf = vi.fn(() => ({
      txHex: "refundhex",
      completedTxids: ["cpfp-refund-txid"],
    }));
    await reattachPendingRefunds(packages, bundle, [CPFP_UTXO], 5, "REGTEST", {
      ...baseDeps(),
      refundForLeaf,
    });
    expect(packages[0]!.txPackages).toEqual([{ tx: "node", feeBumpPsbt: "p" }]);
    expect(refundForLeaf).not.toHaveBeenCalled();
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
