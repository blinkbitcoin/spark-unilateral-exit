// Best-effort preparation before an automated unilateral exit.
//
// While the Spark operators are still reachable, a recovery gets strictly
// better by doing two cooperative steps first: consolidate the leaves into
// the exit-optimal denomination set (fewer, larger leaves mean fewer
// uneconomical exits) and export a fresh recovery bundle that reflects the
// post-swap leaves. Both steps are opportunistic: a unilateral exit exists
// precisely for the case where operators are gone, so every failure here
// degrades to "proceed with the saved bundle" with a note instead of
// aborting the recovery.
//
// One wallet session serves both steps so a consolidation is always followed
// by an export of the leaves it produced.

import { consolidateLeaves } from "./consolidate.ts";
import {
  defaultWalletFactory,
  exportRecoveryBundleFromWallet,
  normalizeAccountNumber,
  normalizeNetwork,
} from "./recovery-bundle.ts";
import type {
  AccountNumberInput,
  RecoveryBundle,
  SparkLeaf,
  SparkWalletLike,
  WalletFactoryParams,
} from "./types.ts";

type WalletFactory = (params: WalletFactoryParams) => Promise<any>;
type EncodeTreeNode = (leaf: SparkLeaf) => string;

export interface PrepareRecoveryOptions {
  seed: string;
  network: string;
  accountNumber?: AccountNumberInput;
  /** Attempt the exit-optimal (multiplicity 0) leaf consolidation first. */
  consolidate?: boolean;
  multiplicity?: number;
  operatorSet?: string;
  appVersion?: string;
  /**
   * Bounds the wallet initialization and the bundle export, each falling back
   * to the saved bundle with a note. The consolidation swaps are deliberately
   * NOT time-bounded: abandoning an in-flight SSP swap would let the leaf set
   * keep changing underneath the exit that follows. If consolidation wedges,
   * interrupt the run and retry with consolidation disabled.
   */
  timeoutMs?: number;
  walletFactory?: WalletFactory;
  onEvent?: (message: string) => void;
  encodeTreeNode?: EncodeTreeNode;
  leafPollAttempts?: number;
  leafPollDelayMs?: number;
}

export interface PrepareRecoveryResult {
  /** Freshly exported bundle, or null when the saved bundle must be used. */
  bundle: RecoveryBundle | null;
  refreshed: boolean;
  consolidated: boolean;
  /** Deviations from the ideal path, meant for the user-facing summary. */
  notes: string[];
}

export async function prepareRecovery({
  seed,
  network,
  accountNumber,
  consolidate = true,
  multiplicity = 0,
  operatorSet,
  appVersion,
  timeoutMs = 120_000,
  walletFactory = defaultWalletFactory,
  onEvent = () => {},
  encodeTreeNode,
  leafPollAttempts = 6,
  leafPollDelayMs = 2_000,
}: PrepareRecoveryOptions): Promise<PrepareRecoveryResult> {
  const notes: string[] = [];
  const normalizedNetwork = normalizeNetwork(network);

  onEvent("Checking whether Spark operators are reachable to refresh the bundle...");
  let wallet: SparkWalletLike;
  const walletPromise = walletFactory({
    seed,
    accountNumber: normalizeAccountNumber(accountNumber),
    network: normalizedNetwork,
  });
  try {
    const walletResponse = await withTimeout(
      walletPromise,
      timeoutMs,
      "Spark wallet initialization",
    );
    wallet = walletResponse?.wallet ?? walletResponse;
    if (!wallet) throw new Error("wallet initialization returned no wallet");
  } catch (error) {
    // Best-effort: if the initialization outlives the timeout, close the late
    // wallet once it resolves. There is no guarantee - a cleanup that itself
    // hangs or throws leaves its connections open until process exit, which
    // is acceptable for a CLI run that is about to proceed offline anyway.
    void walletPromise
      .then((response) => (response?.wallet ?? response)?.cleanup?.())
      .catch(() => {});
    notes.push(
      `Spark operators unreachable (${(error as Error).message}); ` +
        "proceeding with the saved recovery bundle",
    );
    return { bundle: null, refreshed: false, consolidated: false, notes };
  }

  try {
    let consolidated = false;
    if (consolidate) {
      try {
        const result = await consolidateLeaves({
          wallet,
          network: normalizedNetwork,
          multiplicity,
          onEvent,
          leafPollAttempts,
          leafPollDelayMs,
        });
        consolidated = result.executed;
        if (result.executed) {
          notes.push(
            `Consolidated ${result.before.leafCount} leaves into ` +
              `${result.after?.leafCount} before the exit` +
              (result.converged ? "" : " (partially; further swaps were possible)"),
          );
        }
      } catch (error) {
        notes.push(
          `Leaf consolidation skipped (${(error as Error).message}); ` +
            "exiting with the current leaf set",
        );
      }
    } else {
      notes.push("Leaf consolidation skipped (--no-consolidate)");
    }

    try {
      // Read-only, so safe to abandon on timeout (unlike the swaps above).
      const bundle = await withTimeout(
        exportRecoveryBundleFromWallet({
          wallet,
          network: normalizedNetwork,
          ...(operatorSet ? { operatorSet } : {}),
          ...(appVersion ? { appVersion } : {}),
          ...(encodeTreeNode ? { encodeTreeNode } : {}),
          leafPollAttempts,
          leafPollDelayMs,
        }),
        timeoutMs,
        "Bundle refresh",
      );
      onEvent(
        `Refreshed recovery bundle from live leaves (${bundle.leaves.length} leaf/leaves)`,
      );
      return { bundle, refreshed: true, consolidated, notes };
    } catch (error) {
      notes.push(
        `Bundle refresh failed (${(error as Error).message}); ` +
          "proceeding with the saved recovery bundle",
      );
      return { bundle: null, refreshed: false, consolidated, notes };
    }
  } finally {
    await wallet.cleanup?.();
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
