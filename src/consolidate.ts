// Leaf consolidation ("optimization") via the Spark SDK.
//
// A Spark balance is held as a set of leaves, and every leaf costs its own
// CPFP + sweep fees to exit unilaterally. Many small leaves therefore make a
// recovery expensive or outright uneconomical. The SDK's
// `SparkWallet.optimizeLeaves(multiplicity)` swaps leaves with the SSP:
// multiplicity 0 targets the unilateral-exit-maximizing set (the greedy
// power-of-two decomposition of the balance, i.e. the fewest leaves), while
// multiplicity 1-5 targets a transfer-friendly denomination ladder.
//
// This module plans that consolidation locally (mirroring the SDK's target
// math) so the effect can be inspected with --dry-run, and executes it by
// draining the SDK generator round by round until the leaf set converges.

import {
  defaultWalletFactory,
  normalizeAccountNumber,
  normalizeNetwork,
  pollLeaves,
} from "./recovery-bundle.ts";
import type {
  AccountNumberInput,
  SparkLeaf,
  SparkWalletLike,
  WalletFactoryParams,
} from "./types.ts";

// Mirrors the SDK's denomination table (packages/js-sdk src/utils/optimize.ts):
// powers of two from 1 sat to 2^27 sats.
const DENOMINATIONS: number[] = Array.from({ length: 28 }, (_, i) => 2 ** i);

type WalletFactory = (params: WalletFactoryParams) => Promise<any>;

export class ConsolidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolidateError";
  }
}

/**
 * The fewest-leaves decomposition of `totalSats` into power-of-two
 * denominations. This is the target set the SDK's multiplicity-0 optimization
 * (maximizeUnilateralExit) converges to.
 */
export function greedyDenominations(totalSats: number): number[] {
  assertSafeAmount(totalSats);
  const leaves: number[] = [];
  let remaining = totalSats;
  for (let i = DENOMINATIONS.length - 1; i >= 0; i -= 1) {
    const denomination = DENOMINATIONS[i]!;
    while (remaining >= denomination) {
      remaining -= denomination;
      leaves.push(denomination);
    }
  }
  return leaves.sort((a, b) => a - b);
}

/**
 * The swap-minimizing decomposition the SDK targets for multiplicity >= 1:
 * up to `multiplicity` copies of each denomination from the smallest up,
 * with the remainder decomposed greedily.
 */
export function swapMinimizingDenominations(
  totalSats: number,
  multiplicity: number,
): number[] {
  assertSafeAmount(totalSats);
  const leaves: number[] = [];
  let remaining = totalSats;
  for (const denomination of DENOMINATIONS) {
    for (let i = 0; i < multiplicity; i += 1) {
      if (remaining >= denomination) {
        remaining -= denomination;
        leaves.push(denomination);
      }
    }
  }
  leaves.push(...greedyDenominations(remaining));
  return leaves.sort((a, b) => a - b);
}

export interface ConsolidationPlan {
  totalSats: number;
  currentLeafCount: number;
  currentValues: number[];
  targetLeafCount: number;
  targetValues: number[];
  needsSwap: boolean;
}

export function planLeafConsolidation(
  values: number[],
  multiplicity = 0,
): ConsolidationPlan {
  validateMultiplicity(multiplicity);
  const currentValues = [...values].sort((a, b) => a - b);
  const totalSats = currentValues.reduce((sum, value) => sum + value, 0);
  assertSafeAmount(totalSats);
  const targetValues =
    multiplicity === 0
      ? greedyDenominations(totalSats)
      : swapMinimizingDenominations(totalSats, multiplicity);
  return {
    totalSats,
    currentLeafCount: currentValues.length,
    currentValues,
    targetLeafCount: targetValues.length,
    targetValues,
    needsSwap:
      currentValues.length !== targetValues.length ||
      currentValues.some((value, index) => value !== targetValues[index]),
  };
}

export interface ConsolidateLeavesOptions {
  seed?: string;
  accountNumber?: AccountNumberInput;
  network?: string;
  multiplicity?: number;
  dryRun?: boolean;
  /**
   * The SDK batches at most 64 leaves per swap, so one optimizeLeaves pass may
   * not reach the target set; rounds bound how many passes we drive.
   */
  maxRounds?: number;
  walletFactory?: WalletFactory;
  onEvent?: (message: string) => void;
  cleanupWallet?: boolean;
  leafPollAttempts?: number;
  leafPollDelayMs?: number;
}

export interface LeafSetSummary {
  leafCount: number;
  totalSats: number;
  values: number[];
}

export interface ConsolidateResult {
  network: string;
  multiplicity: number;
  dryRun: boolean;
  executed: boolean;
  rounds: number;
  converged: boolean;
  before: LeafSetSummary;
  target: LeafSetSummary;
  after?: LeafSetSummary;
  /** Consolidation spends the old leaves: any saved recovery bundle is stale. */
  bundleRefreshRequired: boolean;
}

export async function consolidateLeavesFromSeed({
  seed,
  accountNumber,
  network = "MAINNET",
  multiplicity = 0,
  dryRun = false,
  maxRounds = 5,
  walletFactory = defaultWalletFactory,
  onEvent = () => {},
  cleanupWallet = true,
  leafPollAttempts = 6,
  leafPollDelayMs = 2_000,
}: ConsolidateLeavesOptions = {}): Promise<ConsolidateResult> {
  if (typeof seed !== "string" || seed.trim().length === 0) {
    throw new ConsolidateError("Spark seed or mnemonic is required");
  }
  validateMultiplicity(multiplicity);
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new ConsolidateError("maxRounds must be a positive integer");
  }

  const normalizedNetwork = normalizeNetwork(network);
  const walletResponse = await walletFactory({
    seed,
    accountNumber: normalizeAccountNumber(accountNumber),
    network: normalizedNetwork,
  });
  const wallet: SparkWalletLike = walletResponse?.wallet ?? walletResponse;
  if (!wallet) {
    throw new ConsolidateError("Spark wallet initialization returned no wallet");
  }

  try {
    const beforeLeaves = await pollLeaves({
      wallet,
      attempts: leafPollAttempts,
      delayMs: leafPollDelayMs,
    });
    if (!Array.isArray(beforeLeaves) || beforeLeaves.length === 0) {
      throw new ConsolidateError("Spark wallet has no leaves to consolidate");
    }

    const before = summarizeLeaves(beforeLeaves);
    let plan = planLeafConsolidation(before.values, multiplicity);
    const target: LeafSetSummary = {
      leafCount: plan.targetLeafCount,
      totalSats: plan.totalSats,
      values: plan.targetValues,
    };
    onEvent(
      `Current leaves: ${plan.currentLeafCount} (${plan.totalSats} sats); ` +
        `optimal for unilateral exit: ${plan.targetLeafCount}`,
    );

    if (!plan.needsSwap) {
      onEvent("Leaves already match the optimal denomination set; nothing to do");
      return {
        network: normalizedNetwork,
        multiplicity,
        dryRun,
        executed: false,
        rounds: 0,
        converged: true,
        before,
        target,
        after: before,
        bundleRefreshRequired: false,
      };
    }

    if (dryRun) {
      onEvent(
        `Dry run: would consolidate ${plan.currentLeafCount} leaves into ` +
          `${plan.targetLeafCount} via SSP swaps`,
      );
      return {
        network: normalizedNetwork,
        multiplicity,
        dryRun,
        executed: false,
        rounds: 0,
        converged: false,
        before,
        target,
        bundleRefreshRequired: false,
      };
    }

    if (typeof wallet.optimizeLeaves !== "function") {
      throw new ConsolidateError(
        "This Spark wallet does not expose optimizeLeaves(); upgrade @buildonspark/spark-sdk",
      );
    }

    let rounds = 0;
    let after = before;
    while (plan.needsSwap && rounds < maxRounds) {
      rounds += 1;
      onEvent(`Consolidation round ${rounds}/${maxRounds}: requesting SSP swaps`);
      for await (const step of wallet.optimizeLeaves(multiplicity)) {
        if (step.total > 0) {
          onEvent(`Round ${rounds}: swap ${step.step} of ${step.total}`);
        }
      }
      const leaves = await pollLeaves({
        wallet,
        attempts: leafPollAttempts,
        delayMs: leafPollDelayMs,
      });
      after = summarizeLeaves(leaves);
      if (after.totalSats !== before.totalSats) {
        throw new ConsolidateError(
          `Balance changed during consolidation (before ${before.totalSats} sats, ` +
            `after ${after.totalSats} sats); wallet may have concurrent activity - ` +
            "re-run once transfers settle",
        );
      }
      plan = planLeafConsolidation(after.values, multiplicity);
      onEvent(
        `Round ${rounds} complete: ${after.leafCount} leaves` +
          (plan.needsSwap ? " (further swaps possible)" : " (optimal)"),
      );
    }

    return {
      network: normalizedNetwork,
      multiplicity,
      dryRun,
      executed: rounds > 0,
      rounds,
      converged: !plan.needsSwap,
      before,
      target,
      after,
      bundleRefreshRequired: rounds > 0,
    };
  } finally {
    if (cleanupWallet) await wallet.cleanup?.();
  }
}

function summarizeLeaves(leaves: SparkLeaf[]): LeafSetSummary {
  const values = leaves
    .map((leaf) => {
      const value = Number(leaf.value ?? leaf.valueSats ?? 0);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ConsolidateError(
          `Spark leaf ${String(leaf.id ?? "?")} has an invalid value: ${String(
            leaf.value ?? leaf.valueSats,
          )}`,
        );
      }
      return value;
    })
    .sort((a, b) => a - b);
  return {
    leafCount: values.length,
    totalSats: values.reduce((sum, value) => sum + value, 0),
    values,
  };
}

function validateMultiplicity(multiplicity: number): void {
  if (!Number.isSafeInteger(multiplicity) || multiplicity < 0 || multiplicity > 5) {
    throw new ConsolidateError(
      "--multiplicity must be an integer between 0 (fewest leaves, best for unilateral exit) and 5",
    );
  }
}

function assertSafeAmount(totalSats: number): void {
  if (!Number.isSafeInteger(totalSats) || totalSats < 0) {
    throw new ConsolidateError(`Invalid sats amount: ${totalSats}`);
  }
}
