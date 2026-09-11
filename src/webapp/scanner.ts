// Block scanner for the exit-monitor webapp. Two modes:
//
//   Shape scan: classify every tx in a block (or range) purely structurally.
//     classifyStructure IS the filter: a tx is a candidate exactly when its
//     stage is not "unknown", so the rules live in one place.
//
//   Watch mode: given known Spark txids or output scripts (from a recovery
//     bundle), only report family-related txs and classify them with family
//     evidence (parent stage, anchor prevout), which upgrades confidence.
//
// Sources: esplora (mempool.space) cannot enumerate block txids beyond the
// coinbase, so full-block scans run against the RPC source (bitcoind with
// txindex); esplora powers single-tx lookups, family walks, and address
// watching.

import {
  classifyStructure,
  txStructure,
  type ExitStage,
  type TxClassification,
  type TxStructure,
} from "./exit-detector.ts";
import { parseRelaxedTx } from "../tx-utils.ts";
import type { ChainSource } from "./chain-source.ts";

export interface ScanFinding {
  classification: TxClassification;
  blockHeight: number | null;
  inMempool: boolean;
}

export interface ScanResult {
  height: number;
  scannedAt: string;
  txCount: number;
  candidates: number;
  findings: ScanFinding[];
  error: string | null;
  /** True when the scan stopped early because shouldStop() fired. */
  stopped?: boolean;
  /** True when this block's result came from persisted state, not a scan. */
  skipped?: boolean;
}

export type ScanProgressEvent =
  | { type: "range"; from: number; to: number; totalBlocks: number }
  | { type: "block-start"; height: number; index: number; totalBlocks: number }
  | { type: "block-txs"; height: number; done: number; total: number; found: number }
  | { type: "block-done"; height: number; txCount: number; candidates: number; findings: number; ms: number; details?: Array<{ txid: string; stage: string; confidence: string }> }
  | { type: "block-error"; height: number; error: string }
  | { type: "range-done"; from: number; to: number; blocks: number; findings: number; ms: number };

export interface ScanOptions {
  /** Stop after this many classified candidates per block (UI paginates). */
  maxCandidates?: number;
  /** Only report findings related to these txids (watch mode). */
  watchTxids?: string[];
  /** Only report findings touching these output scripts (watch mode). */
  watchScripts?: string[];
  /** Progress sink for live logging (state, speed, progress). */
  onProgress?: (event: ScanProgressEvent) => void;
  /** Polled between chunks and blocks; returning true aborts the scan. */
  shouldStop?: () => boolean;
}

// Fetch hexes with a small concurrency bound: a mainnet block carries
// thousands of txs, and unbounded Promise.all would flood bitcoind (or the
// esplora host) with simultaneous requests. 16 in-flight requests saturates
// a LAN round-trip anyway.
const HEX_CONCURRENCY = 16;

export async function scanBlock(
  source: ChainSource,
  height: number,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const maxCandidates = options.maxCandidates ?? 50;
  const progress = options.onProgress ?? (() => {});
  const blockStartedAt = Date.now();

  // Fast path: sources that can hand over the whole serialized block in one
  // call (rpc, same host) skip the per-tx round-trips entirely - the block
  // is split locally and every tx is parsed from memory.
  if (!watchModeNeeded(options) && source.blockRawHex) {
    let rawHex: string | null = null;
    try {
      rawHex = await source.blockRawHex(height);
    } catch (error) {
      // Fall through to the per-tx path; a blockRawHex failure is not a
      // scan failure unless the fallback also fails.
      rawHex = null;
    }
    if (rawHex) {
      return scanRawBlock(source, rawHex, height, options, {
        maxCandidates,
        progress,
        blockStartedAt,
      });
    }
  }

  let txids: string[];
  try {
    txids = await source.blockTxids(height);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress({ type: "block-error", height, error: message });
    return {
      height,
      scannedAt: new Date().toISOString(),
      txCount: 0,
      candidates: 0,
      findings: [],
      error: message,
    };
  }

  // Every tx below came from blockTxids(height), so its confirmation height
  // is the scanned height; no per-tx confirmedHeight round-trip is needed.
  const watchTxids = new Set(options.watchTxids ?? []);
  const watchScripts = new Set(
    (options.watchScripts ?? []).map((s) => s.toLowerCase()),
  );
  const watchMode = watchTxids.size > 0 || watchScripts.size > 0;
  void watchMode;

  const findings: ScanFinding[] = [];
  let candidates = 0;
  let stopped = false;
  for (let start = 0; start < txids.length; start += HEX_CONCURRENCY) {
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
    const chunk = txids.slice(start, start + HEX_CONCURRENCY);
    const hexes = await Promise.all(
      chunk.map(async (txid) => ({ txid, hex: await source.txHex(txid) })),
    );
    for (const { hex } of hexes) {
      if (!hex) continue;
      const structure = txStructure(hex);
      const touchesWatchedScript =
        watchScripts.size > 0 &&
        structure.outputs.some((o) => watchScripts.has(o.script.toLowerCase()));
      const spendsWatchedTx =
        watchTxids.size > 0 &&
        structure.inputs.some((i) => watchTxids.has(i.txid));
      const isWatchedTx = watchTxids.has(structure.txid);
      if (watchMode) {
        if (!touchesWatchedScript && !spendsWatchedTx && !isWatchedTx) continue;
      } else if (classifyStructure(structure).stage === "unknown") {
        continue;
      }
      candidates += 1;
      const spendsAnchor = await checkSpendsAnchor(source, structure.inputs);
      const classification = classifyStructure(structure, {
        spendsAnchor,
        parentConfirmedHeight: height,
      });
      findings.push({
        classification,
        blockHeight: height,
        inMempool: false,
      });
      if (findings.length >= maxCandidates) break;
    }
    progress({
      type: "block-txs",
      height,
      done: Math.min(start + HEX_CONCURRENCY, txids.length),
      total: txids.length,
      found: findings.length,
    });
    if (findings.length >= maxCandidates) break;
  }

  return {
    height,
    scannedAt: new Date().toISOString(),
    txCount: txids.length,
    candidates,
    findings,
    error: null,
    ...(stopped ? { stopped: true } : {}),
  };
}

// The original per-tx path for scanRawBlock fallbacks: identical semantics
// to scanBlock's tail above, reached only when raw-block parsing desyncs.
async function scanBlockPerTx(
  source: ChainSource,
  height: number,
  options: ScanOptions,
  ctx: {
    maxCandidates: number;
    progress: (event: ScanProgressEvent) => void;
  },
): Promise<ScanResult> {
  return scanBlock(source, height, { ...options, maxCandidates: ctx.maxCandidates, onProgress: ctx.progress });
}

// Fetch prevout txs in parallel and report whether any spent output is a
// 0-value P2A anchor. Bounded to the input count (small for exit txs).
async function checkSpendsAnchor(
  source: ChainSource,
  inputs: Array<{ txid: string; vout: number }>,
): Promise<boolean> {
  const checks = await Promise.all(
    inputs.slice(0, 8).map(async (input) => {
      const hex = await source.txHex(input.txid);
      if (!hex) return false;
      return txStructure(hex).outputs[input.vout]?.isAnchor === true;
    }),
  );
  return checks.some(Boolean);
}

function watchModeNeeded(options: ScanOptions): boolean {
  return (
    (options.watchTxids?.length ?? 0) > 0 || (options.watchScripts?.length ?? 0) > 0
  );
}

// Whole-block scan: split the serialized block into transactions locally
// (80-byte header, varint tx count, then each tx's own serialization
// length) and classify from memory - no per-tx RPC at all.
async function scanRawBlock(
  source: ChainSource,
  rawHex: string,
  height: number,
  options: ScanOptions,
  ctx: {
    maxCandidates: number;
    progress: (event: ScanProgressEvent) => void;
    blockStartedAt: number;
  },
): Promise<ScanResult> {
  const { maxCandidates, progress } = ctx;
  const raw = Buffer.from(rawHex, "hex");
  let offset = 80;
  const readVarint = (): number => {
    const first = raw[offset] ?? 0;
    offset += 1;
    if (first < 0xfd) return first;
    const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    const value =
      len === 8
        ? Number(raw.readBigUInt64LE(offset))
        : raw.readUIntLE(offset, len);
    offset += len;
    return value;
  };
  const txCount = readVarint();
  const findings: ScanFinding[] = [];
  let candidates = 0;
  let txSeen = 0;
  let stopped = false;
  while (offset < raw.length && txSeen < txCount) {
    if (options.shouldStop?.()) {
      stopped = true;
      break;
    }
    let structure: ReturnType<typeof txStructure> | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const tx = parseRelaxedTx(raw.subarray(offset).toString("hex"));
      const bytes = tx.toBytes(true, tx.hasWitnesses);
      offset += bytes.length;
      txSeen += 1;
      const hex = Buffer.from(bytes).toString("hex");
      structure = txStructure(hex);
    } catch {
      // A parse failure would desync the walk; bail to the safe path rather
      // than misreport coverage.
      return scanBlockPerTx(source, height, options, ctx);
    }
    if (classifyStructure(structure).stage === "unknown") continue;
    candidates += 1;
    // eslint-disable-next-line no-await-in-loop
    const spendsAnchor = await checkSpendsAnchor(source, structure.inputs);
    const classification = classifyStructure(structure, {
      spendsAnchor,
      parentConfirmedHeight: height,
    });
    findings.push({
      classification,
      blockHeight: height,
      inMempool: false,
    });
    if (findings.length >= maxCandidates) break;
  }
  void readVarint;
  progress({
    type: "block-txs",
    height,
    done: txSeen,
    total: txCount,
    found: findings.length,
  });
  return {
    height,
    scannedAt: new Date().toISOString(),
    txCount: txCount,
    candidates,
    findings,
    error: null,
    ...(stopped ? { stopped: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Family walk: from a seed txid, follow spent-output edges forward and
// classify each hop with the previous stage as evidence.
// ---------------------------------------------------------------------------

/**
 * Follow an exit family forward from a seed txid. The seed is classified
 * first (optionally as a known stage via `seedStage`), then children are
 * found via the source's outspends. Structures fetched along the walk are
 * reused as family evidence instead of re-fetched.
 */
export async function followExitFamily(
  source: ChainSource,
  seedTxid: string,
  options: {
    seedStage?: ExitStage;
    maxDepth?: number;
  } = {},
): Promise<TxClassification[]> {
  const maxDepth = options.maxDepth ?? 6;
  const out: TxClassification[] = [];
  // txid -> structure cache for the walk; also carries each walked tx's
  // outputs so a child's anchor prevout is a local lookup.
  const structures = new Map<string, TxStructure>();
  const structureOf = async (txid: string): Promise<TxStructure | null> => {
    const cached = structures.get(txid);
    if (cached) return cached;
    const hex = await source.txHex(txid);
    if (!hex) return null;
    const structure = txStructure(hex);
    structures.set(txid, structure);
    return structure;
  };

  let frontier: Array<{ txid: string; parentStage?: ExitStage }> = [
    { txid: seedTxid, parentStage: options.seedStage },
  ];
  const seen = new Set<string>();
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: typeof frontier = [];
    for (const item of frontier) {
      if (seen.has(item.txid)) continue;
      seen.add(item.txid);
      const structure = await structureOf(item.txid);
      if (!structure) continue;
      const [confirmed, outspends, spendsAnchor] = await Promise.all([
        source.confirmedHeight(item.txid),
        source.outspends(item.txid, structure.outputs.length),
        isAnchorSpend(source, structures, structure.inputs),
      ]);
      const classification = classifyStructure(structure, {
        parentStage: item.parentStage,
        spendsAnchor,
        parentConfirmedHeight: confirmed,
      });
      out.push(classification);
      for (const outspend of outspends) {
        if (outspend.spent && outspend.txid) {
          next.push({
            txid: outspend.txid,
            parentStage: classification.stage,
          });
        }
      }
    }
    frontier = next;
  }
  return out;
}

// Whether any input of `structure` spends a 0-value P2A anchor, resolving
// prevout structures through the walk cache.
async function isAnchorSpend(
  source: ChainSource,
  cache: Map<string, TxStructure>,
  inputs: Array<{ txid: string; vout: number }>,
): Promise<boolean> {
  const checks = await Promise.all(
    inputs.slice(0, 8).map(async (input) => {
      const cached = cache.get(input.txid);
      if (cached) return cached.outputs[input.vout]?.isAnchor === true;
      const hex = await source.txHex(input.txid);
      if (!hex) return false;
      return txStructure(hex).outputs[input.vout]?.isAnchor === true;
    }),
  );
  return checks.some(Boolean);
}
