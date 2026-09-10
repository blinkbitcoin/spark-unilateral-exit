import { afterEach, expect, it, vi } from "vitest";
import { Transaction, p2wpkh } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { ExplorerChain, MEMPOOL_API } from "../../desktop/explorer.ts";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { transactionIdFromHex } from "../../src/transaction-id.ts";
import { SEED } from "./helpers.ts";
const genesis = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const payment = p2wpkh(deriveIdentityKeyPair(SEED, "MAINNET", 1).publicKey);
function transaction() {
  const tx = new Transaction();
  tx.addOutput({ script: payment.script, amount: 50000n });
  tx.addInput({ txid: "11".repeat(32), index: 0, finalScriptWitness: [new Uint8Array([1])] });
  return bytesToHex(tx.toBytes(true, true));
}
function fixture() {
  const request = vi.fn<typeof fetch>();
  const reply = (data: unknown, status = 200) => request.mockResolvedValueOnce(new Response(typeof data === "string" ? data : JSON.stringify(data), { status }));
  return { request, reply, chain: new ExplorerChain(request) };
}
afterEach(() => vi.unstubAllGlobals());
it("uses mainnet mempool endpoints with timeouts, no redirects, and explicit chain verification", async () => {
  const f = fixture(); f.reply(genesis); await f.chain.verify();
  expect(f.request).toHaveBeenLastCalledWith(`${MEMPOOL_API}/block-height/0`, expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
  await expect(f.chain.verify("LOCAL")).rejects.toThrow("not on Bitcoin mainnet");
  f.reply("wrong"); await expect(f.chain.verify("MAINNET")).rejects.toThrow("not on Bitcoin mainnet");
  f.reply("missing", 404); await expect(f.chain.verify()).rejects.toThrow("could not find");
  f.reply("rate limited", 429); await expect(f.chain.verify()).rejects.toThrow("429");
  f.request.mockRejectedValueOnce(new Error("timeout")); await expect(f.chain.verify()).rejects.toThrow("timeout");
  vi.stubGlobal("fetch", f.request); f.reply(genesis); await new ExplorerChain().verify();
});
it("distinguishes missing, unconfirmed and confirmed transactions and rejects inconsistent heights", async () => {
  const f = fixture(); f.reply("missing", 404); expect(await f.chain.status("a")).toBeNull();
  f.reply({ confirmed: false }); expect(await f.chain.status("a")).toEqual({ confirmations: 0 });
  f.reply({ confirmed: true, block_height: 100 }); f.reply("102"); expect(await f.chain.status("a")).toEqual({ confirmations: 3 });
  for (const [status, tip] of [[{}, "102"], [{ confirmed: true }, "102"], [{ confirmed: true, block_height: -1 }, "102"], [{ confirmed: true, block_height: 100 }, "bad"], [{ confirmed: true, block_height: 100 }, "99"]]) {
    f.reply(status); f.reply(tip); await expect(f.chain.status("a")).rejects.toThrow("Invalid confirmation");
  }
});
it("verifies the raw funding transaction's ID, output, value and script before using explorer UTXOs", async () => {
  const f = fixture(), hex = transaction(), txid = transactionIdFromHex(hex);
  const utxo = { txid, vout: 0, value: 50000, status: { confirmed: true } };
  f.reply([null, {}, { status: {} }, { ...utxo, status: { confirmed: false } }, utxo]); f.reply(hex);
  expect(await f.chain.funding(payment.address!)).toEqual({ unspents: [{ txid, vout: 0, amount: .0005, scriptPubKey: bytesToHex(payment.script) }] });
  expect(f.request.mock.calls.map(([url]) => url)).toEqual([`${MEMPOOL_API}/address/${payment.address}/utxo`, `${MEMPOOL_API}/tx/${txid}/hex`]);
  f.reply("missing", 404); await expect(f.chain.funding(payment.address!)).rejects.toThrow("fee address");
  for (const data of [{}, Array(1001).fill(utxo)]) { f.reply(data); await expect(f.chain.funding(payment.address!)).rejects.toThrow("oversized"); }
  for (const change of [{ txid: "bad" }, { vout: .5 }, { vout: -1 }, { value: .5 }, { value: 0 }]) {
    f.reply([{ ...utxo, ...change }]); await expect(f.chain.funding(payment.address!)).rejects.toThrow("Invalid funding");
  }
  f.reply([utxo, utxo]); f.reply(hex); await expect(f.chain.funding(payment.address!)).rejects.toThrow("Duplicate");
  f.reply([{ ...utxo, txid: "22".repeat(32) }]); f.reply(hex); await expect(f.chain.funding(payment.address!)).rejects.toThrow("ID does not match");
  f.reply([{ ...utxo, vout: 1 }]); f.reply(hex); await expect(f.chain.funding(payment.address!)).rejects.toThrow("missing");
  f.reply([{ ...utxo, value: 1 }]); f.reply(hex); await expect(f.chain.funding(payment.address!)).rejects.toThrow("value or script");
  const other = p2wpkh(deriveIdentityKeyPair("01".repeat(64), "MAINNET", 1).publicKey);
  f.reply([utxo]); f.reply(hex); await expect(f.chain.funding(other.address!)).rejects.toThrow("value or script");
});
it("submits exact packages and raw transactions and rejects ambiguous or partially rejected results", async () => {
  const f = fixture();
  for (const result of [{ package_msg: "success" }, { package_msg: "success", "tx-results": { a: {} } }]) { f.reply(result); await f.chain.submit("aa", "bb"); }
  expect(f.request).toHaveBeenLastCalledWith(`${MEMPOOL_API}/v1/txs/package`, expect.objectContaining({ method: "POST", body: '["aa","bb"]', headers: { "content-type": "application/json" } }));
  for (const result of [{ package_msg: "failure" }, { package_msg: "success", "tx-results": { a: { error: "rejected" } } }]) { f.reply(result); await expect(f.chain.submit("aa", "bb")).rejects.toThrow("not accepted"); }
  f.reply("missing", 404); await expect(f.chain.submit("aa", "bb")).rejects.toThrow("cannot submit");
  const hex = transaction(); f.reply(transactionIdFromHex(hex)); await f.chain.broadcast(hex);
  expect(f.request).toHaveBeenLastCalledWith(`${MEMPOOL_API}/tx`, expect.objectContaining({ body: hex, headers: { "content-type": "text/plain" } }));
  f.reply("missing", 404); await expect(f.chain.broadcast(hex)).rejects.toThrow("did not confirm");
  f.reply("wrong txid"); await expect(f.chain.broadcast(hex)).rejects.toThrow("did not confirm");
});
