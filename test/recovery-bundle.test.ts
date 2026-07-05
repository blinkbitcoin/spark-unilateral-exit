import { describe, expect, it } from "vitest";

import {
  RecoveryBundleExportError,
  exportRecoveryBundleFromSeed,
  exportRecoveryBundleFromWallet,
} from "../src/recovery-bundle.ts";
import type { SparkWalletLike } from "../src/types.ts";

describe("recovery bundle export", () => {
  it("exports live wallet leaves into the recovery bundle schema", async () => {
    const wallet = fakeWallet({
      leaves: [
        { id: "leaf-a", status: "AVAILABLE", value: 1000n, encoded: "aa" },
        { id: "leaf-b", status: "AVAILABLE", value: 2000n, encoded: "bb" },
      ],
    });

    const bundle = await exportRecoveryBundleFromWallet({
      wallet,
      network: "local",
      operatorSet: "local-docker-compose",
      appVersion: "test",
      now: () => new Date("2026-06-15T00:00:00.000Z"),
      encodeTreeNode: (leaf) => leaf.encoded,
    });

    expect(bundle).toMatchObject({
      schema: "spark.unilateral-exit-bundle.v1",
      createdAt: "2026-06-15T00:00:00.000Z",
      network: "LOCAL",
      operatorSet: "local-docker-compose",
      walletIdentityPublicKey: "identity",
      appVersion: "test",
      balances: {
        btcSats: "3000",
        usdb: {
          amount: "0",
          status: "not-covered-by-bitcoin-unilateral-exit",
        },
      },
    });
    expect(bundle.leaves).toEqual([
      {
        id: "leaf-a",
        status: "AVAILABLE",
        valueSats: 1000,
        treeNodeHex: "aa",
      },
      {
        id: "leaf-b",
        status: "AVAILABLE",
        valueSats: 2000,
        treeNodeHex: "bb",
      },
    ]);
    expect(wallet.synced).toBe(true);
  });

  it("initializes from seed, exports, and cleans up the wallet", async () => {
    const wallet = fakeWallet({
      leaves: [{ id: "leaf", value: 1n, encoded: "aa" }],
    });

    const bundle = await exportRecoveryBundleFromSeed({
      seed: "test seed",
      accountNumber: 7,
      network: "regtest",
      walletFactory: async (params) => {
        expect(params).toEqual({
          seed: "test seed",
          accountNumber: 7,
          network: "REGTEST",
        });
        return { wallet };
      },
      encodeTreeNode: (leaf) => leaf.encoded,
    });

    expect(bundle.network).toBe("REGTEST");
    expect(wallet.cleaned).toBe(true);
  });

  it("can leave an injected live wallet open after seed export", async () => {
    const wallet = fakeWallet({
      leaves: [{ id: "leaf", value: 1n, encoded: "aa" }],
    });

    await exportRecoveryBundleFromSeed({
      seed: "test seed",
      cleanupWallet: false,
      walletFactory: async () => ({ wallet }),
      encodeTreeNode: (leaf) => leaf.encoded,
    });

    expect(wallet.cleaned).toBe(false);
  });

  it("rejects empty live leaf sets", async () => {
    await expect(
      exportRecoveryBundleFromWallet({ wallet: fakeWallet({ leaves: [] }) }),
    ).rejects.toThrow(RecoveryBundleExportError);
  });

  it("polls while live leaves are still syncing", async () => {
    const wallet = fakeWallet({
      leaves: [[], [{ id: "leaf", value: 1n, encoded: "aa" }]],
    });

    const bundle = await exportRecoveryBundleFromWallet({
      wallet,
      leafPollAttempts: 2,
      encodeTreeNode: (leaf) => leaf.encoded,
    });

    expect(bundle.leaves).toHaveLength(1);
    expect(wallet.reads).toBe(2);
  });

  it("rejects missing seed input", async () => {
    await expect(exportRecoveryBundleFromSeed()).rejects.toThrow(/required/);
  });
});

function fakeWallet({ leaves }: { leaves: any[] }): SparkWalletLike & {
  synced: boolean;
  cleaned: boolean;
  reads: number;
} {
  return {
    synced: false,
    cleaned: false,
    reads: 0,
    async experimental_syncWallet() {
      this.synced = true;
    },
    async getLeaves() {
      this.reads += 1;
      if (Array.isArray(leaves[0])) {
        return leaves.shift() ?? [];
      }
      return leaves;
    },
    async getIdentityPublicKey() {
      return "identity";
    },
    async getBalance() {
      return {
        satsBalance: {
          owned: leaves.reduce((sum, leaf) => sum + BigInt(leaf.value ?? 0n), 0n),
        },
        tokenBalances: new Map(),
      };
    },
    async cleanup() {
      this.cleaned = true;
    },
  };
}
