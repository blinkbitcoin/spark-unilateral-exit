import { bytesToHex } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import { validateRecoveryBundle } from "./bundle.js";

const DEFAULT_SCHEMA = "spark.unilateral-exit-bundle.v1";
const DEFAULT_OPERATOR_SET = "spark-sdk";

export class RecoveryBundleExportError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecoveryBundleExportError";
  }
}

export async function exportRecoveryBundleFromSeed({
  seed,
  accountNumber = 0,
  network = "MAINNET",
  operatorSet = DEFAULT_OPERATOR_SET,
  appVersion = "unknown",
  walletFactory = defaultWalletFactory,
  now = () => new Date(),
  encodeTreeNode = defaultEncodeTreeNode,
  leafPollAttempts = 6,
  leafPollDelayMs = 2_000,
  cleanupWallet = true,
} = {}) {
  if (!isNonEmptyString(seed)) {
    throw new RecoveryBundleExportError("Spark seed or mnemonic is required");
  }
  const normalizedNetwork = normalizeNetwork(network);
  const walletResponse = await walletFactory({
    seed,
    accountNumber: normalizeAccountNumber(accountNumber),
    network: normalizedNetwork,
  });
  const wallet = walletResponse?.wallet ?? walletResponse;

  if (!wallet) {
    throw new RecoveryBundleExportError("Spark wallet initialization returned no wallet");
  }

  try {
    return await exportRecoveryBundleFromWallet({
      wallet,
      network: normalizedNetwork,
      operatorSet,
      appVersion,
      now,
      encodeTreeNode,
      leafPollAttempts,
      leafPollDelayMs,
    });
  } finally {
    if (cleanupWallet) await wallet.cleanup?.();
  }
}

export async function exportRecoveryBundleFromWallet({
  wallet,
  network = "MAINNET",
  operatorSet = DEFAULT_OPERATOR_SET,
  appVersion = "unknown",
  now = () => new Date(),
  encodeTreeNode = defaultEncodeTreeNode,
  leafPollAttempts = 1,
  leafPollDelayMs = 0,
} = {}) {
  if (!wallet?.getLeaves) {
    throw new RecoveryBundleExportError("A Spark wallet with getLeaves() is required");
  }

  const leaves = await pollLeaves({
    wallet,
    attempts: leafPollAttempts,
    delayMs: leafPollDelayMs,
  });
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new RecoveryBundleExportError(
      "Spark wallet has no leaves to export for offline recovery",
    );
  }

  const balance = await wallet.getBalance?.();
  const bundle = {
    schema: DEFAULT_SCHEMA,
    createdAt: now().toISOString(),
    network: normalizeNetwork(network),
    operatorSet: isNonEmptyString(operatorSet) ? operatorSet : DEFAULT_OPERATOR_SET,
    walletIdentityPublicKey: await wallet.getIdentityPublicKey?.(),
    sparkSdkVersion: "unknown",
    appVersion,
    leaves: leaves.map((leaf, index) =>
      exportLeaf({ leaf, index, encodeTreeNode }),
    ),
    balances: exportBalances({ balance, leaves }),
  };

  return validateRecoveryBundle(bundle);
}

async function pollLeaves({ wallet, attempts, delayMs }) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let leaves = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await wallet.experimental_syncWallet?.();
    leaves = await wallet.getLeaves();
    if (Array.isArray(leaves) && leaves.length > 0) return leaves;
    if (attempt < maxAttempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return leaves;
}

async function defaultWalletFactory({ seed, accountNumber, network }) {
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  return SparkWallet.initialize({
    mnemonicOrSeed: seed,
    accountNumber,
    options: { network },
  });
}

function exportLeaf({ leaf, index, encodeTreeNode }) {
  const id = leaf.id ?? leaf.nodeId ?? leaf.treeNodeId;
  if (!isNonEmptyString(id)) {
    throw new RecoveryBundleExportError(`Spark leaf ${index} is missing an id`);
  }

  const valueSats = normalizeLeafValue(leaf.value ?? leaf.valueSats);
  return {
    id,
    status: leaf.status ? String(leaf.status) : undefined,
    valueSats,
    treeNodeHex: encodeTreeNode(leaf),
  };
}

function defaultEncodeTreeNode(leaf) {
  return bytesToHex(TreeNode.encode(leaf).finish());
}

function exportBalances({ balance, leaves }) {
  return {
    btcSats:
      normalizeOptionalBalance(balance?.satsBalance?.owned) ??
      normalizeOptionalBalance(balance?.balance) ??
      leaves
        .reduce(
          (sum, leaf) => sum + BigInt(normalizeLeafValue(leaf.value ?? leaf.valueSats ?? 0n)),
          0n,
        )
        .toString(),
    usdb: {
      amount: normalizeTokenBalances(balance?.tokenBalances),
      status: "not-covered-by-bitcoin-unilateral-exit",
    },
  };
}

function normalizeTokenBalances(tokenBalances) {
  if (!tokenBalances || typeof tokenBalances.values !== "function") return "unknown";
  let total = 0n;
  for (const tokenBalance of tokenBalances.values()) {
    total += BigInt(tokenBalance?.ownedBalance ?? 0n);
  }
  return total.toString();
}

function normalizeOptionalBalance(value) {
  if (value === undefined || value === null) return undefined;
  return BigInt(value).toString();
}

function normalizeLeafValue(value) {
  const normalized = BigInt(value ?? 0n);
  if (normalized < 0n) {
    throw new RecoveryBundleExportError("Spark leaf value cannot be negative");
  }
  const asNumber = Number(normalized);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RecoveryBundleExportError(
      `Spark leaf value is too large for bundle valueSats: ${normalized}`,
    );
  }
  return asNumber;
}

function normalizeAccountNumber(value) {
  const accountNumber = Number(value);
  if (!Number.isSafeInteger(accountNumber) || accountNumber < 0) {
    throw new RecoveryBundleExportError("--account-number must be a non-negative integer");
  }
  return accountNumber;
}

function normalizeNetwork(value) {
  const network = String(value ?? "").toUpperCase();
  if (!["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"].includes(network)) {
    throw new RecoveryBundleExportError(`Unsupported Spark network: ${value}`);
  }
  return network;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
