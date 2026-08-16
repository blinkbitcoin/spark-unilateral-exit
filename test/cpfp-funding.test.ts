import { describe, it, expect } from "vitest";

import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";

import {
  createFundingWatchLogger,
  deriveCpfpFundingKey,
  estimateCpfpFunding,
  pickFundingUtxo,
  watchCpfpFunding,
  CpfpFundingError,
} from "../src/cpfp-funding.ts";
import { reattachPendingRefunds } from "../src/spark-packages.ts";
import type { CpfpUtxo, LeafPackage, RecoveryBundle } from "../src/types.ts";

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
        script: "0014deadbeef",
        publicKey: "02abc",
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

  it("hints at consolidation when funding is split across UTXOs", () => {
    const messages: string[] = [];
    const onPoll = createFundingWatchLogger({
      address: "bcrt1qexample",
      minSats: 10_000,
      log: (m) => messages.push(m),
    });
    const status = { confirmed: true, block_height: 10 };
    const utxos = [
      { txid: "a".repeat(64), vout: 0, value: 6_000, status },
      { txid: "b".repeat(64), vout: 0, value: 5_000, status },
    ];
    onPoll({ attempt: 1, utxos, match: null, error: null });
    onPoll({ attempt: 2, utxos, match: null, error: null });
    const hints = messages.filter((m) => m.includes("Consolidate"));
    // Total 11k covers 10k but no single UTXO does: hint exactly once.
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("11000 sats across 2 UTXOs");
  });

  it("rejects address-only calls that would emit undefined script/publicKey", async () => {
    await expect(
      watchCpfpFunding({
        address: "bcrt1qexample",
        network: "REGTEST",
        esploraUrl: "http://localhost/api",
        minSats: 10000,
        fetchUtxos: async () => [],
        fetchTipHeight: async () => 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/script and publicKey/);
  });
});

// The estimate builds packages from placeholder UTXOs. On a resumed recovery with
// two or more fully-broadcast leaves, reattachPendingRefunds needs one UTXO per
// pending refund, so a single placeholder would make the estimate throw (and,
// before the throw existed, silently under-count the pending-refund fee bumps).
// This pins the fix: one placeholder per leaf, every pending refund counted.
describe("estimateCpfpFunding", () => {
  const FUNDING_SCRIPT = `0014${"11".repeat(20)}`;
  const FUNDING_PUBKEY = `02${"22".repeat(32)}`;
  const bundle = {
    network: "REGTEST",
    leaves: [
      { id: "L1", treeNodeHex: "aa" },
      { id: "L2", treeNodeHex: "bb" },
    ],
  } as unknown as RecoveryBundle;

  // A minimal v3 fee-bump PSBT whose input minus output equals feeSats, so the
  // estimate's PSBT fee reader sees a known per-refund fee.
  function refundFeeBumpPsbtHex(feeSats: bigint): string {
    const tx = new Transaction({ version: 3 });
    tx.addInput({
      txid: hexToBytes("cc".repeat(32)),
      index: 0,
      witnessUtxo: { script: hexToBytes(FUNDING_SCRIPT), amount: 10_000n },
    });
    tx.addOutput({ script: hexToBytes(FUNDING_SCRIPT), amount: 10_000n - feeSats });
    return bytesToHex(tx.toPSBT());
  }

  it("counts both fee bumps and does not throw with 2 pending refunds", async () => {
    const received: CpfpUtxo[][] = [];
    const result = await estimateCpfpFunding({
      bundle,
      feeRate: 5,
      fundingScript: FUNDING_SCRIPT,
      fundingPublicKey: FUNDING_PUBKEY,
      bufferSats: 0n,
      // Stub only the SDK package builder, then run the REAL
      // reattachPendingRefunds over its output: the estimate's placeholder
      // count is held to the same one-UTXO-per-pending-refund contract
      // production enforces, so a regression to a single placeholder throws
      // here exactly as it would in cpfp-address or auto-exit startup.
      constructPackages: async ({ cpfpUtxos, feeRate }) => {
        received.push(cpfpUtxos);
        const packages: LeafPackage[] = [
          { leafId: "L1", txPackages: [] },
          { leafId: "L2", txPackages: [] },
        ];
        await reattachPendingRefunds(packages, bundle, cpfpUtxos, feeRate, "REGTEST", {
          isTxBroadcast: async () => false,
          buildRefundFeeBump: () => refundFeeBumpPsbtHex(1_000n),
          refundForLeaf: () => ({
            txHex: "refundhex",
            completionVariants: [{ txid: "tid", txHex: "refundhex" }],
          }),
        });
        return packages;
      },
    });
    // One placeholder per leaf: same synthetic txid, distinct vouts.
    expect(received[0]).toHaveLength(2);
    expect(received[0]!.map((u) => u.vout)).toEqual([0, 1]);
    expect(new Set(received[0]!.map((u) => u.txid)).size).toBe(1);
    expect(received[0]!.every((u) => u.script === FUNDING_SCRIPT)).toBe(true);
    // Both pending refunds' fee bumps are in the estimate.
    expect(result.feeBumpTxCount).toBe(2);
    expect(result.totalFeeSats).toBe("2000");
    expect(result.requiredSats).toBe("2000");
    expect(result.perLeaf.map((l) => l.feeBumpTxCount)).toEqual([1, 1]);
  });
});
