import { describe, expect, it } from "vitest";
import { Transaction } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { transactionIdFromHex } from "../../src/transaction-id.ts";
describe("Bitcoin transaction IDs", () => {
  it("handles empty P2A input witnesses and commits to scriptSig and outputs", () => {
    const tx = new Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.addOutput({ script: Uint8Array.of(0x51), amount: 500n });
    tx.addInput({ txid: "12".repeat(32), index: 0 });
    tx.addInput({ txid: "34".repeat(32), index: 1, finalScriptWitness: [Uint8Array.of(1)] });
    expect(() => tx.id).toThrow("not finalized");
    const id = transactionIdFromHex(bytesToHex(tx.toBytes(true, true)));
    expect(transactionIdFromHex(bytesToHex(tx.toBytes(true, false)))).toBe(id);
    tx.updateInput(0, { finalScriptSig: Uint8Array.of(0x51) });
    expect(transactionIdFromHex(bytesToHex(tx.toBytes(true, true)))).toBe(tx.id);
    expect(tx.id).not.toBe(id);
  });
});
