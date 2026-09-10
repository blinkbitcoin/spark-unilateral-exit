// Chain source for the exit-monitor webapp: an Esplora-compatible REST API
// (mempool.space by default, any electrs/esplora instance via URL override)
// plus a JSON-RPC adapter for a local bitcoind on the LAN (rest=1 is enough;
// no esplora needed). Both surface the same minimal interface the scanner
// needs: tip height, block txids, raw tx hex, and address utxos.

import type { EsploraTransaction, EsploraUtxo } from "../types.ts";

export interface ChainSource {
  readonly id: string;
  readonly kind: "esplora" | "rpc";
  readonly label: string;
  tipHeight(): Promise<number>;
  /** Raw hex for a txid, or null when the source does not know it. */
  txHex(txid: string): Promise<string | null>;
  /** Txids included in a block, in order. */
  blockTxids(height: number): Promise<string[]>;
  /** UTXOs for an address (used to watch known exit addresses). */
  addressUtxos(address: string): Promise<EsploraUtxo[]>;
  /** Confirmation height of a txid, or null when unconfirmed/unknown. */
  confirmedHeight(txid: string): Promise<number | null>;
}

export class ChainSourceError extends Error {
  readonly sourceId: string;

  constructor(message: string, sourceId: string) {
    super(message);
    this.name = "ChainSourceError";
    this.sourceId = sourceId;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChainSourceError(
      `GET ${url} failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
      url,
    );
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChainSourceError(
      `GET ${url} failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
      url,
    );
  }
  return response.text();
}

export interface EsploraSourceOptions {
  baseUrl: string;
  id?: string;
  label?: string;
}

export class EsploraChainSource implements ChainSource {
  readonly id: string;
  readonly kind = "esplora" as const;
  readonly label: string;
  /** Base URL, exposed for the scanner's outspends endpoint use. */
  readonly baseUrl: string;

  constructor({ baseUrl, id, label }: EsploraSourceOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.id = id ?? this.baseUrl;
    this.label = label ?? this.baseUrl;
  }

  async tipHeight(): Promise<number> {
    const text = await fetchText(`${this.baseUrl}/blocks/tip/height`);
    const height = Number(text.trim());
    if (!Number.isInteger(height)) {
      throw new ChainSourceError(`non-integer tip height: ${text}`, this.id);
    }
    return height;
  }

  async txHex(txid: string): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/tx/${txid}/hex`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ChainSourceError(
        `tx hex fetch failed (HTTP ${response.status})`,
        this.id,
      );
    }
    return response.text();
  }

  async blockTxids(height: number): Promise<string[]> {
    const hash = (await fetchText(`${this.baseUrl}/block-height/${height}`)).trim();
    const block = (await fetchJson(`${this.baseUrl}/block/${hash}`)) as {
      txid?: string;
      tx_count?: number;
    };
    // The block endpoint returns only the coinbase txid in `txid`; fetch the
    // full list only when the API exposes it (mempool.space does not have a
    // block-tx pagination endpoint, electrs does not either; callers that
    // need full coverage use the RPC source).
    void block;
    throw new ChainSourceError(
      "esplora block tx listing is not exposed; use the rpc source for block scans",
      this.id,
    );
  }

  async addressUtxos(address: string): Promise<EsploraUtxo[]> {
    const utxos = (await fetchJson(
      `${this.baseUrl}/address/${address}/utxo`,
    )) as EsploraUtxo[];
    return Array.isArray(utxos) ? utxos : [];
  }

  async confirmedHeight(txid: string): Promise<number | null> {
    const tx = (await fetchJson(`${this.baseUrl}/tx/${txid}`)) as EsploraTransaction;
    const status = tx?.status;
    if (!status?.confirmed) return null;
    return typeof status.block_height === "number" ? status.block_height : null;
  }
}

export interface RpcSourceOptions {
  url: string;
  username: string;
  password: string;
  id?: string;
  label?: string;
}

/** Local bitcoind via JSON-RPC. Needs server=1; rest is not required. */
export class BitcoindRpcSource implements ChainSource {
  readonly id: string;
  readonly kind = "rpc" as const;
  readonly label: string;
  private readonly url: string;
  private readonly auth: string;

  constructor({ url, username, password, id, label }: RpcSourceOptions) {
    this.url = url.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.id = id ?? this.url;
    this.label = label ?? `bitcoind @ ${this.url}`;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.auth,
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: "spark-exit-monitor",
        method,
        params,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ChainSourceError(
        `${method} failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
        this.id,
      );
    }
    const json = (await response.json()) as {
      result?: T;
      error?: { message?: string } | null;
    };
    if (json.error) {
      throw new ChainSourceError(`${method} error: ${json.error.message}`, this.id);
    }
    return json.result as T;
  }

  async tipHeight(): Promise<number> {
    const info = await this.call<{ blocks: number }>("getblockchaininfo", []);
    return info.blocks;
  }

  async txHex(txid: string): Promise<string | null> {
    try {
      return await this.call<string>("getrawtransaction", [txid]);
    } catch (error) {
      if (error instanceof ChainSourceError && /not found|TX_NOT_FOUND/i.test(error.message)) {
        return null;
      }
      // Verbose form would carry confirmations; we only need hex here.
      throw error;
    }
  }

  async blockTxids(height: number): Promise<string[]> {
    const hash = await this.call<string>("getblockhash", [height]);
    const block = await this.call<{ tx: string[] }>("getblock", [hash, 1]);
    return block.tx ?? [];
  }

  async addressUtxos(address: string): Promise<EsploraUtxo[]> {
    // scantxoutset is expensive and unbounded; address UTXO listing needs an
    // index. Esplora is the right tool for address watching; the RPC source
    // covers block scanning and tx fetch.
    void address;
    throw new ChainSourceError(
      "bitcoind RPC cannot list address UTXOs without an address index; use an esplora source",
      this.id,
    );
  }

  async confirmedHeight(txid: string): Promise<number | null> {
    try {
      const tx = await this.call<{ blockhash?: string }>("getrawtransaction", [txid, true]);
      if (!tx?.blockhash) return null;
      const header = await this.call<{ height: number }>("getblockheader", [tx.blockhash]);
      return header.height;
    } catch (error) {
      if (error instanceof ChainSourceError && /not found|TX_NOT_FOUND/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }
}

export const NETWORK_PRESETS = {
  mainnet: {
    esplora: "https://mempool.space/api",
    label: "mempool.space (mainnet)",
  },
  testnet: {
    esplora: "https://mempool.space/testnet/api",
    label: "mempool.space (testnet)",
  },
  testnet4: {
    esplora: "https://mempool.space/testnet4/api",
    label: "mempool.space (testnet4)",
  },
  signet: {
    esplora: "https://mempool.space/signet/api",
    label: "mempool.space (signet)",
  },
} as const;

export type NetworkName = keyof typeof NETWORK_PRESETS;
