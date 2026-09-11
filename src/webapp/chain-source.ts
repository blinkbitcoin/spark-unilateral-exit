// Chain source for the exit-monitor webapp: an Esplora-compatible REST API
// (mempool.space by default, any electrs/esplora instance via URL override)
// plus a JSON-RPC adapter for a local bitcoind on the LAN (server=1 is
// enough; block scans additionally need txindex=1). Both surface the same
// minimal interface the scanner needs: tip height, block txids, raw tx hex,
// outspends (child discovery), and confirmation heights.
//
// The esplora implementation delegates to the repo's proven client in
// ../esplora.ts (timeouts, error bodies) rather than re-implementing fetches;
// only the hex endpoint is new here.

import {
  getAddressUtxos,
  getOutspends,
  getTipHeight,
  getTransaction,
  getTxHex,
} from "../esplora.ts";
import type { EsploraUtxo } from "../types.ts";

export interface Outspend {
  spent: boolean;
  txid?: string;
  vin?: number;
}

export interface ChainSource {
  readonly id: string;
  readonly kind: "esplora" | "rpc";
  readonly label: string;
  /** True when blockTxids can enumerate full blocks (rpc + txindex). */
  readonly canListBlockTxids: boolean;
  tipHeight(): Promise<number>;
  /** Raw hex for a txid, or null when the source does not know it. */
  txHex(txid: string): Promise<string | null>;
  /** Txids included in a block, in order. Throws when unsupported. */
  blockTxids(height: number): Promise<string[]>;
  /** UTXOs for an address (esplora only; rpc has no address index). */
  addressUtxos(address: string): Promise<EsploraUtxo[]>;
  /** Confirmation height of a txid, or null when unconfirmed/unknown. */
  confirmedHeight(txid: string): Promise<number | null>;
  /** Which outputs of a txid have been spent, and by whom. */
  outspends(txid: string, voutCount: number): Promise<Outspend[]>;
}

export class ChainSourceError extends Error {
  readonly sourceId: string;

  constructor(message: string, sourceId: string) {
    super(message);
    this.name = "ChainSourceError";
    this.sourceId = sourceId;
  }
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
  readonly canListBlockTxids = false;
  private readonly baseUrl: string;

  constructor({ baseUrl, id, label }: EsploraSourceOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.id = id ?? this.baseUrl;
    this.label = label ?? this.baseUrl;
  }

  async tipHeight(): Promise<number> {
    return getTipHeight(this.baseUrl);
  }

  async txHex(txid: string): Promise<string | null> {
    return getTxHex(txid, this.baseUrl);
  }

  async blockTxids(): Promise<string[]> {
    // The esplora REST API has no full block-tx listing; the /block endpoint
    // returns only the coinbase. Block scans need the rpc source.
    throw new ChainSourceError(
      "esplora cannot list block txs; use the rpc source for block scans",
      this.id,
    );
  }

  async addressUtxos(address: string): Promise<EsploraUtxo[]> {
    return getAddressUtxos(address, this.baseUrl);
  }

  async confirmedHeight(txid: string): Promise<number | null> {
    const tx = await getTransaction(txid, this.baseUrl);
    const status = tx?.status;
    if (!status?.confirmed) return null;
    return typeof status.block_height === "number" ? status.block_height : null;
  }

  // voutCount is irrelevant for esplora: /outspends returns every output.
  async outspends(txid: string, _voutCount: number): Promise<Outspend[]> {
    return getOutspends(txid, this.baseUrl);
  }
}

export interface RpcSourceOptions {
  url: string;
  username: string;
  password: string;
  id?: string;
  label?: string;
}

/** Local bitcoind via JSON-RPC. Needs server=1; block scans need txindex=1. */
export class BitcoindRpcSource implements ChainSource {
  readonly id: string;
  readonly kind = "rpc" as const;
  readonly label: string;
  readonly canListBlockTxids = true;
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

  private async callOptional<T>(
    method: string,
    params: unknown[],
    notFoundMatch: RegExp,
  ): Promise<T | null> {
    try {
      return await this.call<T>(method, params);
    } catch (error) {
      if (
        error instanceof ChainSourceError &&
        notFoundMatch.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  async tipHeight(): Promise<number> {
    const info = await this.call<{ blocks: number }>("getblockchaininfo", []);
    return info.blocks;
  }

  async txHex(txid: string): Promise<string | null> {
    return this.callOptional<string>(
      "getrawtransaction",
      [txid],
      /not found|TX_NOT_FOUND|genesis block coinbase/i,
    );
  }

  async blockTxids(height: number): Promise<string[]> {
    const hash = await this.call<string>("getblockhash", [height]);
    const block = await this.call<{ tx: string[] }>("getblock", [hash, 1]);
    return block.tx ?? [];
  }

  async addressUtxos(): Promise<EsploraUtxo[]> {
    // scantxoutset is expensive and unbounded; address UTXO listing needs an
    // index. Esplora is the right tool for address watching.
    throw new ChainSourceError(
      "bitcoind RPC cannot list address UTXOs without an address index; use an esplora source",
      this.id,
    );
  }

  async confirmedHeight(txid: string): Promise<number | null> {
    const tx = await this.callOptional<{ blockhash?: string }>(
      "getrawtransaction",
      [txid, true],
      /not found|TX_NOT_FOUND/i,
    );
    if (!tx?.blockhash) return null;
    const header = await this.call<{ height: number }>("getblockheader", [
      tx.blockhash,
    ]);
    return header.height;
  }

  async outspends(txid: string, voutCount: number): Promise<Outspend[]> {
    // bitcoind >= 25: one {txid, vout} pair per output, results in vout
    // order. NOTE: gettxspendingprevout scans the MEMPOOL only - confirmed
    // spenders are invisible, so family walks against an rpc source find
    // children only while they are still unconfirmed. esplora tracks
    // confirmed outspends; use it for complete walks.
    const prevouts = Array.from({ length: voutCount }, (_, vout) => ({
      txid,
      vout,
    }));
    const spendings = await this.callOptional<
      Array<{ spendingtxid?: string | null } | null>
    >("gettxspendingprevout", [prevouts], /not found|TX_NOT_FOUND/i);
    if (!spendings) return [];
    return spendings.map((s) => ({
      spent: Boolean(s?.spendingtxid),
      txid: s?.spendingtxid ?? undefined,
    }));
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
