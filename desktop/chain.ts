import https from "node:https";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";
import type { BitcoinRpc, Network } from "./contracts.ts";
import type { FetchLike } from "../src/operator/grpc-web.ts";

export const RPC_URL = "http://127.0.0.1:8332";
export const RPC_USER = "testutil";
export const RPC_PASSWORD = "testutilpassword";
export type TxStatus = { confirmations: number } | null;

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
export type Funding = { unspents: { txid: string; vout: number; amount: number; scriptPubKey: string }[] };
export type PackageResult = { package_msg: string; "tx-results"?: Record<string, { error?: string }> };
export function packageAccepted(result: PackageResult): boolean {
  return result.package_msg === "success" && !Object.values(result["tx-results"] ?? {}).some((tx) => tx.error);
}
export abstract class BitcoinChain {
  abstract verify(network?: Network): Promise<void>;
  abstract status(txid: string): Promise<TxStatus>;
  abstract funding(address: string): Promise<Funding>;
  abstract submit(parent: string, child: string): Promise<void>;
  abstract broadcast(hex: string): Promise<void>;
  async maturity(hex: string): Promise<string | null> {
    const tx = parseTx(hex);
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const sequence = input.sequence ?? 0xffffffff;
      if ((sequence & 0x80000000) !== 0 || tx.version < 2) continue;
      if ((sequence & 0x00400000) !== 0) throw new Error("Time-based relative locks are not supported by this app.");
      if (!input.txid) throw new Error("Transaction input has no parent.");
      const parent = await this.status(bytesToHex(input.txid));
      if (!parent || parent.confirmations < 1) return "Waiting for a parent transaction to confirm.";
      const remaining = (sequence & 0xffff) - parent.confirmations;
      if (remaining > 0) return `Waiting for ${remaining} more blocks.`;
    }
    return null;
  }
}
export class LocalChain extends BitcoinChain {
  constructor(private readonly request: typeof fetch = fetch, private readonly config: BitcoinRpc = { url: RPC_URL, username: RPC_USER, password: RPC_PASSWORD }) { super(); }
  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.request(this.config.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "electron-app", method, params }),
    });
    const data = await response.json() as { result: T; error?: { code: number; message: string } };
    if (data.error) throw new RpcError(data.error.code, `Bitcoin RPC ${method} failed (${data.error.code}).`);
    if (!response.ok) throw new Error(`Bitcoin RPC unavailable (${response.status}).`);
    return data.result;
  }
  async verify(network: Network = "LOCAL"): Promise<void> {
    const info = await this.rpc<{ chain: string }>("getblockchaininfo");
    const expected = network === "MAINNET" ? "main" : "regtest";
    if (info.chain !== expected) throw new Error(`The Bitcoin node is not on ${network === "MAINNET" ? "mainnet" : "regtest"}. Operation stopped.`);
  }
  async status(txid: string): Promise<TxStatus> {
    try {
      const tx = await this.rpc<{ confirmations?: number }>("getrawtransaction", [txid, true]);
      return { confirmations: tx.confirmations ?? 0 };
    } catch (error) { if (error instanceof RpcError && error.code === -5) return null; throw error; }
  }
  async funding(address: string) {
    return this.rpc<Funding>("scantxoutset", ["start", [`addr(${address})`]]);
  }
  async submit(parent: string, child: string): Promise<void> {
    const result = await this.rpc<PackageResult>("submitpackage", [[parent, child]]);
    if (!packageAccepted(result)) {
      throw new Error("Bitcoin has not accepted the package. Check funding and transaction maturity, then retry the saved transactions.");
    }
  }
  async broadcast(hex: string): Promise<void> { await this.rpc("sendrawtransaction", [hex]); }
}

export function parseTx(hex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(hex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
}

// Trust only an explicitly supplied local CA. Never disable TLS verification
// globally, including for the SDK. Redirects are not followed.
export function coordinatorFetch(ca: string): FetchLike {
  return (url, init) => new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: init.method, headers: init.headers, signal: init.signal,
      // Electron's TLS runtime needs partial-chain trust when the user trusts
      // the local operator's self-signed leaf certificate directly.
      ...(ca ? { ca, allowPartialTrustChain: true } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) { response.destroy(new Error("Coordinator response is too large.")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const body = Uint8Array.from(Buffer.concat(chunks)).buffer;
        resolve({ ok: response.statusCode === 200, status: response.statusCode ?? 500,
          headers: { get: (name) => String(response.headers[name.toLowerCase()] ?? "") || null },
          arrayBuffer: async () => body });
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
}
