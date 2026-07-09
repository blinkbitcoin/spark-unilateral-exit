import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { parseRecoveryBundle } from "../../src/bundle.ts";
import { planLeafConsolidation } from "../../src/consolidate.ts";
import {
  deriveCpfpFundingKey,
  estimateCpfpFunding,
} from "../../src/cpfp-funding.ts";

// Consolidation planning against a real recovery bundle: measures how much
// value is stranded in uneconomical leaves today versus after swapping the
// leaf set into the greedy power-of-two denominations that `consolidate`
// (SparkWallet.optimizeLeaves(0)) targets. Point SPARK_REAL_BUNDLE at an
// exported bundle, or keep one at ../recovery-bundle.json next to the repo
// checkout. Like the economics test, the bundle is adapted to REGTEST so the
// run never touches mainnet services; consolidation itself is NOT executed
// here (that requires the live wallet seed - use `make consolidate`).
const repoRoot = new URL("../..", import.meta.url).pathname;
const bundlePath =
  process.env.SPARK_REAL_BUNDLE ?? path.resolve(repoRoot, "../recovery-bundle.json");
const haveBundle = fs.existsSync(bundlePath);

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FEE_RATE = 1;

describe.skipIf(!haveBundle)("real-bundle consolidation plan (regtest-adapted)", () => {
  it(
    "consolidating to the greedy denomination set bounds the value stranded in uneconomical leaves",
    { timeout: 300_000 },
    async () => {
      const bundle = {
        ...parseRecoveryBundle(fs.readFileSync(bundlePath, "utf8")),
        network: "REGTEST",
      };
      const values = bundle.leaves.map((leaf) => {
        expect(leaf.valueSats, `leaf ${leaf.id} has no value`).toBeDefined();
        return leaf.valueSats!;
      });

      // The plan the consolidate command would drive the SDK toward.
      const plan = planLeafConsolidation(values);
      expect(plan.totalSats).toBe(values.reduce((a, b) => a + b, 0));
      for (const value of plan.targetValues) {
        expect(Math.log2(value) % 1, `${value} is not a power of two`).toBe(0);
      }

      // Real per-leaf exit costs (CPFP fee chain + sweep) from the bundle.
      const key = deriveCpfpFundingKey({ seed: SEED, network: "REGTEST" });
      const estimate = await estimateCpfpFunding({
        bundle,
        feeRate: FEE_RATE,
        fundingScript: key.script,
        fundingPublicKey: key.publicKey,
        includeUneconomical: true,
      });
      const costs = estimate.perLeaf.map(
        (leaf) => Number(leaf.feeSats) + Number(leaf.sweepFeeSats),
      );
      // Post-consolidation leaves do not exist yet, so price them at the most
      // expensive observed leaf: an upper bound on what a fresh leaf costs.
      const maxCost = Math.max(...costs);
      expect(maxCost).toBeGreaterThan(0);

      const strandedBefore = estimate.perLeaf
        .filter((leaf) => !(BigInt(leaf.netSats!) > 0n))
        .reduce((sum, leaf) => sum + Number(leaf.valueSats), 0);
      const uneconomicalBefore = estimate.perLeaf.filter(
        (leaf) => !(BigInt(leaf.netSats!) > 0n),
      ).length;

      const strandedAfterValues = plan.targetValues.filter(
        (value) => value <= maxCost,
      );
      const strandedAfter = strandedAfterValues.reduce((a, b) => a + b, 0);

      // Greedy denominations repeat only at the top (2^27), so every stranded
      // leaf is a distinct power of two <= maxCost: their sum is < 2 * maxCost
      // no matter how fragmented the wallet was. This is the property that
      // makes consolidation reduce uneconomical exits.
      expect(strandedAfter).toBeLessThan(2 * maxCost);

      // When today's stranded value exceeds that ceiling, consolidation is a
      // strict improvement on this bundle.
      if (strandedBefore >= 2 * maxCost) {
        expect(strandedAfter).toBeLessThan(strandedBefore);
      }

      console.error(
        `[consolidate] ${plan.currentLeafCount} leaves -> ${plan.targetLeafCount} ` +
          `(${plan.totalSats} sats total); uneconomical at ${FEE_RATE} sat/vB: ` +
          `${uneconomicalBefore} leaves stranding ${strandedBefore} sats now vs ` +
          `${strandedAfterValues.length} leaves stranding ${strandedAfter} sats after ` +
          `consolidation (per-leaf exit cost up to ${maxCost} sats); ` +
          `needsSwap=${plan.needsSwap}`,
      );
    },
  );
});
