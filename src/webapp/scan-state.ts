// Persisted scan state: which blocks were scanned and what was found, so
// repeated scans skip covered heights and findings survive restarts.
//
// JSON at MONITOR_STATE_FILE (default <repo>/monitor-state.json, gitignored),
// keyed by chain id so regtest/mainnet states never mix. Writes are atomic
// (tmp file + rename) and happen per scanned block - rates are a few blocks
// per minute at most, so synchronous writes are fine.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BlockRecord {
  scannedAt: number;
  txCount: number;
  hits: number;
}

export interface FindingRecord {
  height: number;
  txid: string;
  stage: string;
  confidence: string;
  firstSeen: number;
}

export interface ChainState {
  blocks: Record<string, BlockRecord>;
  findings: FindingRecord[];
  /** Highest height covered by the auto-scanner; null before the first run. */
  lastAutoScanned: number | null;
}

interface StateFile {
  version: 1;
  chains: Record<string, ChainState>;
}

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function emptyChain(): ChainState {
  return { blocks: {}, findings: [], lastAutoScanned: null };
}

export class ScanStateStore {
  private readonly file: string;
  private state: StateFile;

  constructor(file?: string) {
    this.file = file ?? process.env.MONITOR_STATE_FILE ?? path.join(repoRoot, "monitor-state.json");
    this.state = this.load();
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StateFile;
      if (parsed.version === 1 && parsed.chains) return parsed;
    } catch {
      // Missing or corrupt state starts fresh; scans re-cover the gap.
    }
    return { version: 1, chains: {} };
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  private chain(chain: string): ChainState {
    let c = this.state.chains[chain];
    if (!c) {
      c = emptyChain();
      this.state.chains[chain] = c;
    }
    return c;
  }

  has(chain: string, height: number): boolean {
    return Boolean(this.state.chains[chain]?.blocks[String(height)]);
  }

  blockRecord(chain: string, height: number): BlockRecord | undefined {
    return this.state.chains[chain]?.blocks[String(height)];
  }

  recordBlock(
    chain: string,
    height: number,
    record: { txCount: number; findings: Array<{ txid: string; stage: string; confidence: string }> },
  ): void {
    const c = this.chain(chain);
    c.blocks[String(height)] = {
      scannedAt: Date.now(),
      txCount: record.txCount,
      hits: record.findings.length,
    };
    const known = new Set(c.findings.map((f) => f.txid));
    for (const f of record.findings) {
      if (!known.has(f.txid)) {
        c.findings.push({
          height,
          txid: f.txid,
          stage: f.stage,
          confidence: f.confidence,
          firstSeen: Date.now(),
        });
      }
    }
    this.save();
  }

  findingsForBlock(chain: string, height: number): FindingRecord[] {
    return (this.state.chains[chain]?.findings ?? []).filter(
      (f) => f.height === height,
    );
  }

  allFindings(chain: string): FindingRecord[] {
    return this.state.chains[chain]?.findings ?? [];
  }

  /** Per-height view for the chain strip: records only for scanned heights. */
  blockRecords(chain: string): Record<string, BlockRecord> {
    return this.state.chains[chain]?.blocks ?? {};
  }

  lastAutoScanned(chain: string): number | null {
    return this.state.chains[chain]?.lastAutoScanned ?? null;
  }

  setLastAutoScanned(chain: string, height: number): void {
    this.chain(chain).lastAutoScanned = height;
    this.save();
  }
}
