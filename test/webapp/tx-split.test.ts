import { describe, expect, it } from "vitest";
import { rawTxLength } from "../../src/webapp/tx-split.ts";

// Block 250000 coinbase (legacy, BIP34 scriptsig, one P2PKH output).
const legacyCoinbase =
  "01000000" + "01" + "00".repeat(32) + "ffffffff" +
  "13" + "0390d0030447f9fc5108880055609a63010000" +
  "00000000" + "01" + "54b8ad9500000000" + "19" +
  "76a914ce2daea72b5b48fc85d9bba2263225cbe98985e088ac" +
  "00000000";

// One-input one-output segwit tx with a 0-value anchor-style output.
const segwitTx =
  "02000000" + "0001" + "01" +
  "aa".repeat(32) + "01000000" + "00" + "ffffffff" +
  "01" + "0000000000000000" + "22" + "5120" + "bb".repeat(32) +
  "01" + "21" + "cc".repeat(33) + "00000000";

// Segwit tx whose input carries an EMPTY witness (stack count 0) - legal
// when spending a non-witness program via a segwit serialization.
const segwitEmptyWitness =
  "02000000" + "0001" + "01" +
  "dd".repeat(32) + "00000000" + "00" + "ffffffff" +
  "01" + "0100000000000000" + "22" + "5120" + "ee".repeat(32) +
  "00" + "00000000";

describe("rawTxLength", () => {
  it("measures a legacy coinbase exactly", () => {
    expect(rawTxLength(Buffer.from(legacyCoinbase, "hex"))).toBe(104);
  });

  it("measures from a block-shaped slice, not just offset 0", () => {
    const tx = Buffer.from(legacyCoinbase, "hex");
    const block = Buffer.concat([Buffer.alloc(81), tx, Buffer.alloc(16)]);
    expect(rawTxLength(block.subarray(81))).toBe(104);
  });

  it("measures a segwit tx with witness", () => {
    expect(rawTxLength(Buffer.from(segwitTx, "hex"))).toBe(
      Buffer.from(segwitTx, "hex").length,
    );
  });

  it("measures a segwit tx with an empty witness stack", () => {
    expect(rawTxLength(Buffer.from(segwitEmptyWitness, "hex"))).toBe(
      Buffer.from(segwitEmptyWitness, "hex").length,
    );
  });

  it("throws on truncation", () => {
    const tx = Buffer.from(segwitTx, "hex");
    expect(() => rawTxLength(tx.subarray(0, tx.length - 3))).toThrow();
  });
});
