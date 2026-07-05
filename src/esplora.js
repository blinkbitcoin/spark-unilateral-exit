const DEFAULT_URLS = new Map([
  ["MAINNET", "https://blockstream.info/api"],
  ["TESTNET", "https://blockstream.info/testnet/api"],
  ["SIGNET", "https://mempool.space/signet/api"],
]);

export class EsploraError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = "EsploraError";
    this.status = status ?? null;
    this.body = body ?? null;
    this.url = url ?? null;
  }
}

export function esploraBaseUrl(network, customBaseUrl) {
  if (customBaseUrl) return customBaseUrl.replace(/\/+$/, "");
  const url = DEFAULT_URLS.get(String(network).toUpperCase());
  if (!url) {
    throw new EsploraError(
      `No default Esplora URL for network "${network}". Use --esplora-url to provide one.`,
    );
  }
  return url;
}

export async function submitPackage(txHexArray, baseUrl) {
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

export async function broadcastTransaction(txHex, baseUrl) {
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

export async function getTransaction(txid, baseUrl) {
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
  return response.json();
}

export async function getAddressUtxos(address, baseUrl) {
  const url = `${baseUrl}/address/${address}/utxo`;
  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok) {
    const body = await safeText(response);
    throw new EsploraError(
      `Failed to fetch address UTXOs (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  return response.json();
}

export async function getTipHeight(baseUrl) {
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

async function handlePackageResponse(response, url) {
  const body = await safeText(response);
  if (!response.ok) {
    throw new EsploraError(
      `Package submission rejected (HTTP ${response.status}): ${body}`,
      { status: response.status, body, url },
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new EsploraError(`Request timed out after ${timeoutMs}ms`, { url });
    }
    throw new EsploraError(`Network error: ${error.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "(unreadable response body)";
  }
}
