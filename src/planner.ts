import { parseCpfpUtxo } from "./cpfp.ts";
import type { CliArgValue, RecoveryBundle, UsdbBalance } from "./types.ts";

export class RecoveryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryPlanError";
  }
}

interface CreateRecoveryPlanOptions {
  bundle: RecoveryBundle;
  destination: string;
  feeRate: number;
  cpfpUtxos: string[];
}

export function createRecoveryPlan({
  bundle,
  destination,
  feeRate,
  cpfpUtxos,
}: CreateRecoveryPlanOptions) {
  validateDestination(destination);
  validateFeeRate(feeRate);

  const parsedUtxos = cpfpUtxos.map(parseCpfpUtxo);
  if (parsedUtxos.length === 0) {
    throw new RecoveryPlanError("At least one CPFP UTXO is required");
  }

  const totalLeafSats = bundle.leaves.reduce(
    (sum, leaf) => sum + BigInt(leaf.valueSats ?? 0),
    0n,
  );

  return {
    mode: "bundle",
    network: bundle.network,
    bundleCreatedAt: bundle.createdAt,
    destination,
    feeRateSatPerVbyte: feeRate,
    leafCount: bundle.leaves.length,
    estimatedRecoverableBtcSats: totalLeafSats.toString(),
    cpfpUtxoCount: parsedUtxos.length,
    usdb: describeUsdb(bundle.balances?.usdb),
    steps: [
      "Validate bundle metadata against restored wallet identity.",
      "Construct unilateral-exit transaction packages from saved TreeNode protobufs.",
      "Sign CPFP fee-bump PSBTs with the external funding key.",
      "Broadcast packages in root-to-leaf order.",
      "Wait for refund timelocks and confirmations.",
      "Sweep spendable refund outputs to the destination address.",
    ],
  };
}

export function assertSeedOnlyIsNotOfflineRecoverable({
  seed,
  bundle,
}: {
  seed: CliArgValue;
  bundle: RecoveryBundle | null | undefined;
}) {
  if (seed && !bundle) {
    throw new RecoveryPlanError(
      "Seed-only recovery cannot discover Spark leaves while operators are offline. Provide the latest saved recovery bundle.",
    );
  }
}

function validateDestination(destination: string) {
  if (typeof destination !== "string" || destination.trim().length < 14) {
    throw new RecoveryPlanError("Destination Bitcoin address is required");
  }
}

function validateFeeRate(feeRate: number) {
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new RecoveryPlanError("Fee rate must be a positive number");
  }
}

function describeUsdb(usdb: UsdbBalance | undefined) {
  if (!usdb) {
    return {
      detected: false,
      status: "no-usdb-metadata-in-bundle",
    };
  }

  return {
    detected: true,
    amount: usdb.amount ?? "unknown",
    status:
      usdb.status ??
      "detected-but-not-covered-by-bitcoin-unilateral-exit",
  };
}
