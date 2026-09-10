// Block scanner for the exit-monitor webapp. Two modes:
//
//   Shape scan: classify every tx in a block (or range) purely structurally.
//     Spark exit-chain txs (TRUC + P2A anchor [+ CSV]) have distinctive
//     shapes; node/direct/refund/sweep stages are identified with the
//     confidence levels described in exit-detector.ts.
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
  classifyTx,
  txStructure,
  type ExitStage,
  type TxClassification,
} from "./exit-detector.ts";
import type { ChainSource } from "./chain-source.ts";
import { EsploraChainSource } from "./chain-source.ts";

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
}

export interface ScanOptions {
  /** Stop after this many classified candidates per block (UI paginates). */
  maxCandidates?: number;
  /** Only report findings related to these txids (watch mode). */
  watchTxids?: string[];
  /** Only report findings touching these output scripts (watch mode). */
  watchScripts?: string[];
}

/** Cheap pre-filter: TRUC txs with a P2A anchor, or self-fee refund shape. */
export function isExitCandidate(structure: ReturnType<typeof txStructure>): boolean {
  if (structure.isTruc && structure.hasAnchorOutput) return true;
  // Operator direct refund: anchorless CSV-locked TRUC spend to one P2TR.
  return (
    structure.isTruc &&
    structure.csvBlocks !== null &&
    structure.inputs.length === 1 &&
    structure.outputs.length === 1 &&
    structure.outputs[0]?.type === "p2tr"
  );
}

export async function scanBlock(
  source: ChainSource,
  height: number,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const maxCandidates = options.maxCandidates ?? 50;
  let txids: string[];
  try {
    txids = await source.blockTxids(height);
  } catch (error) {
    return {
      height,
      scannedAt: new Date().toISOString(),
      txCount: 0,
      candidates: 0,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const watchTxids = new Set(options.watchTxids ?? []);
  const watchScripts = new Set(
    (options.watchScripts ?? []).map((s) => s.toLowerCase()),
  );
  const watchMode = watchTxids.size > 0 || watchScripts.size > 0;

  const findings: ScanFinding[] = [];
  let candidates = 0;
  for (const txid of txids) {
    const hex = await source.txHex(txid);
    if (!hex) continue;
    const structure = txStructure(hex);
    const touchesWatchedScript = watchScripts.size > 0 &&
      structure.outputs.some((o) => watchScripts.has(o.script.toLowerCase()));
    const spendsWatchedTx = watchTxids.size > 0 &&
      structure.inputs.some((i) => watchTxids.has(i.txid));
    const isWatchedTx = watchTxids.has(txid);
    if (watchMode) {
      if (!touchesWatchedScript && !spendsWatchedTx && !isWatchedTx) continue;
    } else if (!isExitCandidate(structure)) {
      continue;
    }
    candidates += 1;
    // Family evidence: the tx spends an anchor output of a watched parent.
    const spendsAnchor = await checkSpendsAnchor(source, structure.inputs);
    const confirmed = await source.confirmedHeight(txid);
    const classification = classifyTx(hex, {
      parentStage: undefined,
      spendsAnchor,
      parentConfirmedHeight: confirmed,
    });
    findings.push({
      classification,
      blockHeight: confirmed ?? height,
      inMempool: confirmed === null,
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
  };
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
      const parent = txStructure(hex);
      return parent.outputs[input.vout]?.isAnchor === true;
    }),
  );
  return checks.some(Boolean);
}

// ---------------------------------------------------------------------------
// Family walk: from a seed txid, follow spent-output edges forward and
// classify each hop with the previous stage as evidence.
// ---------------------------------------------------------------------------

/**
 * Follow an exit family forward from a seed txid. The seed is classified
 * first (optionally as a known stage via `seedStage`), then children are
 * found via esplora outspends (RPC sources skip child discovery).
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
  let frontier: Array<{ txid: string; parentStage?: ExitStage }> = [
    { txid: seedTxid, parentStage: options.seedStage },
  ];
  const seen = new Set<string>();
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<{ txid: string; parentStage?: ExitStage }> = [];
    for (const item of frontier) {
      if (seen.has(item.txid)) continue;
      seen.add(item.txid);
      const hex = await source.txHex(item.txid);
      if (!hex) continue;
      const structure = txStructure(hex);
      const spendsAnchor = await checkSpendsAnchor(source, structure.inputs);
      const confirmed = await source.confirmedHeight(item.txid);
      const classification = classifyTx(hex, {
        parentStage: item.parentStage,
        spendsAnchor,
        parentConfirmedHeight: confirmed,
      });
      out.push(classification);
      const children = await findChildren(source, item.txid);
      for (const child of children) {
        next.push({ txid: child.txid, parentStage: classification.stage });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Which outputs of a txid have been spent, and by whom (esplora only).
 */
export async function findChildren(
  source: ChainSource,
  txid: string,
): Promise<Array<{ txid: string; vout: number }>> {
  if (source.kind !== "esplora") return [];
  const esplora = source as EsploraChainSource;
  const response = await fetch(`${esplora.baseUrl}/tx/${txid}/outspends`);
  if (!response.ok) return [];
  const outspends = (await response.json()) as Array<{
    spent: boolean;
    txid?: string;
    vin?: number;
  }>;
  return outspends
    .map((o, vout) => ({ spent: o.spent, txid: o.txid, vout }))
    .filter((o) => o.spent && o.txid)
    .map((o) => ({ txid: o.txid as string, vout: o.vout }));
}
