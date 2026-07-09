import { describe, expect, it } from "vitest";

import {
  ConsolidateError,
  consolidateLeavesFromSeed,
  greedyDenominations,
  planLeafConsolidation,
  swapMinimizingDenominations,
} from "../src/consolidate.ts";
import type { SparkWalletLike } from "../src/types.ts";
import { fakeSparkWallet as fakeWallet } from "./helpers/fake-spark-wallet.ts";

describe("consolidation planning", () => {
  it("decomposes an amount into the fewest power-of-two denominations", () => {
    expect(greedyDenominations(0)).toEqual([]);
    expect(greedyDenominations(1)).toEqual([1]);
    expect(greedyDenominations(7)).toEqual([1, 2, 4]);
    expect(greedyDenominations(1024)).toEqual([1024]);
    // Above the largest denomination (2^27) it repeats the largest leaf.
    expect(greedyDenominations(2 ** 27 * 3)).toEqual([2 ** 27, 2 ** 27, 2 ** 27]);
  });

  it("keeps extra small denominations for multiplicity >= 1", () => {
    // multiplicity 1 over 7 sats is the same set...
    expect(swapMinimizingDenominations(7, 1)).toEqual([1, 2, 4]);
    // ...but larger balances keep one leaf of every denomination that fits,
    // with the remainder decomposed greedily (the extra 1-sat leaf here).
    expect(swapMinimizingDenominations(1024, 1)).toEqual([
      1, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
    ]);
    expect(swapMinimizingDenominations(1024, 1).reduce((a, b) => a + b, 0)).toBe(
      1024,
    );
  });

  it("plans a consolidation that preserves total value", () => {
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]; // 100 sats
    const plan = planLeafConsolidation(values);
    expect(plan.totalSats).toBe(100);
    expect(plan.currentLeafCount).toBe(10);
    expect(plan.targetValues).toEqual([4, 32, 64]);
    expect(plan.targetLeafCount).toBe(3);
    expect(plan.needsSwap).toBe(true);
  });

  it("recognizes an already-optimal leaf set", () => {
    const plan = planLeafConsolidation([4, 32, 64]);
    expect(plan.needsSwap).toBe(false);
  });

  it("rejects invalid multiplicity", () => {
    expect(() => planLeafConsolidation([1], -1)).toThrow(ConsolidateError);
    expect(() => planLeafConsolidation([1], 6)).toThrow(ConsolidateError);
    expect(() => planLeafConsolidation([1], 1.5)).toThrow(ConsolidateError);
  });
});

describe("consolidateLeavesFromSeed", () => {
  it("reports the plan without swapping on --dry-run", async () => {
    const wallet = fakeWallet({ leafSets: [[10, 10, 10, 10, 10]] });

    const result = await consolidateLeavesFromSeed({
      seed: "test seed",
      network: "regtest",
      dryRun: true,
      walletFactory: async (params) => {
        // accountNumber stays undefined so the SDK picks its network default
        // (0 on regtest, 1 on mainnet) - the same identity the bundle tool uses.
        expect(params).toEqual({
          seed: "test seed",
          accountNumber: undefined,
          network: "REGTEST",
        });
        return { wallet };
      },
    });

    expect(result).toMatchObject({
      network: "REGTEST",
      multiplicity: 0,
      dryRun: true,
      executed: false,
      rounds: 0,
      bundleRefreshRequired: false,
      before: { leafCount: 5, totalSats: 50 },
      target: { leafCount: 3, values: [2, 16, 32] },
    });
    expect(result.after).toBeUndefined();
    expect(wallet.optimizeCalls).toBe(0);
    expect(wallet.cleaned).toBe(true);
  });

  it("drains optimizeLeaves and reports the consolidated leaf set", async () => {
    const wallet = fakeWallet({
      leafSets: [
        [10, 10, 10, 10, 10],
        [2, 16, 32],
      ],
    });
    const events: string[] = [];

    const result = await consolidateLeavesFromSeed({
      seed: "test seed",
      walletFactory: async () => ({ wallet }),
      onEvent: (message) => events.push(message),
    });

    expect(wallet.optimizeCalls).toBe(1);
    expect(wallet.multiplicities).toEqual([0]);
    expect(result).toMatchObject({
      executed: true,
      rounds: 1,
      converged: true,
      bundleRefreshRequired: true,
      before: { leafCount: 5, totalSats: 50 },
      after: { leafCount: 3, totalSats: 50, values: [2, 16, 32] },
    });
    expect(events.some((m) => m.includes("swap 1 of 2"))).toBe(true);
  });

  it("runs additional rounds until the leaf set converges", async () => {
    const wallet = fakeWallet({
      leafSets: [
        [10, 10, 10, 10, 10],
        [10, 40], // first pass only partially consolidated
        [2, 16, 32],
      ],
    });

    const result = await consolidateLeavesFromSeed({
      seed: "test seed",
      walletFactory: async () => ({ wallet }),
    });

    expect(wallet.optimizeCalls).toBe(2);
    expect(result.rounds).toBe(2);
    expect(result.converged).toBe(true);
  });

  it("stops at maxRounds when the SSP never reaches the target", async () => {
    const wallet = fakeWallet({
      leafSets: [
        [10, 10, 10, 10, 10],
        [10, 40],
        [10, 40],
        [10, 40],
      ],
    });

    const result = await consolidateLeavesFromSeed({
      seed: "test seed",
      maxRounds: 2,
      walletFactory: async () => ({ wallet }),
    });

    expect(result.rounds).toBe(2);
    expect(result.converged).toBe(false);
    expect(result.bundleRefreshRequired).toBe(true);
  });

  it("does nothing when leaves already match the optimal set", async () => {
    const wallet = fakeWallet({ leafSets: [[2, 16, 32]] });

    const result = await consolidateLeavesFromSeed({
      seed: "test seed",
      walletFactory: async () => ({ wallet }),
    });

    expect(result).toMatchObject({
      executed: false,
      rounds: 0,
      converged: true,
      bundleRefreshRequired: false,
    });
    expect(wallet.optimizeCalls).toBe(0);
  });

  it("fails when the balance changes mid-consolidation", async () => {
    const wallet = fakeWallet({
      leafSets: [
        [10, 10, 10, 10, 10],
        [2, 16, 31], // 49 sats: one sat vanished
      ],
    });

    await expect(
      consolidateLeavesFromSeed({
        seed: "test seed",
        walletFactory: async () => ({ wallet }),
      }),
    ).rejects.toThrow(/Balance changed/);
    expect(wallet.cleaned).toBe(true);
  });

  it("fails when the wallet lacks optimizeLeaves", async () => {
    const wallet = fakeWallet({ leafSets: [[10, 10, 10]] });
    delete (wallet as Partial<SparkWalletLike>).optimizeLeaves;

    await expect(
      consolidateLeavesFromSeed({
        seed: "test seed",
        walletFactory: async () => ({ wallet }),
      }),
    ).rejects.toThrow(/optimizeLeaves/);
  });

  it("rejects an empty wallet and a blank seed", async () => {
    await expect(
      consolidateLeavesFromSeed({
        seed: "test seed",
        leafPollAttempts: 1,
        leafPollDelayMs: 0,
        walletFactory: async () => ({ wallet: fakeWallet({ leafSets: [[]] }) }),
      }),
    ).rejects.toThrow(/no leaves/);
    // The type requires seed; the runtime guard still covers untyped callers.
    await expect(consolidateLeavesFromSeed({ seed: "  " })).rejects.toThrow(
      /required/,
    );
  });
});

