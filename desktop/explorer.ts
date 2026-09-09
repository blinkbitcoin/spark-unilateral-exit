import { Address, NETWORK, OutScript } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { BitcoinChain, packageAccepted, parseTx, type Funding, type TxStatus, type PackageResult } from "./chain.ts";
import { transactionIdFromHex } from "../src/transaction-id.ts";
import type { Network } from "./contracts.ts";

export const MEMPOOL_API = "https://mempool.space/api";
const MAINNET_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

export class ExplorerChain extends BitcoinChain {
  constructor(private readonly request: typeof fetch = fetch) { super(); }
  private async query(path: string, body?: string, json = false): Promise<Response> {
    const response = await this.request(`${MEMPOOL_API}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      ...(body === undefined ? {} : { body, headers: { "content-type": json ? "application/json" : "text/plain" } }),
    });
    if (!response.ok && response.status !== 404) throw new Error(`Mempool explorer unavailable (${response.status}). Retry the saved transactions later or connect your own node.`);
    return response;
  }
  private async text(path: string): Promise<string> {
    const response = await this.query(path);
    if (!response.ok) throw new Error("Mempool explorer could not find the requested chain data.");
    return (await response.text()).trim();
  }
  async verify(network: Network = "MAINNET"): Promise<void> {
    if (network !== "MAINNET" || await this.text("/block-height/0") !== MAINNET_GENESIS) throw new Error("The explorer is not on Bitcoin mainnet. Operation stopped.");
  }
  async status(txid: string): Promise<TxStatus> {
    const response = await this.query(`/tx/${txid}/status`);
    if (response.status === 404) return null;
    const status = await response.json() as { confirmed: boolean; block_height?: number };
    if (status.confirmed === false) return { confirmations: 0 };
    const height = status.block_height;
    const tip = Number(await this.text("/blocks/tip/height"));
    if (status.confirmed !== true || !Number.isSafeInteger(height) || height! < 0 || !Number.isSafeInteger(tip) || tip < height!) throw new Error("Invalid confirmation data from the explorer.");
    return { confirmations: tip - height! + 1 };
  }
  async funding(address: string): Promise<Funding> {
    const response = await this.query(`/address/${address}/utxo`);
    if (!response.ok) throw new Error("Mempool explorer could not find the fee address.");
    const utxos = await response.json() as { txid: string; vout: number; value: number; status: { confirmed: boolean } }[];
    if (!Array.isArray(utxos) || utxos.length > 1000) throw new Error("Invalid or oversized funding response from the explorer.");
    const script = bytesToHex(OutScript.encode(Address(NETWORK).decode(address)));
    const unspents: Funding["unspents"] = [];
    const seen = new Set<string>();
    for (const utxo of utxos) {
      if (!utxo?.status?.confirmed) continue;
      if (!/^[0-9a-f]{64}$/.test(utxo.txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 || !Number.isSafeInteger(utxo.value) || utxo.value <= 0) throw new Error("Invalid funding output from the explorer.");
      const id = `${utxo.txid}:${utxo.vout}`;
      if (seen.has(id)) throw new Error("Duplicate funding output from the explorer.");
      seen.add(id);
      const hex = await this.text(`/tx/${utxo.txid}/hex`);
      if (transactionIdFromHex(hex) !== utxo.txid) throw new Error("Funding transaction ID does not match the explorer response.");
      const tx = parseTx(hex);
      if (utxo.vout >= tx.outputsLength) throw new Error("Funding output is missing from its transaction.");
      const output = tx.getOutput(utxo.vout);
      if (output.amount !== BigInt(utxo.value) || !output.script || bytesToHex(output.script) !== script) throw new Error("Funding value or script does not match its transaction.");
      unspents.push({ txid: utxo.txid, vout: utxo.vout, amount: utxo.value / 1e8, scriptPubKey: script });
    }
    return { unspents };
  }
  async submit(parent: string, child: string): Promise<void> {
    const response = await this.query("/v1/txs/package", JSON.stringify([parent, child]), true);
    if (!response.ok) throw new Error("This explorer cannot submit transaction packages. Connect your own Bitcoin node.");
    const result = await response.json() as PackageResult;
    if (!packageAccepted(result)) throw new Error("The explorer has not accepted the package. Retry the saved transactions after checking funding and maturity.");
  }
  async broadcast(hex: string): Promise<void> {
    const response = await this.query("/tx", hex);
    if (!response.ok || (await response.text()).trim() !== transactionIdFromHex(hex)) throw new Error("The explorer did not confirm submission. Check chain status and retry the saved transaction.");
  }
}
