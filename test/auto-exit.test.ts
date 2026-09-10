import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/curves/utils";
import { p2tr, Transaction } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  autoExit,
  firstInputOutpoint,
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

describe("firstInputOutpoint", () => {
  it("reads the first input's outpoint from a real transaction with both byte orders", () => {
    // Non-palindromic txid so the byte-reversal candidate differs from the
    // display-order one; non-zero vout so the index is actually read.
    const prevTxid = "abcd".repeat(16);
    const reversed = "cdab".repeat(16);
    const tx = new Transaction();
    tx.addInput({
      txid: prevTxid,
      index: 3,
      sequence: 2000,
      witnessUtxo: { script: hexToBytes(KEY.script), amount: 50_000n },
    });
    tx.addOutput({ script: hexToBytes(KEY.script), amount: 49_000n });
    tx.sign(KEY.privateKey);
    tx.finalize();

    const outpoint = firstInputOutpoint(tx.hex);
    expect(outpoint?.vout).toBe(3);
    expect(outpoint?.txidCandidates).toHaveLength(2);
    // The display-order txid the wallet knows must be among the candidates,
    // whatever order the raw serialization stores.
    expect(outpoint?.txidCandidates).toContain(prevTxid);
    expect(outpoint?.txidCandidates).toContain(reversed);
    // Same candidate handling as relativeHeightLock, so an Esplora probe that
    // resolves one resolves the other.
    const lock = relativeHeightLock(tx.hex);
    expect(lock?.prevTxidCandidates).toEqual(outpoint?.txidCandidates);
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
    skippedLeafIds: ["L3"],
    perLeaf: [
      { leafId: "L1", feeBumpTxCount: 3, feeSats: "600", valueSats: "100000", sweepFeeSats: "111", netSats: "99289", economical: true },
      { leafId: "L2", feeBumpTxCount: 2, feeSats: "300", valueSats: "50000", sweepFeeSats: "111", netSats: "49589", economical: true },
      { leafId: "L3", feeBumpTxCount: 1, feeSats: "300", valueSats: "100", sweepFeeSats: "111", netSats: "-311", economical: false },
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
      // Mirrors the real constructSparkPackages contract: it keeps returning a
      // leaf's not-yet-confirmed transactions — INCLUDING the refund — until they
      // land on chain. The SDK alone drops the refund once the node is broadcast;
      // constructSparkPackages re-attaches it (see reattachPendingRefunds), which
      // is what makes this "refund stays in the list until confirmed" behavior real.
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

  it("preserves the exact alternate refund transaction for sweep", async () => {
    const { deps, submitted } = makeFakes();
    const constructPackages = deps.constructPackages!;
    const events: string[] = [];
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: {
        ...deps,
        constructPackages: (async (options) =>
          options.bundle.leaves[0]!.id === "L1"
            ? [{ leafId: "L1", txPackages: [], sweepTx: "tx-direct-refund-L1" }]
            : constructPackages(options)) as AutoExitDeps["constructPackages"],
      },
      onEvent: (message) => events.push(message),
    });

    expect(submitted).toEqual(["tx-B1"]);
    expect(result.leaves.find((leaf) => leaf.leafId === "L1")).toMatchObject({
      status: "exit-broadcast",
      refundTxid: "tx-direct-refund-L1",
    });
    expect(result.packages).toContainEqual({
      leafId: "L1",
      txPackages: [{ tx: "tx-direct-refund-L1" }],
    });
    expect(events).toContain(
      "Leaf L1: refund variant already broadcast (tx-direct-refund-L1); ready to sweep",
    );
  });

  // The operator ships directTx / directRefundTx / directFromCpfpRefundTx
  // unsigned, so a completed alternate refund reaches autoExit as an unsigned
  // transaction. The fakes above stub txIdOf as the identity function, which is
  // why the rest of this suite never exercised the real one; this test drives
  // the production txIdOf so the "Transaction is not finalized" throw stays fixed.
  it("recognizes a completed refund the operator left unsigned", async () => {
    const { deps, submitted } = makeFakes();
    const refund = unsignedRefundTx(10_000n);
    const events: string[] = [];

    // Only L1: the other leaves' fake chains use placeholder txids that are not
    // real transaction hex, and this test deliberately runs the production txIdOf.
    const result = await autoExit({
      bundle: {
        ...BUNDLE,
        leaves: BUNDLE.leaves.filter((leaf) => leaf.id === "L1"),
      } as unknown as RecoveryBundle,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: {
        ...deps,
        txIdOf: transactionIdFromHex,
        constructPackages: (async () => [
          { leafId: "L1", txPackages: [], sweepTx: refund.hex },
        ]) as AutoExitDeps["constructPackages"],
      },
      onEvent: (message) => events.push(message),
    });

    expect(submitted).toEqual([]);
    expect(result.leaves.find((leaf) => leaf.leafId === "L1")).toMatchObject({
      status: "exit-broadcast",
      // The txid the refund will still have once it is signed.
      refundTxid: refund.signedTxid,
    });
    expect(result.packages).toContainEqual({
      leafId: "L1",
      txPackages: [{ tx: refund.hex }],
    });
    expect(events).toContain(
      `Leaf L1: refund variant already broadcast (${refund.signedTxid}); ready to sweep`,
    );
  });

  it("reconciles multiple completed refunds in one round with one funding UTXO", async () => {
    const { deps, submitted } = makeFakes();
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: {
        ...deps,
        constructPackages: (async ({ bundle }) => {
          const leafId = bundle.leaves[0]!.id;
          return [
            { leafId, txPackages: [], sweepTx: `tx-direct-refund-${leafId}` },
          ];
        }) as AutoExitDeps["constructPackages"],
      },
    });

    expect(submitted).toEqual([]);
    expect(result.rounds).toBe(1);
    expect(result.packages.map((pkg) => pkg.txPackages?.[0]?.tx).sort()).toEqual([
      "tx-direct-refund-L1",
      "tx-direct-refund-L2",
    ]);
  });

  it("retries transient funding and tip fetch failures", async () => {
    const { deps } = makeFakes();
    const fetchUtxos = deps.fetchUtxos!;
    const fetchTip = deps.fetchTip!;
    let fundingFailures = 1;
    let tipFailures = 1;
    const events: string[] = [];
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: {
        ...deps,
        fetchUtxos: async (...args) => {
          if (fundingFailures-- > 0) throw new Error("fetch failed");
          return fetchUtxos(...args);
        },
        fetchTip: async (...args) => {
          if (tipFailures-- > 0) throw new Error("fetch failed");
          return fetchTip(...args);
        },
      },
      onEvent: (message) => events.push(message),
    });

    expect(result.leaves.find((leaf) => leaf.leafId === "L1")?.status).toBe(
      "waiting-timelock",
    );
    expect(events.some((event) => event.includes("funding fetch failed"))).toBe(true);
    expect(events.some((event) => event.includes("tip fetch failed"))).toBe(true);
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

// ---------------------------------------------------------------------------
// Direct-path race: the operator chainwatcher can complete a leaf's exit with
// the TreeNode's self-fee-paying direct transactions, which spend the same
// output as the bundle's CPFP node txs. Once that happens the CPFP chain is
// permanently invalid and every package submission fails
// bad-txns-inputs-missingorspent. These tests pin the pivot: recognize the
// spend, track the direct refund, and never loop on the dead package.
//
// Scenario: L1's head tx-A1 spends parent-A0:0, which the operator's tx-D1
// (confirmed at height 100) already took; tx-DR1 is the direct refund,
// CSV 550 after tx-D1, so it matures at height 650.
// ---------------------------------------------------------------------------

describe("autoExit direct-path race", () => {
  function makeRaceFakes({
    tip = 150,
    spender = "tx-D1",
    directRefundOnChain = false,
  }: { tip?: number; spender?: string; directRefundOnChain?: boolean } = {}) {
    const { deps, submitted, confirmed } = makeFakes();
    const broadcasts: string[] = [];
    confirmed.set("tx-D1", 100);
    if (directRefundOnChain) confirmed.set("tx-DR1", 120);
    const raceDeps: Partial<AutoExitDeps> = {
      ...deps,
      submitPkg: async (txs) => {
        const parent = txs[0]!;
        if (parent.startsWith("tx-A")) {
          throw new Error(
            'Package rejected by the node ("transaction failed": tx-A1: bad-txns-inputs-missingorspent)',
          );
        }
        submitted.push(parent);
        confirmed.set(parent, 100);
        return { package_msg: "success" };
      },
      broadcastTx: async (txHex) => {
        broadcasts.push(txHex);
        confirmed.set(txHex, 130);
        return txHex;
      },
      fetchTip: async () => tip,
      fetchOutspend: async (txid, vout) =>
        txid === "parent-A0" && vout === 0
          ? {
              spent: true,
              txid: spender,
              status: { confirmed: true, block_height: 100 },
            }
          : null,
      inputOutpointOf: (txHex) =>
        txHex === "tx-A1" ? { txidCandidates: ["parent-A0"], vout: 0 } : null,
      directPathOf: (treeNodeHex) =>
        treeNodeHex === "aa"
          ? {
              directTxid: "tx-D1",
              directRefundTxHex: "tx-DR1",
              directRefundTxid: "tx-DR1",
            }
          : null,
      heightLockOf: (txHex) =>
        txHex === "tx-DR1"
          ? { blocks: 550, prevTxidCandidates: ["tx-D1"] }
          : deps.heightLockOf!(txHex),
    };
    return { deps: raceDeps, submitted, broadcasts, confirmed };
  }

  it("pivots to the timelocked direct refund instead of looping on the dead package", async () => {
    const { deps, submitted, broadcasts } = makeRaceFakes();
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps,
    });

    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "waiting-timelock",
      maturityHeight: 650,
      refundTxid: "tx-DR1",
    });
    // The dead CPFP chain was never submitted; the untouched leaf proceeded.
    expect(submitted).toEqual(["tx-B1"]);
    expect(broadcasts).toHaveLength(0);
    // The sweep-compatible packages file points at the direct refund.
    expect(
      result.packages.find((p) => p.leafId === "L1")?.txPackages?.[0]?.tx,
    ).toBe("tx-DR1");
    expect(result.earliestMaturityHeight).toBe(650);
  });

  it("broadcasts the mature direct refund plainly (self-paying, no package)", async () => {
    const { deps, broadcasts } = makeRaceFakes({ tip: 2_200 });
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps,
    });

    expect(broadcasts).toEqual(["tx-DR1"]);
    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "exit-broadcast",
      refundTxid: "tx-DR1",
    });
    expect(byId.get("L2")?.status).toBe("exit-broadcast");
  });

  it("reports completion when the direct refund is already on chain", async () => {
    const { deps, broadcasts } = makeRaceFakes({ directRefundOnChain: true });
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps,
    });

    expect(broadcasts).toHaveLength(0);
    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "exit-broadcast",
      refundTxid: "tx-DR1",
    });
  });

  it("fails the leaf loudly when the node input was spent by an unknown transaction", async () => {
    const { deps, broadcasts } = makeRaceFakes({ spender: "tx-EVIL" });
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

    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")?.status).toBe("failed");
    expect(byId.get("L1")?.lastError).toContain("tx-EVIL");
    expect(events.some((e) => e.includes("tx-EVIL"))).toBe(true);
    expect(broadcasts).toHaveLength(0);
    // The unaffected leaf still completes.
    expect(byId.get("L2")?.status).toBe("waiting-timelock");
  });

  it("still defers an ordinary unconfirmed-dependency rejection", async () => {
    const { deps, submitted, confirmed } = makeFakes();
    let failures = 1;
    const raceDeps: Partial<AutoExitDeps> = {
      ...deps,
      submitPkg: async (txs) => {
        const parent = txs[0]!;
        if (parent === "tx-A1" && failures > 0) {
          failures -= 1;
          throw new Error(
            'Package rejected by the node ("transaction failed": tx-A1: bad-txns-inputs-missingorspent)',
          );
        }
        submitted.push(parent);
        confirmed.set(parent, 100);
        return { package_msg: "success" };
      },
      // The outpoint exists but is unspent: the parent is just not confirmed
      // yet, so the leaf must defer and retry, not pivot or fail.
      fetchOutspend: async () => ({ spent: false }),
      inputOutpointOf: (txHex) =>
        txHex === "tx-A1" ? { txidCandidates: ["parent-A0"], vout: 0 } : null,
      directPathOf: (treeNodeHex) =>
        treeNodeHex === "aa"
          ? {
              directTxid: "tx-D1",
              directRefundTxHex: "tx-DR1",
              directRefundTxid: "tx-DR1",
            }
          : null,
    };
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: raceDeps,
    });

    // The retry after the transient rejection sticks and the chain drains.
    expect(submitted).toEqual(["tx-A1", "tx-A2", "tx-B1"]);
    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")?.status).toBe("waiting-timelock");
  });

  it("counts a failure when every outspend lookup errors instead of waiting forever", async () => {
    const { deps } = makeRaceFakes();
    const raceDeps: Partial<AutoExitDeps> = {
      ...deps,
      // Esplora is unreachable for both byte-order candidates: chain state is
      // unknown, so the leaf must accumulate failures and give up, not defer
      // as if the outpoint were merely unspent.
      fetchOutspend: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      inputOutpointOf: (txHex) =>
        txHex === "tx-A1"
          ? { txidCandidates: ["parent-A0", "parent-A0-rev"], vout: 0 }
          : null,
    };
    const events: string[] = [];
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: raceDeps,
      onEvent: (m) => events.push(m),
    });

    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")?.status).toBe("failed");
    expect(byId.get("L1")?.lastError).toContain("direct-path check failed");
    expect(byId.get("L1")?.lastError).toContain("ECONNREFUSED");
    expect(byId.get("L1")?.failureCount).toBe(5);
    expect(events.some((e) => e.includes("direct-path check failed"))).toBe(true);
    // The unaffected leaf still completes.
    expect(byId.get("L2")?.status).toBe("waiting-timelock");
  });

  it("resolves via the second byte-order candidate when the first is unknown", async () => {
    const { deps, submitted, broadcasts } = makeRaceFakes();
    const lookups: string[] = [];
    const raceDeps: Partial<AutoExitDeps> = {
      ...deps,
      // First candidate 404s (wrong byte order); the second answers. The
      // pivot must proceed exactly as if the first candidate had matched.
      fetchOutspend: async (txid, vout) => {
        lookups.push(txid);
        if (txid === "parent-A0-wrong-order") return null;
        return txid === "parent-A0" && vout === 0
          ? {
              spent: true,
              txid: "tx-D1",
              status: { confirmed: true, block_height: 100 },
            }
          : null;
      },
      inputOutpointOf: (txHex) =>
        txHex === "tx-A1"
          ? { txidCandidates: ["parent-A0-wrong-order", "parent-A0"], vout: 0 }
          : null,
    };
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: raceDeps,
    });

    expect(lookups).toContain("parent-A0-wrong-order");
    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "waiting-timelock",
      maturityHeight: 650,
      refundTxid: "tx-DR1",
    });
    expect(submitted).toEqual(["tx-B1"]);
    expect(broadcasts).toHaveLength(0);
  });

  it("still resolves when the first candidate errors but the second answers", async () => {
    const { deps } = makeRaceFakes();
    const raceDeps: Partial<AutoExitDeps> = {
      ...deps,
      // A definitive answer from either candidate outweighs a retained
      // lookup error from the other.
      fetchOutspend: async (txid, vout) => {
        if (txid === "parent-A0-flaky") throw new Error("HTTP 502");
        return txid === "parent-A0" && vout === 0
          ? {
              spent: true,
              txid: "tx-D1",
              status: { confirmed: true, block_height: 100 },
            }
          : null;
      },
      inputOutpointOf: (txHex) =>
        txHex === "tx-A1"
          ? { txidCandidates: ["parent-A0-flaky", "parent-A0"], vout: 0 }
          : null,
    };
    const events: string[] = [];
    const result = await autoExit({
      bundle: BUNDLE,
      seed: SEED,
      network: "REGTEST",
      feeRate: 1,
      esploraUrl: "http://localhost/api",
      deps: raceDeps,
      onEvent: (m) => events.push(m),
    });

    const byId = new Map(result.leaves.map((l) => [l.leafId, l]));
    expect(byId.get("L1")).toMatchObject({
      status: "waiting-timelock",
      refundTxid: "tx-DR1",
    });
    expect(events.some((e) => e.includes("direct-path check failed"))).toBe(false);
  });
});

// A refund exactly as the operator exports it: serialized before anyone signs it,
// paired with the txid it will still carry after signing (segwit txids do not
// commit to the witness).
function unsignedRefundTx(amount: bigint): { hex: string; signedTxid: string } {
  const privateKey = new Uint8Array(32).fill(4);
  const xonly = secp256k1.getPublicKey(privateKey, true).slice(1);
  const output = p2tr(xonly);
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: "22".repeat(32),
    index: 0,
    witnessUtxo: { amount: amount + 1_000n, script: output.script },
    tapInternalKey: xonly,
  });
  tx.addOutput({ script: output.script, amount });
  const hex = tx.hex;
  tx.sign(privateKey);
  tx.finalize();
  return { hex, signedTxid: tx.id };
}
