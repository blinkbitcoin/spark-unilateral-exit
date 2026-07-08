import { describe, it, expect } from "vitest";

import {
  deriveCpfpFundingKey,
  pickFundingUtxo,
  watchCpfpFunding,
  CpfpFundingError,
} from "../src/cpfp-funding.ts";

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("deriveCpfpFundingKey", () => {
  it("is deterministic for the same seed/network/account", () => {
    const a = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET", accountNumber: 0 });
    const b = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET", accountNumber: 0 });
    expect(a.address).toBe(b.address);
    expect(a.privateKeyHex).toBe(b.privateKeyHex);
    expect(a.derivationPath).toBe("m/8797556'/0/0");
  });

  it("uses a P2WPKH address matching the network", () => {
    expect(
      deriveCpfpFundingKey({ seed: SEED, network: "MAINNET" }).address,
    ).toMatch(/^bc1q/);
    expect(
      deriveCpfpFundingKey({ seed: SEED, network: "REGTEST", accountNumber: 1 }).address,
    ).toMatch(/^bcrt1q/);
    const key = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET" });
    expect(key.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(key.script).toMatch(/^0014[0-9a-f]{40}$/);
  });

  it("exports a watch-only xpub and descriptor at the hardened purpose level", () => {
    const mainnet = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET", accountNumber: 0 });
    expect(mainnet.purposeXpub).toMatch(/^xpub/);
    expect(mainnet.watchDescriptor).toMatch(
      /^wpkh\(\[[0-9a-f]{8}\/8797556'\]xpub[1-9A-HJ-NP-Za-km-z]+\/0\/0\)$/,
    );
    const regtest = deriveCpfpFundingKey({ seed: SEED, network: "REGTEST", accountNumber: 1 });
    expect(regtest.purposeXpub).toMatch(/^tpub/);
    expect(regtest.watchDescriptor).toContain("/1/0)");
  });

  it("derives distinct keys per account", () => {
    const a0 = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET", accountNumber: 0 });
    const a1 = deriveCpfpFundingKey({ seed: SEED, network: "MAINNET", accountNumber: 1 });
    expect(a0.address).not.toBe(a1.address);
  });

  it("rejects unknown networks", () => {
    expect(() => deriveCpfpFundingKey({ seed: SEED, network: "BOGUS" })).toThrow(
      CpfpFundingError,
    );
  });
});

describe("pickFundingUtxo", () => {
  const confirmed = {
    txid: "a".repeat(64),
    vout: 0,
    value: 5000,
    status: { confirmed: true, block_height: 100 },
  };
  const mempool = {
    txid: "b".repeat(64),
    vout: 1,
    value: 5000,
    status: { confirmed: false },
  };

  it("returns a UTXO meeting value and confirmation requirements", () => {
    const match = pickFundingUtxo({
      utxos: [confirmed],
      minValue: 1000n,
      minConfirmations: 1,
      tipHeight: 105,
    });
    expect(match).toMatchObject({ txid: confirmed.txid, vout: 0, confirmations: 6 });
    expect(match!.value).toBe(5000n);
  });

  it("skips UTXOs below the minimum value", () => {
    expect(
      pickFundingUtxo({ utxos: [confirmed], minValue: 6000n, minConfirmations: 1, tipHeight: 105 }),
    ).toBeNull();
  });

  it("skips UTXOs below the required confirmations", () => {
    expect(
      pickFundingUtxo({ utxos: [confirmed], minValue: 1000n, minConfirmations: 10, tipHeight: 105 }),
    ).toBeNull();
  });

  it("accepts mempool UTXOs when minConfirmations is 0", () => {
    const match = pickFundingUtxo({
      utxos: [mempool],
      minValue: 1000n,
      minConfirmations: 0,
      tipHeight: null,
    });
    expect(match).toMatchObject({ txid: mempool.txid, vout: 1, confirmations: 0 });
  });

  it("rejects mempool UTXOs when a confirmation is required", () => {
    expect(
      pickFundingUtxo({ utxos: [mempool], minValue: 1000n, minConfirmations: 1, tipHeight: null }),
    ).toBeNull();
  });
});

describe("watchCpfpFunding", () => {
  it("polls until a matching UTXO appears and returns the canonical shape", async () => {
    const responses = [
      [],
      [{ txid: "c".repeat(64), vout: 2, value: 700, status: { confirmed: true, block_height: 10 } }],
      [{ txid: "d".repeat(64), vout: 0, value: 20000, status: { confirmed: true, block_height: 10 } }],
    ];
    let call = 0;
    const utxo = await watchCpfpFunding({
      address: "bcrt1qexample",
      script: "0014deadbeef",
      publicKey: "02abc",
      network: "REGTEST",
      esploraUrl: "http://localhost/api",
      minSats: 10000,
      minConfirmations: 1,
      fetchUtxos: async () => responses[Math.min(call++, responses.length - 1)]!,
      fetchTipHeight: async () => 12,
      sleep: async () => {},
    });
    expect(utxo).toMatchObject({
      txid: "d".repeat(64),
      vout: 0,
      script: "0014deadbeef",
      publicKey: "02abc",
    });
    expect(utxo.value).toBe("20000");
    expect(call).toBe(3);
  });

  it("survives transient Esplora failures, backing off between retries", async () => {
    let call = 0;
    const errors: (Error | null)[] = [];
    const sleeps: number[] = [];
    const utxo = await watchCpfpFunding({
      address: "bcrt1qexample",
      script: "0014deadbeef",
      publicKey: "02abc",
      network: "REGTEST",
      esploraUrl: "http://localhost/api",
      minSats: 10000,
      minConfirmations: 1,
      pollIntervalMs: 1000,
      fetchUtxos: async () => {
        call += 1;
        if (call < 4) throw new Error("Request timed out after 30000ms");
        return [
          { txid: "e".repeat(64), vout: 0, value: 20000, status: { confirmed: true, block_height: 10 } },
        ];
      },
      fetchTipHeight: async () => 12,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onPoll: ({ error }) => errors.push(error),
    });
    expect(utxo.txid).toBe("e".repeat(64));
    expect(call).toBe(4);
    expect(errors.filter(Boolean)).toHaveLength(3);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  it("times out when funds never arrive", async () => {
    let clock = 0;
    await expect(
      watchCpfpFunding({
        address: "bcrt1qexample",
        network: "REGTEST",
        esploraUrl: "http://localhost/api",
        minSats: 10000,
        minConfirmations: 0,
        timeoutMs: 100,
        fetchUtxos: async () => [],
        fetchTipHeight: async () => 0,
        sleep: async () => {},
        now: () => (clock += 60),
      }),
    ).rejects.toThrow(/Timed out/);
  });
});
