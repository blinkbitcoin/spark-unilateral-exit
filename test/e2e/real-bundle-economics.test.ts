import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { parseRecoveryBundle } from "../../src/bundle.ts";
import {
  deriveCpfpFundingKey,
  estimateCpfpFunding,
} from "../../src/cpfp-funding.ts";

// Economics validation against a real recovery bundle (not committed: bundles
// reveal wallet graph metadata). Point SPARK_REAL_BUNDLE at an exported
// bundle, or keep one at ../recovery-bundle.json next to the repo checkout.
// The bundle is adapted to REGTEST so the run never touches mainnet services;
// the SDK's broadcast-status probe fails closed (treats txs as unbroadcast),
// which is exactly the offline-recovery shape we want to measure.
const repoRoot = new URL("../..", import.meta.url).pathname;
const bundlePath =
  process.env.SPARK_REAL_BUNDLE ?? path.resolve(repoRoot, "../recovery-bundle.json");
const haveBundle = fs.existsSync(bundlePath);

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FEE_RATE = 1;

describe.skipIf(!haveBundle)("real-bundle economics (regtest-adapted)", () => {
  it(
    "classifies each leaf by value vs CPFP + sweep fees and prices only economical leaves",
    { timeout: 300_000 },
    async () => {
      const bundle = {
        ...parseRecoveryBundle(fs.readFileSync(bundlePath, "utf8")),
        network: "REGTEST",
      };
      const key = deriveCpfpFundingKey({ seed: SEED, network: "REGTEST" });

      const estimate = await estimateCpfpFunding({
        bundle,
        feeRate: FEE_RATE,
        fundingScript: key.script,
        fundingPublicKey: key.publicKey,
      });

      expect(estimate.perLeaf).toHaveLength(bundle.leaves.length);

      let economicalFees = 0n;
      let economicalCount = 0;
      for (const leaf of estimate.perLeaf) {
        expect(leaf.valueSats, `leaf ${leaf.leafId} has no value`).not.toBeNull();
        const value = BigInt(leaf.valueSats!);
        const fee = BigInt(leaf.feeSats);
        const sweepFee = BigInt(leaf.sweepFeeSats);
        expect(fee).toBeGreaterThan(0n);
        // netSats must be exactly value - CPFP fees - sweep fee ...
        expect(BigInt(leaf.netSats!)).toBe(value - fee - sweepFee);
        // ... and the classification must follow from it.
        expect(leaf.economical).toBe(BigInt(leaf.netSats!) > 0n);
        if (leaf.economical) {
          economicalFees += fee;
          economicalCount += 1;
        }
      }

      // requiredSats prices economical leaves only (plus the buffer).
      expect(BigInt(estimate.requiredSats)).toBe(
        economicalFees + BigInt(estimate.bufferSats),
      );
      expect(estimate.skippedLeafIds).toHaveLength(
        bundle.leaves.length - economicalCount,
      );

      // Including uneconomical leaves must never lower the funding requirement.
      const withUneconomical = await estimateCpfpFunding({
        bundle,
        feeRate: FEE_RATE,
        fundingScript: key.script,
        fundingPublicKey: key.publicKey,
        includeUneconomical: true,
      });
      expect(withUneconomical.skippedLeafIds).toHaveLength(0);
      expect(BigInt(withUneconomical.requiredSats)).toBeGreaterThanOrEqual(
        BigInt(estimate.requiredSats),
      );

      // A prohibitive net requirement classifies every leaf uneconomical.
      const prohibitive = await estimateCpfpFunding({
        bundle,
        feeRate: FEE_RATE,
        fundingScript: key.script,
        fundingPublicKey: key.publicKey,
        minNetSats: 10_000_000_000n,
      });
      expect(prohibitive.perLeaf.every((l) => !l.economical)).toBe(true);
      expect(BigInt(prohibitive.requiredSats)).toBe(BigInt(prohibitive.bufferSats));

      console.error(
        `[economics] ${economicalCount}/${bundle.leaves.length} leaves economical at ${FEE_RATE} sat/vB; ` +
          `funding required ${estimate.requiredSats} sats (vs ${withUneconomical.requiredSats} with uneconomical leaves)`,
      );
    },
  );
});
