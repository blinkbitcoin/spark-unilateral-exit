import type {
  EsploraOutspend,
  EsploraTransaction,
  EsploraUtxo,
} from "./types.ts";

const DEFAULT_URLS = new Map<string, string>([
  ["MAINNET", "https://blockstream.info/api"],
  ["TESTNET", "https://blockstream.info/testnet/api"],
  ["SIGNET", "https://mempool.space/signet/api"],
]);

interface EsploraErrorOptions {
  status?: number;
  body?: string;
  url?: string;
}

export class EsploraError extends Error {
  status: number | null;
  body: string | null;
  url: string | null;

  constructor(message: string, { status, body, url }: EsploraErrorOptions = {}) {
    super(message);
    this.name = "EsploraError";
    this.status = status ?? null;
    this.body = body ?? null;
    this.url = url ?? null;
  }
}

export function esploraBaseUrl(network: string, customBaseUrl?: string): string {
  if (customBaseUrl) return customBaseUrl.replace(/\/+$/, "");
  const url = DEFAULT_URLS.get(String(network).toUpperCase());
  if (!url) {
    throw new EsploraError(
      `No default Esplora URL for network "${network}". Use --esplora-url to provide one.`,
    );
  }
  return url;
}

export async function submitPackage(
  txHexArray: unknown,
  baseUrl: string,
): Promise<unknown> {
  if (!Array.isArray(txHexArray) || txHexArray.length < 2) {
    throw new EsploraError("submitPackage requires an array of at least 2 raw tx hex strings");
  }
  const url = `${baseUrl}/txs/package`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(txHexArray),
  });
  return handlePackageResponse(response, url);
}

export async function broadcastTransaction(
  txHex: string,
  baseUrl: string,
): Promise<string> {
  if (typeof txHex !== "string" || txHex.length === 0) {
    throw new EsploraError("broadcastTransaction requires a non-empty raw tx hex string");
  }
  const url = `${baseUrl}/tx`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: txHex,
  });
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Broadcast rejected (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  const txid = (await response.text()).trim();
  return txid;
}

export async function getTransaction(
  txid: string,
  baseUrl: string,
): Promise<EsploraTransaction | null> {
  const url = `${baseUrl}/tx/${txid}`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Failed to fetch transaction (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  return response.json() as Promise<EsploraTransaction>;
}

// Reports what spent txid:vout, if anything. Returns null when the endpoint
// does not know the transaction at all, which also lets callers that hold a
// txid of ambiguous byte order try both and keep the one that resolves.
export async function getOutspend(
  txid: string,
  vout: number,
  baseUrl: string,
): Promise<EsploraOutspend | null> {
  const url = `${baseUrl}/tx/${txid}/outspend/${vout}`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Failed to fetch outspend (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  return response.json() as Promise<EsploraOutspend>;
}

export async function getAddressUtxos(
  address: string,
  baseUrl: string,
): Promise<EsploraUtxo[]> {
  const url = `${baseUrl}/address/${address}/utxo`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Failed to fetch address UTXOs (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  return response.json() as Promise<EsploraUtxo[]>;
}

export async function getTipHeight(baseUrl: string): Promise<number> {
  const url = `${baseUrl}/blocks/tip/height`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Failed to fetch tip height (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  const height = Number((await response.text()).trim());
  if (!Number.isInteger(height)) {
    throw new EsploraError(`Esplora returned a non-integer tip height`, { url });
  }
  return height;
}

async function handlePackageResponse(
  response: Response,
  url: string,
): Promise<unknown> {
  const body = await safeText(response);
  if (!response.ok) {
    throw new EsploraError(
      `Package submission rejected (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  throwIfPackageRejected(parsed, url, body);
  return parsed;
}

// Bitcoin Core's submitpackage reports policy rejections with HTTP 200: the
// verdict lives in package_msg plus per-transaction error strings in
// tx-results. Treating 200 as acceptance turns every policy rejection (fee
// below the mempool floor, TRUC topology, spent inputs) into a phantom
// "submitted" that callers later misread as a mempool eviction, so surface
// the verdict as an error here. Endpoints whose response carries no
// package_msg are left alone: absence of a verdict is not a rejection.
function throwIfPackageRejected(
  parsed: unknown,
  url: string,
  body: string,
): void {
  if (typeof parsed !== "object" || parsed === null) return;
  const packageMsg = (parsed as Record<string, unknown>)["package_msg"];
  if (typeof packageMsg !== "string" || packageMsg === "success") return;
  const txResults = (parsed as Record<string, unknown>)["tx-results"];
  const txErrors: string[] = [];
  if (typeof txResults === "object" && txResults !== null) {
    for (const [wtxid, result] of Object.entries(
      txResults as Record<string, unknown>,
    )) {
      if (typeof result !== "object" || result === null) continue;
      const record = result as Record<string, unknown>;
      if (typeof record.error !== "string" || record.error.length === 0) continue;
      const txid = typeof record.txid === "string" ? record.txid : wtxid;
      txErrors.push(`${txid}: ${record.error}`);
    }
  }
  const detail = txErrors.length > 0 ? `: ${txErrors.join("; ")}` : "";
  throw new EsploraError(
    `Package rejected by the node ("${packageMsg}"${detail})`,
    { status: 200, body, url },
  );
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      throw new EsploraError(`Request timed out after ${timeoutMs}ms`, { url });
    }
    throw new EsploraError(`Network error: ${err.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "(unreadable response body)";
  }
}
