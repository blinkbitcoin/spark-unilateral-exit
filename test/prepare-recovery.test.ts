import { describe, expect, it } from "vitest";

import { prepareRecovery } from "../src/prepare-recovery.ts";
import type { OptimizeLeavesStep, SparkWalletLike } from "../src/types.ts";

describe("prepareRecovery", () => {
  it("consolidates leaves and exports a fresh bundle when operators are reachable", async () => {
    const wallet = fakeWallet({
      leafSets: [
        [10, 10, 10, 10, 10],
        [2, 16, 32],
      ],
    });

    const result = await prepareRecovery({
      seed: "test seed",
      network: "regtest",
      operatorSet: "test-operators",
      appVersion: "test",
      walletFactory: async () => ({ wallet }),
      encodeTreeNode: (leaf) => String(leaf.encoded),
      leafPollAttempts: 1,
      leafPollDelayMs: 0,
    });

    expect(result.refreshed).toBe(true);
    expect(result.consolidated).toBe(true);
    expect(wallet.optimizeCalls).toBe(1);
    expect(result.bundle?.network).toBe("REGTEST");
    expect(result.bundle?.operatorSet).toBe("test-operators");
    // The exported bundle reflects the post-consolidation leaf set.
    expect(result.bundle?.leaves.map((l) => l.valueSats)).toEqual([2, 16, 32]);
    expect(result.notes).toEqual([
      "Consolidated 5 leaves into 3 before the exit",
    ]);
    expect(wallet.cleaned).toBe(true);
  });

  it("falls back to the saved bundle when the operators are unreachable", async () => {
    const result = await prepareRecovery({
      seed: "test seed",
      network: "mainnet",
      walletFactory: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result).toMatchObject({
      bundle: null,
      refreshed: false,
      consolidated: false,
    });
    expect(result.notes[0]).toMatch(/operators unreachable.*connection refused/);
    expect(result.notes[0]).toMatch(/saved recovery bundle/);
  });

  it("times out a hanging wallet initialization and cleans up late wallets", async () => {
    const wallet = fakeWallet({ leafSets: [[10]] });
    const result = await prepareRecovery({
      seed: "test seed",
      network: "mainnet",
      timeoutMs: 20,
      walletFactory: () =>
        new Promise((resolve) => setTimeout(() => resolve({ wallet }), 60)),
    });

    expect(result.bundle).toBeNull();
    expect(result.notes[0]).toMatch(/timed out/);
    // The initialization that outlived the timeout still gets cleaned up.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(wallet.cleaned).toBe(true);
  });

  it("still refreshes the bundle when consolidation fails (SSP offline)", async () => {
    const wallet = fakeWallet({ leafSets: [[10, 10, 10]] });
    wallet.optimizeLeaves = async function* (): AsyncGenerator<
      OptimizeLeavesStep,
      void,
      void
    > {
      throw new Error("SSP unavailable");
    };

    const result = await prepareRecovery({
      seed: "test seed",
      network: "regtest",
      walletFactory: async () => ({ wallet }),
      encodeTreeNode: (leaf) => String(leaf.encoded),
      leafPollAttempts: 1,
      leafPollDelayMs: 0,
    });

    expect(result.refreshed).toBe(true);
    expect(result.consolidated).toBe(false);
    expect(result.bundle?.leaves.map((l) => l.valueSats)).toEqual([10, 10, 10]);
    expect(result.notes[0]).toMatch(/consolidation skipped.*SSP unavailable/i);
    expect(result.notes[0]).toMatch(/current leaf set/);
    expect(wallet.cleaned).toBe(true);
  });

  it("skips consolidation when disabled but still refreshes", async () => {
    const wallet = fakeWallet({ leafSets: [[10, 10, 10]] });

    const result = await prepareRecovery({
      seed: "test seed",
      network: "regtest",
      consolidate: false,
      walletFactory: async () => ({ wallet }),
      encodeTreeNode: (leaf) => String(leaf.encoded),
      leafPollAttempts: 1,
      leafPollDelayMs: 0,
    });

    expect(wallet.optimizeCalls).toBe(0);
    expect(result.consolidated).toBe(false);
    expect(result.refreshed).toBe(true);
    expect(result.notes[0]).toMatch(/--no-consolidate/);
  });

  it("degrades to the saved bundle when the wallet has no leaves", async () => {
    const wallet = fakeWallet({ leafSets: [[]] });

    const result = await prepareRecovery({
      seed: "test seed",
      network: "regtest",
      walletFactory: async () => ({ wallet }),
      leafPollAttempts: 1,
      leafPollDelayMs: 0,
    });

    expect(result.bundle).toBeNull();
    expect(result.refreshed).toBe(false);
    expect(result.notes.some((n) => /consolidation skipped/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /Bundle refresh failed/.test(n))).toBe(true);
    expect(wallet.cleaned).toBe(true);
  });
});

function fakeWallet({ leafSets }: { leafSets: number[][] }): SparkWalletLike & {
  optimizeCalls: number;
  cleaned: boolean;
} {
  // Serves leafSets[i] where i is how many optimize passes have run.
  let index = 0;
  return {
    optimizeCalls: 0,
    cleaned: false,
    async experimental_syncWallet() {},
    async getLeaves() {
      const values = leafSets[Math.min(index, leafSets.length - 1)] ?? [];
      return values.map((value, i) => ({
        id: `leaf-${index}-${i}`,
        status: "AVAILABLE",
        value,
        encoded: "aa",
      }));
    },
    async getIdentityPublicKey() {
      return "identity";
    },
    async getBalance() {
      return { satsBalance: { owned: 0n }, tokenBalances: new Map() };
    },
    async *optimizeLeaves(): AsyncGenerator<OptimizeLeavesStep, void, void> {
      this.optimizeCalls += 1;
      index += 1;
      yield { step: 1, total: 1 };
    },
    async cleanup() {
      this.cleaned = true;
    },
  };
}
