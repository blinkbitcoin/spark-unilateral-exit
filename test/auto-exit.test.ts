import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";

import {
  autoExit,
  relativeHeightLock,
  transactionIdFromHex,
  type AutoExitDeps,
} from "../src/auto-exit.ts";
import {
  buildFanOutTransaction,
  deriveCpfpFundingKey,
  CpfpFundingError,
} from "../src/cpfp-funding.ts";
import type { EsploraUtxo, RecoveryBundle } from "../src/types.ts";

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const KEY = deriveCpfpFundingKey({ seed: SEED, network: "REGTEST", accountNumber: 0 });
const FUNDING_TXID = "ab".repeat(32);

function fundingUtxo(value: bigint) {
  return {
    txid: FUNDING_TXID,
    vout: 0,
    value,
    script: KEY.script,
    publicKey: KEY.publicKey,
  };
}

describe("buildFanOutTransaction", () => {
  it("splits funding into per-leaf outputs and absorbs the remainder in the last one", () => {
    const { txHex, txid, outputs } = buildFanOutTransaction({
      utxos: [fundingUtxo(100_000n)],
      amounts: [30_000n, 40_000n],
      privateKey: KEY.privateKey,
      feeRate: 1,
    });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ txid, vout: 0, value: 30_000n, script: KEY.script });
    // fee = 11 + 68 + 2*31 = 141 vbytes -> 141 sats; remainder goes to the last output
    expect(outputs[1]!.value).toBe(100_000n - 30_000n - 141n);
    const tx = Transaction.fromRaw(hexToBytes(txHex), { allowUnknownOutputs: true });
    expect(tx.id).toBe(txid);
    expect(tx.outputsLength).toBe(2);
    expect(transactionIdFromHex(txHex)).toBe(txid);
  });

  it("rejects underfunded fan-outs with the shortfall in the message", () => {
    expect(() =>
      buildFanOutTransaction({
        utxos: [fundingUtxo(10_000n)],
        amounts: [30_000n, 40_000n],
        privateKey: KEY.privateKey,
        feeRate: 1,
      }),
    ).toThrow(/send \d+ more sats/);
  });

  it("rejects dust outputs", () => {
    expect(() =>
      buildFanOutTransaction({
        utxos: [fundingUtxo(2_000n)],
        amounts: [500n, 800n],
        privateKey: KEY.privateKey,
        feeRate: 1,
      }),
    ).toThrow(CpfpFundingError);
  });
});

describe("relativeHeightLock", () => {
  it("reads a BIP68 height lock and exposes prev-txid candidates", () => {
    // Non-palindromic txid so the byte-reversal candidate differs from the
    // display-order one and the reversal logic is actually exercised.
    const prevTxid = "abcd".repeat(16);
    const reversed = "cdab".repeat(16);
    const tx = new Transaction();
    tx.addInput({
      txid: prevTxid,
      index: 0,
      sequence: 2000,
      witnessUtxo: { script: hexToBytes(KEY.script), amount: 50_000n },
    });
    tx.addOutput({ script: hexToBytes(KEY.script), amount: 49_000n });
    tx.sign(KEY.privateKey);
    tx.finalize();
    const lock = relativeHeightLock(tx.hex);
    expect(lock?.blocks).toBe(2000);
    expect(lock?.prevTxidCandidates).toContain(prevTxid);
    expect(lock?.prevTxidCandidates).toContain(reversed);
  });

  it("returns null when relative locks are disabled", () => {
    const { txHex } = buildFanOutTransaction({
      utxos: [fundingUtxo(100_000n)],
      amounts: [50_000n],
      privateKey: KEY.privateKey,
      feeRate: 1,
    });
    expect(relativeHeightLock(txHex)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orchestrator with a faked chain: leaf chains L1: A1 -> A2 -> R1(refund,
// CSV 2000), L2: B1 -> R2(refund). L3 is uneconomical and must be skipped.
// ---------------------------------------------------------------------------

const BUNDLE = {
  schema: "spark.unilateral-exit-bundle.v1",
  createdAt: "2026-01-01T00:00:00Z",
  network: "REGTEST",
  leaves: [
    { id: "L1", treeNodeHex: "aa", valueSats: 100_000 },
    { id: "L2", treeNodeHex: "bb", valueSats: 50_000 },
    { id: "L3", treeNodeHex: "cc", valueSats: 100 },
  ],
} as unknown as RecoveryBundle;

const CHAINS: Record<string, string[]> = {
  L1: ["tx-A1", "tx-A2", "tx-R1"],
  L2: ["tx-B1", "tx-R2"],
};
const REFUND_PARENT: Record<string, string> = { "tx-R1": "tx-A2", "tx-R2": "tx-B1" };

function makeFakes({ fanOutUtxoCount = 0 }: { fanOutUtxoCount?: number } = {}) {
  const confirmed = new Map<string, number>(); // txid -> height
  const submitted: string[] = [];
  const broadcasts: string[] = [];
  let fannedOut = false;

  const estimate = {
    feeRateSatPerVbyte: 1,
    feeBumpTxCount: 5,
    totalFeeSats: "900",
    bufferSats: "1000",
    requiredSats: "1900",
    valueWeightedExitBlocks: 2003,
    maxExitBlocks: 2003,
    skippedLeafIds: ["L3"],
    perLeaf: [
      { leafId: "L1", feeBumpTxCount: 3, feeSats: "600", valueSats: "100000", sweepFeeSats: "111", netSats: "99289", economical: true, exitWaitBlocks: 2000, worstCaseExitBlocks: 2003 },
      { leafId: "L2", feeBumpTxCount: 2, feeSats: "300", valueSats: "50000", sweepFeeSats: "111", netSats: "49589", economical: true, exitWaitBlocks: 2000, worstCaseExitBlocks: 2002 },
      { leafId: "L3", feeBumpTxCount: 1, feeSats: "300", valueSats: "100", sweepFeeSats: "111", netSats: "-311", economical: false, exitWaitBlocks: 2000, worstCaseExitBlocks: 2001 },
    ],
  };

  const utxoList = (): EsploraUtxo[] => {
    const status = { confirmed: true, block_height: 1 };
    if (fannedOut) {
      return Array.from({ length: fanOutUtxoCount }, (_, i) => ({
        txid: "cd".repeat(32),
        vout: i,
        value: 25_000,
        status,
      }));
    }
    return [{ txid: FUNDING_TXID, vout: 0, value: 50_000, status }];
  };

  const deps: Partial<AutoExitDeps> = {
    estimateFunding: (async () => estimate) as AutoExitDeps["estimateFunding"],
    constructPackages: (async ({ bundle }) => {
      const leafId = bundle.leaves[0]!.id;
      const remaining = (CHAINS[leafId] ?? []).filter((tx) => !confirmed.has(tx));
      return [
        {
          leafId,
          txPackages: remaining.map((tx) => ({ tx, feeBumpPsbt: `psbt-${tx}` })),
        },
      ];
    }) as AutoExitDeps["constructPackages"],
    fetchUtxos: async () => utxoList(),
    fetchTip: async () => 150,
    fetchTx: async (txid) =>
      confirmed.has(txid)
        ? { txid, status: { confirmed: true, block_height: confirmed.get(txid)! } }
        : null,
    submitPkg: async (txs) => {
      const parent = txs[0]!;
      submitted.push(parent);
      confirmed.set(parent, 100); // confirms immediately for the test
      return { package_msg: "success" };
    },
    broadcastTx: async (txHex) => {
      broadcasts.push(txHex);
      fannedOut = true;
      confirmed.set(transactionIdFromHex(txHex), 99);
      return transactionIdFromHex(txHex);
    },
    signChild: (psbt) => `signed-${psbt}`,
    txIdOf: (txHex) => txHex,
    heightLockOf: (txHex) =>
      txHex.startsWith("tx-R")
        ? { blocks: 2000, prevTxidCandidates: [REFUND_PARENT[txHex]!] }
        : null,
    sleep: async () => {},
  };
  return { deps, submitted, broadcasts, confirmed };
}

describe("autoExit", () => {
  it("sequentially drains leaf chains, skips uneconomical leaves, and defers refunds", async () => {
    const { deps, submitted, broadcasts } = makeFakes();
    const events: string[] = [];
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps,
      onEvent: (m) => events.push(m),
    });

    // Single funding UTXO, no fan-out: L1 (larger fees) drains first, then L2.
    expect(submitted).toEqual(["tx-A1", "tx-A2", "tx-B1"]);
    expect(broadcasts).toHaveLength(0);

    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "waiting-timelock",
      maturityHeight: 2100,
      refundTxid: "tx-R1",
    });
    expect(byId.get("L2")).toMatchObject({ status: "waiting-timelock", refundTxid: "tx-R2" });
    expect(byId.get("L3")?.status).toBe("skipped-uneconomical");
    expect(result.earliestMaturityHeight).toBe(2100);
    expect(result.packages.map((p) => p.txPackages?.[0]?.tx).sort()).toEqual([
      "tx-R1",
      "tx-R2",
    ]);
  });

  it("fans out once when enabled and then broadcasts leaves in parallel rounds", async () => {
    const { deps, submitted, broadcasts } = makeFakes({ fanOutUtxoCount: 2 });
    await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      fanOut: true,
      deps,
    });
    expect(broadcasts).toHaveLength(1);
    // Both leaves progress in the same round once each has its own UTXO.
    expect(submitted.slice(0, 2).sort()).toEqual(["tx-A1", "tx-B1"]);
    expect(submitted).toContain("tx-A2");
  });

  it("resumes from chain state: already-confirmed packages are never resubmitted", async () => {
    const { deps, submitted, confirmed } = makeFakes();
    confirmed.set("tx-A1", 90);
    confirmed.set("tx-A2", 95);
    await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps,
    });
    expect(submitted).toEqual(["tx-B1"]);
  });

  it("recovers when a submitted package is evicted from the mempool", async () => {
    const { deps, submitted, confirmed } = makeFakes();
    // First submission of tx-A1 is "accepted" but never appears anywhere
    // (evicted); the retry sticks.
    let evictions = 1;
    const submitPkg: AutoExitDeps["submitPkg"] = async (txs) => {
      const parent = txs[0]!;
      submitted.push(parent);
      if (parent === "tx-A1" && evictions > 0) {
        evictions -= 1; // vanish: not confirmed, not in mempool
      } else {
        confirmed.set(parent, 100);
      }
      return { package_msg: "success" };
    };
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: { ...deps, submitPkg },
    });
    // tx-A1 was submitted twice: once evicted, once confirmed; the run still
    // completes every chain.
    expect(submitted.filter((t) => t === "tx-A1")).toHaveLength(2);
    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")?.status).toBe("waiting-timelock");
  });

  it("exits mature refunds instead of deferring them", async () => {
    const { deps, submitted } = makeFakes();
    const fetchTip: AutoExitDeps["fetchTip"] = async () => 2_200; // past maturity 2100
    await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: { ...deps, fetchTip },
    });
    expect(submitted).toEqual(["tx-A1", "tx-A2", "tx-R1", "tx-B1", "tx-R2"]);
  });
});
