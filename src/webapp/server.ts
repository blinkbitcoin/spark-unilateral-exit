// HTTP API + static file server for the Spark exit monitor webapp.
//
// Endpoints (all JSON):
//   GET /api/health                       -> { ok, tip, source }
//   GET /api/config                       -> active chain source description
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
// bitcoind on the LAN (block scans need txindex=1).
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
import { classifyTx, txStructure, type ExitStage } from "./exit-detector.ts";
import { followExitFamily, scanBlock } from "./scanner.ts";

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
  const kind = args.source ?? "esplora";
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
const source = buildSource(args);
const port = Number(args.port ?? process.env.PORT ?? 4480);

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

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
): Promise<void> {
  const send = (status: number, body: unknown) => json(res, status, body);

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
      source: { id: source.id, kind: source.kind, label: source.label },
    });
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
    const tip = await source.tipHeight();
    const to = Number(query.get("to") ?? tip);
    const span = Math.min(Number(query.get("span") ?? 10), 50);
    const from = Number(query.get("from") ?? Math.max(to - span + 1, 0));
    const results = [];
    for (let h = from; h <= to && h >= 0; h += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await scanBlock(source, h, {
        maxCandidates: 25,
        watchTxids: watch.txids,
        watchScripts: watch.scripts,
      });
      results.push(r);
      if (r.error) break;
    }
    return send(200, { from, to: Math.min(to, from + span - 1), results });
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

server.listen(port, () => {
  process.stdout.write(
    `spark exit monitor listening on http://localhost:${port} ` +
      `(source: ${source.label})\n`,
  );
});
