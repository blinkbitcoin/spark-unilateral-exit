// Spark SDK wallet lifecycle helpers.
//
// The recovery-bundle exporter no longer opens an SDK wallet (it talks to the
// operators directly), but cooperative flows that need a live wallet - leaf
// consolidation and deposit preparation - still initialize one through the
// Spark SDK. This module is the single home for that seam.

import type { SparkLeaf, SparkWalletLike, WalletFactoryParams } from "./types.ts";

interface SparkWalletModule {
  SparkWallet: {
    initialize(config: {
      mnemonicOrSeed: string;
      accountNumber: number | undefined;
      options: {
        network: string;
        optimizationOptions?: { auto?: boolean; multiplicity?: number };
      };
    }): Promise<unknown>;
  };
}

// SparkWallet.initialize resolves to { wallet, ... } while injected factories
// and fakes may return the wallet directly; this is the single place that
// assumption about the SDK's return shape lives.
export function unwrapWallet(walletResponse: any): SparkWalletLike | undefined {
  return (walletResponse?.wallet ?? walletResponse) || undefined;
}

export async function defaultWalletFactory({
  seed,
  accountNumber,
  network,
}: WalletFactoryParams) {
  const { SparkWallet } = (await import(
    "@buildonspark/spark-sdk"
  )) as unknown as SparkWalletModule;
  return SparkWallet.initialize({
    mnemonicOrSeed: seed,
    accountNumber,
    options: {
      network,
      // The SDK defaults to auto:true with multiplicity 1: after any sync or
      // claim it may launch background SSP swaps on its own. That would race
      // leaf-set snapshots with churn and, right after a multiplicity-0
      // consolidation, start re-fragmenting the leaf set toward the
      // transfer-friendly ladder until cleanup() kills it mid-claim. This
      // tool only ever swaps leaves explicitly, so keep the wallet passive.
      optimizationOptions: { auto: false },
    },
  });
}

export async function pollLeaves({
  wallet,
  attempts,
  delayMs,
}: {
  wallet: SparkWalletLike;
  attempts: number;
  delayMs: number;
}): Promise<SparkLeaf[]> {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let leaves: SparkLeaf[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await wallet.experimental_syncWallet?.();
    leaves = await wallet.getLeaves();
    if (Array.isArray(leaves) && leaves.length > 0) return leaves;
    if (attempt < maxAttempts && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return leaves;
}
