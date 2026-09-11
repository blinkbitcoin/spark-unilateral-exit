// HTTP API + static file server for the Spark exit monitor webapp.
//
// Endpoints (all JSON):
//   GET /api/health                       -> { ok, tip, source }
//   GET /api/config                       -> active chain source description
//   POST /api/source                      -> switch source at runtime; body is
//                                            { kind: "rpc", url, username, password }
//                                            or { kind: "esplora", network }.
//                                            The candidate is connection-tested
//                                            before the active source swaps.
//   GET /api/block/:height                -> scan one block for exit shapes
//   GET /api/tx/:txid                     -> classify one transaction
//   GET /api/follow/:txid                 -> walk an exit family from a seed
//   GET /api/scan?from=&to=               -> scan a height range (bounded)
//   POST /api/watch                       -> add watch targets (txid/scripts)
//   GET /api/watch                        -> list watch targets
//   DELETE /api/watch                      -> clear watch targets
//
// Sources: --source esplora --esplora-url ... (default mempool.space mainnet)
// or --source rpc --rpc-url ... --rpc-user ... --rpc-password ... for a
// bitcoind on the LAN (block scans need txindex=1). Both are also switchable
// at runtime via POST /api/source and the UI settings dialog.
//
// Run: node src/webapp/server.ts (Node >= 22.18 for .ts type stripping).

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import {
  BitcoindRpcSource,
  EsploraChainSource,
  NETWORK_PRESETS,
  type ChainSource,
} from "./chain-source.ts";
import { classifyTx, txStructure, type Confidence, type ExitStage } from "./exit-detector.ts";
import { followExitFamily, scanBlock, type ScanFinding, type ScanResult } from "./scanner.ts";
import { ScanStateStore } from "./scan-state.ts";

const EXIT_STAGES: ExitStage[] = [
  "static-deposit",
  "node-tx",
  "direct-tx",
  "refund-tx",
  "direct-refund-tx",
  "cpfp-bump-child",
  "sweep-tx",
];

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

// Load gitignored .env (repo root) if present: BITCOIN_RPC_URL/USER/
// PASSWORD for a LAN/mainnet bitcoind without passing secrets on the CLI.
// Deliberately minimal: KEY=VALUE lines, no interpolation.
const envPath = path.join(here, "..", "..", ".env");
try {
  const envFile = await fs.readFile(envPath, "utf8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && match[1] && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // Absent .env is the normal case (CI, regtest runs).
}

interface WatchState {
  txids: string[];
  scripts: string[];
}

const watch: WatchState = { txids: [], scripts: [] };

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i]!.replace(/^--/, "")] = argv[i + 1] ?? "";
  }
  return args;
}

function buildSource(args: Record<string, string>): ChainSource {
  // BITCOIN_RPC_URL in the environment (gitignored .env via make monitor)
  // implies the rpc source; --source still overrides explicitly.
  const kind = args.source ?? (process.env.BITCOIN_RPC_URL ? "rpc" : "esplora");
  if (kind === "rpc") {
    const url = args["rpc-url"] ?? process.env.BITCOIN_RPC_URL ?? "http://127.0.0.1:8332";
    return new BitcoindRpcSource({
      url,
      username: args["rpc-user"] ?? process.env.BITCOIN_RPC_USER ?? "",
      password: args["rpc-password"] ?? process.env.BITCOIN_RPC_PASSWORD ?? "",
      label: `bitcoind @ ${url}`,
    });
  }
  const network = (args.network ?? "mainnet") as keyof typeof NETWORK_PRESETS;
  const preset = NETWORK_PRESETS[network] ?? NETWORK_PRESETS.mainnet;
  const baseUrl = args["esplora-url"] ?? preset.esplora;
  return new EsploraChainSource({ baseUrl, label: preset.label });
}

const args = parseArgs(process.argv);
// Mutable: POST /api/source swaps it after a successful connection test.
let activeSource: ChainSource = buildSource(args);
const port = Number(args.port ?? process.env.PORT ?? 4480);

function getSource(): ChainSource {
  return activeSource;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

interface RpcSourceBody {
  kind: "rpc";
  url: string;
  username: string;
  password: string;
}

interface EsploraSourceBody {
  kind: "esplora";
  network: keyof typeof NETWORK_PRESETS;
}

type SourceBody = RpcSourceBody | EsploraSourceBody;

// Build a candidate source from a /api/source body. Validation errors throw
// with a message the UI shows inline.
function sourceFromBody(body: unknown): SourceBody {
  if (!body || typeof body !== "object") {
    throw new Error("body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record.kind === "rpc") {
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!/^https?:\/\/.+/i.test(url)) {
      throw new Error("RPC URL must be an http(s) URL, e.g. http://192.168.1.10:8332");
    }
    return {
      kind: "rpc",
      url,
      username: typeof record.username === "string" ? record.username : "",
      password: typeof record.password === "string" ? record.password : "",
    };
  }
  if (record.kind === "esplora") {
    const network = typeof record.network === "string" ? record.network : "";
    if (!(network in NETWORK_PRESETS)) {
      throw new Error(`unknown network "${network}"; expected one of ${Object.keys(NETWORK_PRESETS).join(", ")}`);
    }
    return { kind: "esplora", network: network as keyof typeof NETWORK_PRESETS };
  }
  throw new Error('body must have kind "rpc" or "esplora"');
}

function instantiateSource(body: SourceBody): ChainSource {
  if (body.kind === "rpc") {
    return new BitcoindRpcSource({
      url: body.url,
      username: body.username,
      password: body.password,
      label: `bitcoind @ ${body.url}`,
    });
  }
  const preset = NETWORK_PRESETS[body.network];
  return new EsploraChainSource({ baseUrl: preset.esplora, label: preset.label });
}

// ---------------------------------------------------------------------------
// Scan runs: async block-range scans with live progress, stop control, and
// an event bus the SSE endpoint subscribes to.
// ---------------------------------------------------------------------------

interface ScanRunState {
  id: number;
  from: number;
  to: number;
  status: "running" | "stopped" | "done" | "error";
  startedAt: number;
  endedAt: number | null;
  blocksDone: number;
  blocksTotal: number;
  txsScanned: number;
  findings: number;
  lastError: string | null;
  /** Final per-block results, available once the run ends. */
  results: ScanResult[];
  stopRequested: boolean;
  /** Blocks skipped because persisted state already covered them. */
  skipped: number;
}

// Persisted scan coverage + findings, keyed by source id (chain).
const scanStore = new ScanStateStore();

let currentRun: ScanRunState | null = null;
let nextRunId = 1;
type ScanEventListener = (event: Record<string, unknown>) => void;
const scanEventListeners = new Set<ScanEventListener>();

function emitScanEvent(event: Record<string, unknown>): void {
  for (const listener of scanEventListeners) {
    try {
      listener(event);
    } catch {
      // A dead SSE subscriber must not break the scan loop.
      scanEventListeners.delete(listener);
    }
  }
  // Mirror progress to the server log so `npm run monitor` shows live state
  // even with no browser attached.
  const e = event as { type: string; from?: number; to?: number; height?: number; index?: number; totalBlocks?: number; txCount?: number; candidates?: number; findings?: number; done?: number; total?: number; error?: string; ms?: number; blocks?: number };
  switch (e.type) {
    case "range":
      process.stdout.write(`[scan] range ${e.from}..${e.to} (${e.totalBlocks} blocks)\n`);
      break;
    case "block-start":
      process.stdout.write(`[scan] block ${e.height} (${e.index}/${e.totalBlocks})\n`);
      break;
    case "block-done":
      process.stdout.write(
        `[scan] block ${e.height} done: ${e.txCount} txs, ${e.candidates} shaped, ${e.findings} found\n`,
      );
      break;
    case "block-error":
      process.stdout.write(`[scan] block ${e.height} error: ${e.error}\n`);
      break;
    case "range-done":
      process.stdout.write(
        `[scan] finished: ${e.blocks} blocks, ${e.findings} findings in ${(Number(e.ms) / 1000).toFixed(1)}s\n`,
      );
      break;
    default:
      break;
  }
}

function subscribeScanEvents(listener: ScanEventListener): () => void {
  scanEventListeners.add(listener);
  return () => scanEventListeners.delete(listener);
}

function scanRunStatus(): Record<string, unknown> {
  if (!currentRun) return { running: false };
  const { results, ...state } = currentRun;
  return {
    running: state.status === "running",
    ...state,
    elapsedMs: state.endedAt ?? Date.now() - state.startedAt,
  };
}

function stopScanRun(): boolean {
  if (!currentRun || currentRun.status !== "running") return false;
  currentRun.stopRequested = true;
  emitScanEvent({ type: "stop-requested", runId: currentRun.id });
  return true;
}

function startScanRun(
  source: ChainSource,
  params: { from?: number; to?: number; span?: number },
  watchState: WatchState,
): ScanRunState {
  if (currentRun?.status === "running") {
    throw new Error("a scan is already running; stop it first");
  }
  const span = Math.min(Math.max(params.span ?? 10, 1), 50);
  const run: ScanRunState = {
    id: nextRunId++,
    from: 0,
    to: 0,
    status: "running",
    startedAt: Date.now(),
    endedAt: null,
    blocksDone: 0,
    blocksTotal: 0,
    txsScanned: 0,
    findings: 0,
    lastError: null,
    results: [],
    stopRequested: false,
    skipped: 0,
  };
  currentRun = run;

  // Range resolution is async (tip lookup); the run starts immediately in
  // the background so POST /api/scan/run returns at once.
  void (async () => {
    try {
      const tip = await source.tipHeight();
      const to = Math.min(params.to ?? tip, tip);
      const from = Math.max(Math.min(params.from ?? to - span + 1, to), 0);
      run.from = from;
      // An explicit from+to pair wins over span; span only bounds the
      // default window (and stays clamped at 50 for the auto-scanner's
      // bounded catch-up).
      const requested = params.from !== undefined && params.to !== undefined;
      run.to = requested ? to : Math.min(to, from + span - 1);
      run.blocksTotal = run.to - run.from + 1;
      emitScanEvent({
        type: "range",
        from: run.from,
        to: run.to,
        totalBlocks: run.blocksTotal,
      });

      const rangeStartedAt = Date.now();
      for (let h = run.from; h <= run.to; h += 1) {
        if (run.stopRequested) break;
        // Persisted state: blocks already scanned (with the same watch
        // filters or without any) are skipped instead of re-fetched.
        if (scanStore.has(source.id, h)) {
          const record = scanStore.blockRecord(source.id, h)!;
          const saved = scanStore.findingsForBlock(source.id, h);
          run.skipped += 1;
          run.blocksDone += 1;
          run.findings += saved.length;
          run.results.push({
            height: h,
            scannedAt: new Date(record.scannedAt).toISOString(),
            txCount: record.txCount,
            candidates: saved.length,
            findings: saved.map(
              (f): ScanFinding => ({
                classification: {
                  txid: f.txid,
                  stage: f.stage as ExitStage,
                  confidence: f.confidence as Confidence,
                  matchedRules: [],
                  reason: "restored from persisted scan state",
                  csvBlocks: null,
                  isTruc: true,
                  hasAnchorOutput: false,
                  outputs: [],
                  inputs: 0,
                  maturityHeight: null,
                  spentOutpoints: [],
                },
                blockHeight: h,
                inMempool: false,
              }),
            ),
            error: null,
            skipped: true,
          });
          emitScanEvent({
            type: "block-skip",
            height: h,
            findings: saved.length,
          });
          continue;
        }
        emitScanEvent({
          type: "block-start",
          height: h,
          index: run.blocksDone + 1,
          totalBlocks: run.blocksTotal,
        });
        // eslint-disable-next-line no-await-in-loop
        const result = await scanBlock(source, h, {
          maxCandidates: 25,
          watchTxids: watchState.txids,
          watchScripts: watchState.scripts,
          shouldStop: () => run.stopRequested,
          onProgress: (event) => {
            if (event.type === "block-txs") run.txsScanned = event.done;
            emitScanEvent(event as unknown as Record<string, unknown>);
          },
        });
        run.results.push(result);
        run.blocksDone += 1;
        run.findings += result.findings.length;
        run.txsScanned = result.txCount;
        if (result.error) {
          run.lastError = `block ${h}: ${result.error}`;
          emitScanEvent({ type: "block-error", height: h, error: result.error });
          break;
        }
        scanStore.recordBlock(source.id, h, {
          txCount: result.txCount,
          findings: result.findings.map((f) => ({
            txid: f.classification.txid,
            stage: f.classification.stage,
            confidence: f.classification.confidence,
          })),
        });
        emitScanEvent({
          type: "block-done",
          height: h,
          txCount: result.txCount,
          candidates: result.candidates,
          findings: result.findings.length,
          ms: Date.now() - rangeStartedAt,
          details: result.findings.map((f) => ({
            txid: f.classification.txid,
            stage: f.classification.stage,
            confidence: f.classification.confidence,
          })),
        });
      }
      run.status = run.stopRequested ? "stopped" : "done";
    } catch (error) {
      run.status = "error";
      run.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      run.endedAt = Date.now();
      const elapsed = run.endedAt - run.startedAt;
      emitScanEvent({
        type: "range-done",
        from: run.from,
        to: run.to,
        blocks: run.blocksDone,
        findings: run.findings,
        ms: elapsed,
      });
      process.stdout.write(
        `scan run #${run.id} ${run.status}: ${run.blocksDone}/${run.blocksTotal} blocks ` +
          `(${run.skipped} skipped from state), ${run.findings} findings in ${(elapsed / 1000).toFixed(1)}s` +
          (run.lastError ? ` (last error: ${run.lastError})` : "") + "\n",
      );
    }
  })();

  return run;
}

// ---------------------------------------------------------------------------
// Auto-scanner: while connected to a block-listing source, scan each new
// block as the chain advances so coverage stays at the tip without manual
// runs. Shares currentRun so it respects stop and blocks manual starts.
// ---------------------------------------------------------------------------

const AUTO_SCAN_POLL_MS = 30_000;

async function autoScanTick(): Promise<void> {
  const source = getSource();
  if (!source.canListBlockTxids) return;
  if (currentRun?.status === "running") return;
  try {
    const tip = await source.tipHeight();
    const last = scanStore.lastAutoScanned(source.id) ?? tip - 1;
    if (tip <= last) return;
    // Catch up at most 10 blocks per tick so one interval stays bounded.
    const from = last + 1;
    const to = Math.min(tip, last + 10);
    process.stdout.write(
      `[auto] scanning new blocks ${from}..${to} (tip ${tip})\n`,
    );
    const run = startScanRun(source, { from, to }, watch);
    // Mark auto progress only after the run finishes successfully.
    void (async () => {
      while (currentRun === run && run.status === "running") {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (run.status === "done") {
        scanStore.setLastAutoScanned(source.id, run.to);
      }
    })();
  } catch (error) {
    process.stdout.write(
      `[auto] tick failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}


async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
): Promise<void> {
  const send = (status: number, body: unknown) => json(res, status, body);
  const source = getSource();

  if (req.method === "GET" && pathname === "/api/health") {
    let tip: number | null = null;
    let error: string | null = null;
    try {
      tip = await source.tipHeight();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return send(200, { ok: error === null, tip, source: source.id, error });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return send(200, {
      source: {
        id: source.id,
        kind: source.kind,
        label: source.label,
        canListBlockTxids: source.canListBlockTxids,
      },
    });
  }

  if (req.method === "POST" && pathname === "/api/source") {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { error: "invalid JSON body" });
    }
    let candidateBody: SourceBody;
    try {
      candidateBody = sourceFromBody(parsed);
    } catch (e) {
      return send(400, { error: e instanceof Error ? e.message : String(e) });
    }
    // Connection-test before swapping so a typo never leaves the monitor
    // pointed at a dead source; the active source stays untouched on failure.
    const candidate = instantiateSource(candidateBody);
    try {
      const tip = await candidate.tipHeight();
      activeSource = candidate;
      return send(200, {
        source: {
          id: candidate.id,
          kind: candidate.kind,
          label: candidate.label,
          canListBlockTxids: candidate.canListBlockTxids,
        },
        tip,
      });
    } catch (e) {
      return send(502, {
        error: `connection test failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const blockMatch = pathname.match(/^\/api\/block\/(\d+)$/);
  if (req.method === "GET" && blockMatch) {
    const height = Number(blockMatch[1]);
    const result = await scanBlock(source, height, {
      watchTxids: watch.txids,
      watchScripts: watch.scripts,
    });
    return send(200, result);
  }

  const txMatch = pathname.match(/^\/api\/tx\/([0-9a-fA-F]{64})$/);
  if (req.method === "GET" && txMatch) {
    const txid = txMatch[1]!.toLowerCase();
    const hex = await source.txHex(txid);
    if (!hex) return send(404, { error: "transaction not found" });
    const confirmed = await source.confirmedHeight(txid);
    const classification = classifyTx(hex, { parentConfirmedHeight: confirmed });
    return send(200, {
      classification,
      structure: txStructure(hex),
      confirmedHeight: confirmed,
    });
  }

  const followMatch = pathname.match(/^\/api\/follow\/([0-9a-fA-F]{64})$/);
  if (req.method === "GET" && followMatch) {
    const txid = followMatch[1]!.toLowerCase();
    const seedStageParam = query.get("stage");
    const seedStage = EXIT_STAGES.find((s) => s === seedStageParam);
    try {
      const family = await followExitFamily(source, txid, { seedStage });
      return send(200, { seed: txid, family });
    } catch (e) {
      return send(502, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "GET" && pathname === "/api/scan") {
    // Legacy one-shot synchronous form: kept for API compatibility, but the
    // UI uses the async /api/scan/run + /api/scan/events flow so scans can
    // be watched and stopped live.
    const tip = await source.tipHeight();
    const span = Math.min(Number(query.get("span") ?? 10), 50);
    const to = Math.min(Number(query.get("to") ?? tip), tip);
    // Clamp before the loop: an open endpoint must not be able to request a
    // years-long scan range regardless of what the client passes.
    const from = Math.max(
      Math.min(Number(query.get("from") ?? to - span + 1), to),
      0,
    );
    const clampedTo = Math.min(to, from + span - 1);
    const results = [];
    for (let h = from; h <= clampedTo; h += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await scanBlock(source, h, {
        maxCandidates: 25,
        watchTxids: watch.txids,
        watchScripts: watch.scripts,
      });
      results.push(r);
      if (r.error) break;
    }
    return send(200, { from, to: clampedTo, results });
  }

  if (req.method === "POST" && pathname === "/api/scan/run") {
    const body = await readBody(req);
    let parsed: { from?: number; to?: number; span?: number } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // Empty body is fine: defaults below apply.
    }
    const run = startScanRun(source, parsed, watch);
    return send(200, { runId: run.id });
  }

  if (req.method === "POST" && pathname === "/api/scan/stop") {
    const stopped = stopScanRun();
    return send(200, { stopped });
  }

  if (req.method === "GET" && pathname === "/api/scan/status") {
    return send(200, scanRunStatus());
  }

  if (req.method === "GET" && pathname === "/api/state") {
    // Chain strip data: which heights are scanned, where findings sit, and
    // where the auto-scanner has caught up to.
    const records = scanStore.blockRecords(source.id);
    const findings = scanStore.allFindings(source.id);
    const heights = Object.keys(records).map(Number).sort((a, b) => a - b);
    const tip = await source.tipHeight();
    return send(200, {
      chain: source.id,
      tip,
      autoCaughtUpTo: scanStore.lastAutoScanned(source.id),
      scannedHeights: heights,
      blocks: records,
      findings,
    });
  }

  if (req.method === "GET" && pathname === "/api/scan/events") {
    // Server-sent events: the scan loop pushes progress, the stream stays
    // open until the run ends or the client disconnects.
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const unsubscribe = subscribeScanEvents((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", unsubscribe);
    return;
  }

  if (req.method === "POST" && pathname === "/api/exit") {
    // Graceful self-termination for the UI's Exit button: finish the
    // response, then stop accepting connections and shut down.
    send(200, { exiting: true });
    process.stdout.write("exit requested via UI; shutting down\n");
    server.close();
    setImmediate(() => process.exit(0));
    return;
  }

  if (req.method === "POST" && pathname === "/api/watch") {
    const body = await readBody(req);
    let parsed: { txids?: string[]; scripts?: string[] } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return send(400, { error: "invalid JSON body" });
    }
    const txids = (parsed.txids ?? []).filter((t) => /^[0-9a-f]{64}$/i.test(t)).map((t) => t.toLowerCase());
    const scripts = (parsed.scripts ?? []).filter((s) => /^[0-9a-f]+$/i.test(s)).map((s) => s.toLowerCase());
    watch.txids = [...new Set([...watch.txids, ...txids])];
    watch.scripts = [...new Set([...watch.scripts, ...scripts])];
    return send(200, watch);
  }

  if (req.method === "GET" && pathname === "/api/watch") {
    return send(200, watch);
  }

  if (req.method === "DELETE" && pathname === "/api/watch") {
    watch.txids = [];
    watch.scripts = [];
    return send(200, watch);
  }

  send(404, { error: `no route for ${req.method} ${pathname}` });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

async function serveStatic(
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = await fs.readFile(file);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname, url.searchParams).catch((error) => {
      json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  serveStatic(res, pathname).catch(() => {
    res.writeHead(500).end();
  });
});

// Listen on all interfaces so the monitor is reachable over the tailnet
// (http://<node-ip>:4480); override the bind with --host if needed.
const host = args.host ?? process.env.MONITOR_HOST ?? "0.0.0.0";
server.listen(port, host, () => {
  process.stdout.write(
    `spark exit monitor listening on http://${host}:${port} ` +
      `(source: ${activeSource.label})\n`,
  );
  // Auto-scan new blocks while a block-listing source is connected.
  const autoTimer = setInterval(() => {
    void autoScanTick();
  }, AUTO_SCAN_POLL_MS);
  autoTimer.unref();
});
