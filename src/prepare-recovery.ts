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
// Consolidation drives SSP swaps through an SDK wallet session; the bundle
// export talks to the operators directly from the seed (src/operator/) and
// needs no wallet at all.

import { consolidateLeaves } from "./consolidate.ts";
import {
  exportRecoveryBundleFromSeed,
  normalizeAccountNumber,
  normalizeNetwork,
} from "./recovery-bundle.ts";
import { defaultWalletFactory, unwrapWallet } from "./spark-wallet.ts";
import type {
  AccountNumberInput,
  RecoveryBundle,
  SparkWalletLike,
  WalletFactoryParams,
} from "./types.ts";

type WalletFactory = (params: WalletFactoryParams) => Promise<any>;
type ExportBundle = (
  options: Parameters<typeof exportRecoveryBundleFromSeed>[0],
) => Promise<RecoveryBundle>;

export interface PrepareRecoveryOptions {
  seed: string;
  network: string;
  accountNumber?: AccountNumberInput;
  /** Attempt the exit-optimal (multiplicity 0) leaf consolidation first. */
  consolidate?: boolean;
  multiplicity?: number;
  operatorSet?: string;
  appVersion?: string;
  /** Spark coordinator base URL for the bundle export. */
  coordinatorUrl?: string;
  /**
   * Bounds the wallet initialization and the bundle export, each falling back
   * to the saved bundle with a note. The consolidation swaps are deliberately
   * NOT time-bounded: abandoning an in-flight SSP swap would let the leaf set
   * keep changing underneath the exit that follows. If consolidation wedges,
   * interrupt the run and retry with consolidation disabled.
   */
  timeoutMs?: number;
  walletFactory?: WalletFactory;
  /** Injection seam for tests; defaults to the operator-client exporter. */
  exportBundle?: ExportBundle;
  onEvent?: (message: string) => void;
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
  coordinatorUrl,
  timeoutMs = 120_000,
  walletFactory = defaultWalletFactory,
  exportBundle = exportRecoveryBundleFromSeed,
  onEvent = () => {},
  leafPollAttempts = 6,
  leafPollDelayMs = 2_000,
}: PrepareRecoveryOptions): Promise<PrepareRecoveryResult> {
  const notes: string[] = [];
  const normalizedNetwork = normalizeNetwork(network);

  let consolidated = false;
  if (consolidate) {
    consolidated = await runConsolidation({
      seed,
      accountNumber,
      network: normalizedNetwork,
      multiplicity,
      timeoutMs,
      walletFactory,
      onEvent,
      leafPollAttempts,
      leafPollDelayMs,
      notes,
    });
  } else {
    notes.push("Leaf consolidation skipped (--no-consolidate)");
  }

  onEvent("Refreshing the recovery bundle from the Spark operators...");
  // After a consolidation the swapped leaves may take a moment to become
  // AVAILABLE on the operators, and a failed refresh at this point is the one
  // state where "proceed with the saved bundle" is dangerous (its leaves were
  // just spent) - so retry the export through the settling window. Without a
  // consolidation the saved bundle is still valid and one attempt suffices.
  const exportAttempts = consolidated ? Math.max(1, leafPollAttempts) : 1;
  try {
    // Read-only, so safe to abandon on timeout (unlike the swaps above).
    const bundle = await withTimeout(
      (async () => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await exportBundle({
              seed,
              accountNumber,
              network: normalizedNetwork,
              ...(operatorSet ? { operatorSet } : {}),
              ...(appVersion ? { appVersion } : {}),
              ...(coordinatorUrl ? { coordinatorUrl } : {}),
            });
          } catch (error) {
            if (attempt >= exportAttempts) throw error;
            onEvent(
              `Bundle refresh attempt ${attempt} failed (${(error as Error).message}); retrying...`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, leafPollDelayMs));
          }
        }
      })(),
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
}

async function runConsolidation({
  seed,
  accountNumber,
  network,
  multiplicity,
  timeoutMs,
  walletFactory,
  onEvent,
  leafPollAttempts,
  leafPollDelayMs,
  notes,
}: {
  seed: string;
  accountNumber: AccountNumberInput;
  network: string;
  multiplicity: number;
  timeoutMs: number;
  walletFactory: WalletFactory;
  onEvent: (message: string) => void;
  leafPollAttempts: number;
  leafPollDelayMs: number;
  notes: string[];
}): Promise<boolean> {
  onEvent("Checking whether Spark operators are reachable to consolidate leaves...");
  let wallet: SparkWalletLike;
  const walletPromise = walletFactory({
    seed,
    accountNumber: normalizeAccountNumber(accountNumber),
    network,
  });
  try {
    const unwrapped = unwrapWallet(
      await withTimeout(walletPromise, timeoutMs, "Spark wallet initialization"),
    );
    if (!unwrapped) throw new Error("wallet initialization returned no wallet");
    wallet = unwrapped;
  } catch (error) {
    // Best-effort: if the initialization outlives the timeout, close the late
    // wallet once it resolves. There is no guarantee - a cleanup that itself
    // hangs or throws leaves its connections open until process exit, which
    // is acceptable for a CLI run that is about to proceed offline anyway.
    void walletPromise
      .then((response) => unwrapWallet(response)?.cleanup?.())
      .catch(() => {});
    notes.push(
      `Leaf consolidation skipped (${(error as Error).message}); ` +
        "exiting with the current leaf set",
    );
    return false;
  }

  try {
    const result = await consolidateLeaves({
      wallet,
      network,
      multiplicity,
      onEvent,
      leafPollAttempts,
      leafPollDelayMs,
    });
    if (result.executed) {
      notes.push(
        `Consolidated ${result.before.leafCount} leaves into ` +
          `${result.after?.leafCount} before the exit` +
          (result.converged ? "" : " (partially; further swaps were possible)"),
      );
    }
    return result.executed;
  } catch (error) {
    notes.push(
      `Leaf consolidation skipped (${(error as Error).message}); ` +
        "exiting with the current leaf set",
    );
    return false;
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
