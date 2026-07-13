import type { OptimizeLeavesStep, SparkWalletLike } from "../../src/types.ts";

export interface FakeSparkWallet extends SparkWalletLike {
  optimizeCalls: number;
  multiplicities: number[];
  cleaned: boolean;
}

/**
 * Shared fake for consolidation-capable Spark wallets. getLeaves serves
 * leafSets[i] where i is how many optimizeLeaves passes have run, so each
 * optimize call "advances" the wallet to the next leaf set; the last set
 * repeats once exhausted. Tests can override or delete individual methods.
 */
export function fakeSparkWallet({
  leafSets,
}: {
  leafSets: number[][];
}): FakeSparkWallet {
  let index = 0;
  const currentValues = () =>
    leafSets[Math.min(index, leafSets.length - 1)] ?? [];
  return {
    optimizeCalls: 0,
    multiplicities: [],
    cleaned: false,
    async experimental_syncWallet() {},
    async getLeaves() {
      return currentValues().map((value, i) => ({
        id: `leaf-${index}-${i}`,
        status: "AVAILABLE",
        value,
        encoded: "aa",
      }));
    },
    async *optimizeLeaves(
      multiplicity?: number,
    ): AsyncGenerator<OptimizeLeavesStep, void, void> {
      this.optimizeCalls += 1;
      this.multiplicities.push(multiplicity ?? -1);
      index += 1;
      yield { step: 1, total: 2 };
      yield { step: 2, total: 2 };
    },
    async cleanup() {
      this.cleaned = true;
    },
  };
}
