import { describe, expect, it } from "vitest";

import { CpfpUtxoParseError, parseCpfpUtxo } from "../src/cpfp.ts";

describe("CPFP UTXO parsing", () => {
  it("parses txid:vout:value:script:publicKey", () => {
    const utxo = parseCpfpUtxo(`${"ab".repeat(32)}:1:50000:0014abcd:02abcd`);

    expect(utxo).toMatchObject({
      txid: "ab".repeat(32),
      vout: 1,
      value: 50000n,
      script: "0014abcd",
      publicKey: "02abcd",
    });
  });

  it("rejects malformed input", () => {
    expect(() => parseCpfpUtxo("bad")).toThrow(CpfpUtxoParseError);
  });

  it("rejects malformed txids", () => {
    expect(() => parseCpfpUtxo("aa:0:50000:0014abcd:02abcd")).toThrow(
      /txid/,
    );
  });

  it("rejects non-positive values", () => {
    expect(() =>
      parseCpfpUtxo(`${"ab".repeat(32)}:0:0:0014abcd:02abcd`),
    ).toThrow(/positive/);
  });

  it("rejects non-integer values", () => {
    expect(() =>
      parseCpfpUtxo(`${"ab".repeat(32)}:0:nope:0014abcd:02abcd`),
    ).toThrow(/positive integer/);
  });
});
