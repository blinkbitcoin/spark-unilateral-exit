import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classifyTx, csvRelativeBlocks, txStructure } from "../../src/webapp/exit-detector.ts";

// Ground truth captured from a real unilateral exit on the local Spark
// regtest stack by scripts/capture-regtest-exit.ts. The capture is gitignored
// (wallet graph metadata), so this suite self-skips without it.
const capturePath = path.join(import.meta.dirname, "..", "fixtures", "webapp", "exit-capture.json");
const hasCapture = fs.existsSync(capturePath);

interface CapturedTx {
  txid: string;
  txHex: string;
  labels: string[];
  broadcast: boolean;
}

const expectedStage: Record<string, import("../../src/webapp/exit-detector.ts").ExitStage> = {
  "cpfp-funding": "unknown", // ordinary wallet tx; watchlist-only
  "static-deposit": "static-deposit", // via family seed only
  "node-tx": "node-tx",
  "refund-tx": "refund-tx",
  "cpfp-bump-child": "cpfp-bump-child",
  sweep: "sweep-tx",
};

describe.skipIf(!hasCapture)("regtest ground-truth capture", () => {
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
    txs: CapturedTx[];
  };
  const structures = new Map(capture.txs.map((t) => [t.txid, txStructure(t.txHex)]));
  const txByTxid = new Map(capture.txs.map((t) => [t.txid, t]));

  it("classifies every captured exit-chain tx to its true stage", () => {
    for (const t of capture.txs) {
      const expected = expectedStage[t.labels[0]!];
      if (!expected) continue;
      const first = structures.get(t.txid)!.inputs[0];
      const parentT = first ? txByTxid.get(first.txid) : undefined;
      const parent = parentT ? structures.get(parentT.txid) : undefined;
      const spendsAnchor = parent
        ? parent.outputs[first?.vout ?? 0]?.isAnchor === true
        : false;
      const c = classifyTx(t.txHex, {
        parentStage:
          t.labels[0] === "static-deposit"
            ? "static-deposit"
            : parentT
              ? expectedStage[parentT.labels[0]!]
              : undefined,
        spendsAnchor,
      });
      expect(c.stage, `${t.labels[0]} ${t.txid}: ${c.reason}`).toBe(expected);
    }
  });

  it("marks family-confirmed stages high confidence", () => {
    const nodeTx = capture.txs.find((t) => t.labels[0] === "node-tx")!;
    const c = classifyTx(nodeTx.txHex, { parentStage: "static-deposit" });
    expect(c.stage).toBe("node-tx");
    expect(c.confidence).toBe("high");

    const refundTx = capture.txs.find((t) => t.labels[0] === "refund-tx")!;
    const r = classifyTx(refundTx.txHex, { parentStage: "node-tx" });
    expect(r.stage).toBe("refund-tx");
    expect(r.confidence).toBe("high");

    const sweepTx = capture.txs.find((t) => t.labels[0] === "sweep")!;
    const s = classifyTx(sweepTx.txHex, { parentStage: "refund-tx" });
    expect(s.stage).toBe("sweep-tx");
    expect(s.confidence).toBe("high");
  });

  it("reads the CSV relative lock off the refund", () => {
    const refundTx = capture.txs.find((t) => t.labels[0] === "refund-tx")!;
    const c = classifyTx(refundTx.txHex, { parentStage: "node-tx" });
    expect(c.csvBlocks).toBe(2000); // local stack config; read, not assumed
  });

  it("computes refund maturity from parent height", () => {
    const refundTx = capture.txs.find((t) => t.labels[0] === "refund-tx")!;
    const c = classifyTx(refundTx.txHex, {
      parentStage: "node-tx",
      parentConfirmedHeight: 100,
    });
    expect(c.maturityHeight).toBe(100 + 2000 + 1);
  });

  it("treats ordinary wallet txs as unknown without a watchlist", () => {
    const funding = capture.txs.find((t) => t.labels[0] === "cpfp-funding")!;
    const c = classifyTx(funding.txHex);
    expect(c.stage).toBe("unknown");
    expect(c.confidence).toBe("low");
  });
});

describe("exit detector units", () => {
  it("returns null for lock-disabling sequences", () => {
    expect(csvRelativeBlocks(0xfffffffd)).toBeNull();
    expect(csvRelativeBlocks(0x400001)).toBeNull();
    expect(csvRelativeBlocks(0x00)).toBeNull();
    expect(csvRelativeBlocks(0x7d0)).toBe(2000);
  });
});
