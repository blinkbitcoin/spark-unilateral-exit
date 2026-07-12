// Recovery-bundle export: a snapshot of the wallet's Spark leaves and their
// full ancestor transaction chains, fetched straight from the Spark operators
// while they are online. This is the only data (besides the seed) a
// unilateral exit needs, and it cannot be reconstructed from the seed alone
// once the operators are gone.
//
// The exporter authenticates and queries the operators directly (see
// src/operator/) instead of spinning up a Spark SDK wallet: the SDK's
// getLeaves() never exposed ancestor chains, and the wallet init pulled in
// network sync, token state, and background optimization this export never
// needed. The same client implementation ships inside the Blink mobile app.

import { bytesToHex } from "@noble/curves/utils";

import { validateRecoveryBundle } from "./bundle.ts";
import {
  fetchOwnedLeafSet,
  OperatorExportError,
  SPARK_COORDINATOR_URL,
} from "./operator/exporter.ts";
import { TREE_NODE_STATUS_AVAILABLE, type DecodedTreeNode } from "./operator/messages.ts";
import type { FetchLike } from "./operator/grpc-web.ts";
import type { AccountNumberInput, RecoveryBundle } from "./types.ts";

const DEFAULT_SCHEMA = "spark.unilateral-exit-bundle.v1";
const DEFAULT_OPERATOR_SET = "spark-sdk";

export { SPARK_COORDINATOR_URL };

export class RecoveryBundleExportError extends Error {
  readonly reason?: "no-leaves" | "incomplete-chain";

  constructor(message: string, reason?: "no-leaves" | "incomplete-chain") {
    super(message);
    this.name = "RecoveryBundleExportError";
    this.reason = reason;
  }
}

export interface ExportFromSeedOptions {
  seed?: string;
  passphrase?: string;
  accountNumber?: AccountNumberInput;
  network?: string;
  operatorSet?: string;
  appVersion?: string;
  /** Spark coordinator base URL; defaults to the public pool coordinator. */
  coordinatorUrl?: string;
  pageSize?: number;
  now?: () => Date;
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export async function exportRecoveryBundleFromSeed({
  seed,
  passphrase = "",
  accountNumber,
  network = "MAINNET",
  operatorSet = DEFAULT_OPERATOR_SET,
  appVersion = "unknown",
  coordinatorUrl = SPARK_COORDINATOR_URL,
  pageSize,
  now = () => new Date(),
  fetchImpl,
}: ExportFromSeedOptions = {}): Promise<RecoveryBundle> {
  if (!isNonEmptyString(seed)) {
    throw new RecoveryBundleExportError("Spark seed or mnemonic is required");
  }
  const normalizedNetwork = normalizeNetwork(network);

  let leafSet;
  try {
    leafSet = await fetchOwnedLeafSet({
      seed,
      passphrase,
      network: normalizedNetwork,
      accountNumber: normalizeAccountNumber(accountNumber),
      coordinatorUrl,
      pageSize,
      fetchImpl,
    });
  } catch (error) {
    if (error instanceof OperatorExportError) {
      throw new RecoveryBundleExportError(error.message, error.reason);
    }
    throw error;
  }

  const bundle = {
    schema: DEFAULT_SCHEMA,
    createdAt: now().toISOString(),
    network: normalizedNetwork,
    operatorSet: isNonEmptyString(operatorSet) ? operatorSet : DEFAULT_OPERATOR_SET,
    walletIdentityPublicKey: leafSet.identityPublicKeyHex,
    sparkSdkVersion: "none (direct operator export)",
    appVersion,
    leaves: leafSet.leaves.map(exportLeaf),
    nodes: leafSet.nodes.map((node) => ({
      id: node.id,
      treeNodeHex: bytesToHex(node.raw),
    })),
    balances: {
      btcSats: leafSet.totalSats.toString(),
      usdb: {
        amount: "unknown",
        status: "not-covered-by-bitcoin-unilateral-exit",
      },
    },
  };

  return validateRecoveryBundle(bundle);
}

function exportLeaf(leaf: DecodedTreeNode) {
  return {
    id: leaf.id,
    status:
      leaf.status ||
      (leaf.treenodeStatus === TREE_NODE_STATUS_AVAILABLE
        ? "AVAILABLE"
        : String(leaf.treenodeStatus)),
    valueSats: leafValueAsNumber(leaf),
    treeNodeHex: bytesToHex(leaf.raw),
  };
}

function leafValueAsNumber(leaf: DecodedTreeNode): number {
  const value = Number(leaf.valueSats);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecoveryBundleExportError(
      `Spark leaf ${leaf.id} has an invalid value for bundle valueSats: ${leaf.valueSats}`,
    );
  }
  return value;
}

// undefined lets the exporter pick the Spark default account for the network
// (0 on regtest/local, 1 everywhere else) - the same rule the Spark SDK
// follows, so all commands land on the same wallet identity unless an account
// is given.
export function normalizeAccountNumber(
  value: AccountNumberInput,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const accountNumber = Number(value);
  if (!Number.isSafeInteger(accountNumber) || accountNumber < 0) {
    throw new RecoveryBundleExportError("--account-number must be a non-negative integer");
  }
  return accountNumber;
}

export function normalizeNetwork(value: string): string {
  const network = String(value ?? "").toUpperCase();
  if (!["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"].includes(network)) {
    throw new RecoveryBundleExportError(`Unsupported Spark network: ${value}`);
  }
  return network;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
