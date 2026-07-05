import { describe, expect, it } from "vitest";

import {
  RecoveryPlanError,
  assertSeedOnlyIsNotOfflineRecoverable,
  createRecoveryPlan,
} from "../src/planner.ts";

const bundle = {
  schema: "spark.unilateral-exit-bundle.v1",
  createdAt: "2026-06-15T00:00:00.000Z",
  network: "LOCAL",
  leaves: [
    { id: "leaf-a", treeNodeHex: "00", valueSats: 1000 },
    { id: "leaf-b", treeNodeHex: "00", valueSats: 2000 },
  ],
  balances: {
    usdb: { amount: "12.34" },
  },
};

describe("recovery planning", () => {
  it("plans bundle-based recovery and flags USDB as not covered", () => {
    const plan = createRecoveryPlan({
      bundle,
      destination: "bc1qexampledestination",
      feeRate: 10,
      cpfpUtxos: [`${"ab".repeat(32)}:0:50000:0014abcd:02abcd`],
    });

    expect(plan.leafCount).toBe(2);
    expect(plan.estimatedRecoverableBtcSats).toBe("3000");
    expect(plan.usdb).toMatchObject({
      detected: true,
      amount: "12.34",
      status: "detected-but-not-covered-by-bitcoin-unilateral-exit",
    });
  });

  it("fails closed for seed-only offline recovery", () => {
    expect(() =>
      assertSeedOnlyIsNotOfflineRecoverable({
        seed: "never-log-real-seeds-here",
        bundle: null,
      }),
    ).toThrow(RecoveryPlanError);
  });

  it("requires a plausible destination", () => {
    expect(() =>
      createRecoveryPlan({
        bundle,
        destination: "",
        feeRate: 10,
        cpfpUtxos: [`${"ab".repeat(32)}:0:50000:0014abcd:02abcd`],
      }),
    ).toThrow(/Destination/);
  });

  it("requires a positive fee rate", () => {
    expect(() =>
      createRecoveryPlan({
        bundle,
        destination: "bc1qexampledestination",
        feeRate: 0,
        cpfpUtxos: [`${"ab".repeat(32)}:0:50000:0014abcd:02abcd`],
      }),
    ).toThrow(/Fee rate/);
  });

  it("requires CPFP UTXOs", () => {
    expect(() =>
      createRecoveryPlan({
        bundle,
        destination: "bc1qexampledestination",
        feeRate: 10,
        cpfpUtxos: [],
      }),
    ).toThrow(/CPFP/);
  });
});
