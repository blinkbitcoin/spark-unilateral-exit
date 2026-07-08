import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";

import {
  buildFanOutTransaction,
  createFundingWatchLogger,
  deriveCpfpFundingKey,
  estimateCpfpFunding,
  watchCpfpFunding,
} from "./cpfp-funding.ts";
import {
  broadcastTransaction,
  esploraBaseUrl,
  getAddressUtxos,
  getTipHeight,
  getTransaction,
  submitPackage,
} from "./esplora.ts";
import { signPsbt } from "./sign.ts";
import { constructSparkPackages } from "./spark-packages.ts";
import type {
  AccountNumberInput,
  CpfpUtxo,
  EsploraTransaction,
  EsploraUtxo,
  LeafPackage,
  RecoveryBundle,
} from "./types.ts";

export class AutoExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoExitError";
  }
}

export type LeafExitStatus =
  | "exit-broadcast"
  | "waiting-timelock"
  | "pending"
  | "failed"
  | "skipped-uneconomical";

export interface LeafExitState {
  leafId: string;
  status: LeafExitStatus;
  valueSats: string | null;
  feeSats: string;
  netSats: string | null;
  maturityHeight?: number;
  refundTxid?: string;
  lastError?: string;
  failureCount?: number;
}

interface HeightLock {
  blocks: number;
  prevTxidCandidates: string[];
}

export interface AutoExitDeps {
  constructPackages: typeof constructSparkPackages;
  estimateFunding: typeof estimateCpfpFunding;
  watchFunding: typeof watchCpfpFunding;
  fetchUtxos: (address: string, baseUrl: string) => Promise<EsploraUtxo[]>;
  fetchTip: (baseUrl: string) => Promise<number>;
  fetchTx: (txid: string, baseUrl: string) => Promise<EsploraTransaction | null>;
  submitPkg: (txs: string[], baseUrl: string) => Promise<unknown>;
  broadcastTx: (txHex: string, baseUrl: string) => Promise<string>;
  signChild: (psbtHex: string, privateKey: Uint8Array) => string;
  txIdOf: (txHex: string) => string;
  heightLockOf: (txHex: string) => HeightLock | null;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: AutoExitDeps = {
  constructPackages: constructSparkPackages,
  estimateFunding: estimateCpfpFunding,
  watchFunding: watchCpfpFunding,
  fetchUtxos: getAddressUtxos,
  fetchTip: getTipHeight,
  fetchTx: getTransaction,
  submitPkg: submitPackage,
  broadcastTx: broadcastTransaction,
  signChild: signPsbt,
  txIdOf: transactionIdFromHex,
  heightLockOf: relativeHeightLock,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface AutoExitOptions {
  bundle: RecoveryBundle;
  seed: string;
  network: string;
  feeRate: number;
  esploraUrl?: string;
  accountNumber?: AccountNumberInput;
  minNetSats?: bigint | number | string;
  includeUneconomical?: boolean;
  // Split the funding UTXO into one UTXO per leaf so leaf chains broadcast in
  // parallel (~1 block per deepest chain) at the cost of one extra
  // transaction. Off by default: refunds are deferred until maturity, so the
  // funding change is never locked and leaves proceed fine sequentially
  // (~1 block per remaining package in total).
  fanOut?: boolean;
  bufferSats?: bigint | number | string;
  pollIntervalMs?: number;
  maxRounds?: number;
  onEvent?: (message: string) => void;
  deps?: Partial<AutoExitDeps>;
}

export interface AutoExitResult {
  network: string;
  fundingAddress: string | undefined;
  rounds: number;
  leaves: LeafExitState[];
  earliestMaturityHeight: number | null;
  // Sweep-compatible packages: one refund entry per leaf that produced one.
  packages: LeafPackage[];
}

// How many consecutive submit failures a leaf tolerates before it is marked
// failed and the remaining leaves continue without it.
const MAX_LEAF_FAILURES = 5;
// Small floor kept on every fan-out output beyond the estimated CPFP fees so
// rounding and vsize drift cannot strand a chain one sat short.
const PER_LEAF_FAN_OUT_BUFFER = 1_000n;
// Ignore confirmed crumbs at the funding address that cannot pay any fee bump.
const MIN_USABLE_UTXO_SATS = 600n;

// Drives a full unilateral exit: derives the funding key, waits for funding,
// fans the funding UTXO out to one UTXO per economical leaf, then loops
// package -> sign -> submit-head -> wait-for-confirmation per leaf until every
// chain has been broadcast or is blocked on its refund timelock. Stateless
// across runs: each round reconstructs packages from live chain state (the SDK
// skips already-broadcast transactions), so interrupting and re-running is
// always safe.
export async function autoExit({
  bundle,
  seed,
  network,
  feeRate,
  esploraUrl,
  accountNumber,
  minNetSats = 0n,
  includeUneconomical = false,
  fanOut = false,
  bufferSats = 1_000n,
  pollIntervalMs = 30_000,
  maxRounds = 1_000,
  onEvent,
  deps,
}: AutoExitOptions): Promise<AutoExitResult> {
  const d: AutoExitDeps = { ...DEFAULT_DEPS, ...deps };
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const log = (message: string) => onEvent?.(message);

  const key = deriveCpfpFundingKey({ seed, network, accountNumber });
  if (!key.address) throw new AutoExitError("Funding key produced no address");
  const estimate = await d.estimateFunding({
    bundle,
    feeRate,
    fundingScript: key.script,
    fundingPublicKey: key.publicKey,
    bufferSats,
    minNetSats,
    includeUneconomical,
  });
  log(
    `Funding address ${key.address} (${key.derivationPath}); required ~${estimate.requiredSats} sats for ${estimate.perLeaf.filter((l) => l.economical || includeUneconomical).length} leaf/leaves`,
  );

  const states = new Map<string, LeafExitState>();
  const refundHexes = new Map<string, string>();
  for (const leaf of estimate.perLeaf) {
    if (!leaf.leafId) continue;
    states.set(leaf.leafId, {
      leafId: leaf.leafId,
      status:
        leaf.economical || includeUneconomical ? "pending" : "skipped-uneconomical",
      valueSats: leaf.valueSats,
      feeSats: leaf.feeSats,
      netSats: leaf.netSats,
    });
  }
  const skipped = [...states.values()].filter(
    (s) => s.status === "skipped-uneconomical",
  );
  if (skipped.length > 0) {
    log(
      `Skipping ${skipped.length} uneconomical leaf/leaves (value does not cover CPFP + sweep fees): ${skipped.map((s) => `${s.leafId} (net ${s.netSats} sats)`).join(", ")}`,
    );
  }

  const leafById = new Map(bundle.leaves.map((leaf) => [leaf.id, leaf]));
  const pendingLeaves = () =>
    [...states.values()].filter((s) => s.status === "pending");

  // Ensure initial funding exists before starting rounds.
  let utxos = await confirmedFundingUtxos(d, key.address, baseUrl);
  if (utxos.length === 0) {
    log(
      `No confirmed funding at ${key.address}; send at least ${estimate.requiredSats} sats and leave this running`,
    );
    await d.watchFunding({
      address: key.address,
      script: key.script,
      publicKey: key.publicKey,
      network,
      esploraUrl,
      minSats: estimate.requiredSats,
      pollIntervalMs,
      // Shared announcer: reports incoming/underfunded UTXOs and the
      // split-funding consolidation hint, same as the watch-cpfp command.
      onPoll: createFundingWatchLogger({
        address: key.address,
        minSats: estimate.requiredSats,
        log,
      }),
    });
    utxos = await confirmedFundingUtxos(d, key.address, baseUrl);
  }

  let rounds = 0;
  while (pendingLeaves().length > 0) {
    rounds += 1;
    if (rounds > maxRounds) {
      throw new AutoExitError(
        `Exceeded ${maxRounds} rounds with leaves still pending: ${pendingLeaves()
          .map((s) => s.leafId)
          .join(", ")}`,
      );
    }
    utxos = await confirmedFundingUtxos(d, key.address, baseUrl);
    const active = pendingLeaves();
    if (utxos.length === 0) {
      log("No spendable confirmed funding UTXO yet; waiting");
      await d.sleep(pollIntervalMs);
      continue;
    }

    // One UTXO per leaf keeps leaf chains independent (the SDK chains change
    // per package internally). Fan out once when there are fewer UTXOs than
    // active leaves. Without --fan-out, leaves share the funding chain and
    // broadcast sequentially, which is fine because timelocked refunds are
    // deferred (their change never blocks the chain).
    if (fanOut && utxos.length < active.length && active.length > 1) {
      const amounts = active.map(
        (s) => BigInt(s.feeSats) + PER_LEAF_FAN_OUT_BUFFER,
      );
      const fanOutTx = buildFanOutTransaction({
        utxos: utxos.map((u) => toCpfpUtxo(u, key.script, key.publicKey)),
        amounts,
        privateKey: key.privateKey,
        feeRate,
      });
      log(
        `Splitting funding into ${amounts.length} per-leaf UTXOs (txid ${fanOutTx.txid})`,
      );
      await d.broadcastTx(fanOutTx.txHex, baseUrl);
      if (!(await waitForConfirmation(d, fanOutTx.txid, baseUrl, pollIntervalMs, log))) {
        log(
          `Fan-out ${fanOutTx.txid} disappeared from the mempool (likely evicted); rebuilding next round`,
        );
      }
      continue;
    }

    // Largest UTXO funds the leaf with the largest remaining fees.
    const sortedActive = [...active].sort((a, b) =>
      Number(BigInt(b.feeSats) - BigInt(a.feeSats)),
    );
    const submitted: Array<{ state: LeafExitState; parentTxid: string }> = [];
    let waitingDependency = false;
    for (let i = 0; i < sortedActive.length; i += 1) {
      const state = sortedActive[i]!;
      const utxo = utxos[i];
      if (!utxo) {
        waitingDependency = true;
        break;
      }
      const leaf = leafById.get(state.leafId);
      if (!leaf) {
        state.status = "failed";
        state.lastError = "Leaf missing from bundle";
        continue;
      }
      let packages: LeafPackage[];
      try {
        packages = await d.constructPackages({
          bundle: { ...bundle, leaves: [leaf] },
          cpfpUtxos: [toCpfpUtxo(utxo, key.script, key.publicKey)],
          feeRate,
        });
      } catch (error) {
        recordLeafError(state, error, log);
        continue;
      }
      const txPackages = packages[0]?.txPackages ?? [];
      if (txPackages.length === 0) {
        // Everything for this leaf (including the refund) is on chain.
        state.status = "exit-broadcast";
        log(`Leaf ${state.leafId}: all transactions broadcast`);
        continue;
      }
      const last = txPackages[txPackages.length - 1]!;
      if (last.tx) {
        refundHexes.set(state.leafId, last.tx);
        state.refundTxid = d.txIdOf(last.tx);
      }

      const head = txPackages[0]!;
      if (!head.tx || !head.feeBumpPsbt) {
        recordLeafError(state, new AutoExitError("Package head missing tx or PSBT"), log);
        continue;
      }
      const parentTxid = d.txIdOf(head.tx);

      // Refunds (and any CSV-locked transaction) must wait out their relative
      // timelock; defer the leaf and report when it matures.
      const lock = d.heightLockOf(head.tx);
      if (lock) {
        const maturity = await lockMaturityHeight(d, lock, baseUrl);
        const tip = await d.fetchTip(baseUrl);
        if (maturity === null) {
          waitingDependency = true;
          log(`Leaf ${state.leafId}: timelocked parent not confirmed yet; waiting`);
          continue;
        }
        if (tip + 1 < maturity) {
          state.status = "waiting-timelock";
          state.maturityHeight = maturity;
          log(
            `Leaf ${state.leafId}: refund timelocked until block ${maturity} (${maturity - tip} blocks away); re-run after maturity`,
          );
          continue;
        }
      }

      try {
        const signedChild = d.signChild(head.feeBumpPsbt, key.privateKey);
        await d.submitPkg([head.tx, signedChild], baseUrl);
        submitted.push({ state, parentTxid });
        log(
          `Leaf ${state.leafId}: submitted package (parent ${parentTxid}, ${txPackages.length - 1} remaining after confirmation)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/missingorspent|TRUC|already in mempool|txn-already|bip68|non-final/i.test(message)) {
          // Dependency not confirmed yet or already submitted; try again next round.
          waitingDependency = true;
          log(`Leaf ${state.leafId}: deferred (${message})`);
        } else {
          recordLeafError(state, error, log);
        }
      }
    }

    if (submitted.length === 0) {
      // Leaves still pending are blocked on a dependency confirming or on a
      // transient error (waitingDependency); anything terminal already left
      // "pending" status. Wait a poll interval and re-evaluate.
      if (pendingLeaves().length === 0) break;
      await d.sleep(pollIntervalMs);
      continue;
    }

    for (const entry of submitted) {
      const confirmed = await waitForConfirmation(
        d,
        entry.parentTxid,
        baseUrl,
        pollIntervalMs,
        log,
      );
      if (confirmed) {
        log(`Leaf ${entry.state.leafId}: package confirmed (${entry.parentTxid})`);
      } else {
        // Evicted (e.g. fee spike outbid the package): the leaf stays pending
        // and the next round rebuilds and resubmits it from chain state.
        log(
          `Leaf ${entry.state.leafId}: package ${entry.parentTxid} disappeared from the mempool (likely evicted); will rebuild and resubmit`,
        );
      }
    }
  }

  const leaves = [...states.values()];
  const maturities = leaves
    .filter((s) => s.status === "waiting-timelock" && s.maturityHeight)
    .map((s) => s.maturityHeight!);
  return {
    network,
    fundingAddress: key.address,
    rounds,
    leaves,
    earliestMaturityHeight: maturities.length > 0 ? Math.min(...maturities) : null,
    packages: leaves
      .filter((s) => refundHexes.has(s.leafId))
      .map((s) => ({
        leafId: s.leafId,
        txPackages: [{ tx: refundHexes.get(s.leafId)! }],
      })),
  };
}

function recordLeafError(
  state: LeafExitState,
  error: unknown,
  log: (message: string) => void,
) {
  const message = error instanceof Error ? error.message : String(error);
  state.lastError = message;
  state.failureCount = (state.failureCount ?? 0) + 1;
  if (state.failureCount >= MAX_LEAF_FAILURES) {
    state.status = "failed";
    log(`Leaf ${state.leafId}: giving up after ${MAX_LEAF_FAILURES} failures (${message})`);
  } else {
    log(`Leaf ${state.leafId}: error (${message}); will retry`);
  }
}

async function confirmedFundingUtxos(
  d: AutoExitDeps,
  address: string,
  baseUrl: string,
): Promise<EsploraUtxo[]> {
  const utxos = await d.fetchUtxos(address, baseUrl);
  return utxos
    .filter(
      (u) => u?.status?.confirmed && BigInt(u.value ?? 0) >= MIN_USABLE_UTXO_SATS,
    )
    .sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
}

function toCpfpUtxo(
  utxo: EsploraUtxo,
  script: string,
  publicKey: string,
): CpfpUtxo {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    value: BigInt(utxo.value),
    script,
    publicKey,
  };
}

async function lockMaturityHeight(
  d: AutoExitDeps,
  lock: HeightLock,
  baseUrl: string,
): Promise<number | null> {
  for (const candidate of lock.prevTxidCandidates) {
    let tx: EsploraTransaction | null = null;
    try {
      tx = await d.fetchTx(candidate, baseUrl);
    } catch {
      continue;
    }
    if (tx?.status?.confirmed && Number.isInteger(tx.status.block_height)) {
      return tx.status.block_height! + lock.blocks;
    }
    if (tx) return null; // known but unconfirmed
  }
  return null;
}

// How many consecutive not-found polls before a submitted transaction is
// treated as evicted from the mempool. Generous because Esplora may briefly
// 404 a transaction right after submission while it propagates.
const EVICTION_NOT_FOUND_POLLS = 20;

// Resolves true when the transaction confirms, false when it has been absent
// from the mempool for EVICTION_NOT_FOUND_POLLS consecutive polls (evicted,
// e.g. outbid during a fee spike). Waiting forever on an evicted transaction
// would stall the whole recovery with no signal, so eviction is surfaced to
// the caller, which rebuilds and resubmits on the next round.
async function waitForConfirmation(
  d: AutoExitDeps,
  txid: string,
  baseUrl: string,
  pollIntervalMs: number,
  log: (message: string) => void,
): Promise<boolean> {
  let consecutiveErrors = 0;
  let consecutiveNotFound = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const tx = await d.fetchTx(txid, baseUrl);
      consecutiveErrors = 0;
      if (tx?.status?.confirmed) return true;
      consecutiveNotFound = tx === null ? consecutiveNotFound + 1 : 0;
      if (consecutiveNotFound >= EVICTION_NOT_FOUND_POLLS) return false;
      if (attempt % 10 === 0) log(`Still waiting for ${txid} to confirm`);
    } catch (error) {
      consecutiveErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`Esplora poll failed (${message}); retrying`);
    }
    const backoff = Math.min(2 ** consecutiveErrors, 8);
    await d.sleep(pollIntervalMs * backoff);
  }
}

export function transactionIdFromHex(txHex: string): string {
  return parseTransaction(txHex).id;
}

// Reads a BIP68 relative height lock from the transaction's first input.
// Returns null when the sequence disables relative locks or encodes a
// time-based lock (Spark refunds use height-based locks).
export function relativeHeightLock(txHex: string): HeightLock | null {
  const tx = parseTransaction(txHex);
  const input = tx.getInput(0);
  const sequence = input?.sequence;
  if (sequence === undefined || sequence >= 0x80000000) return null;
  if ((sequence & 0x00400000) !== 0) return null;
  const blocks = sequence & 0xffff;
  if (blocks === 0) return null;
  const rawTxid = input?.txid;
  const candidates: string[] = [];
  if (rawTxid) {
    const hex = bytesToHex(rawTxid instanceof Uint8Array ? rawTxid : new Uint8Array(rawTxid));
    candidates.push(hex, bytesToHex(new Uint8Array([...hexToBytes(hex)].reverse())));
  }
  return { blocks, prevTxidCandidates: candidates };
}

function parseTransaction(txHex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
}
