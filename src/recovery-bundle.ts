import { bytesToHex } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import { validateRecoveryBundle } from "./bundle.ts";
import type {
  AccountNumberInput,
  BundleBalances,
  BundleLeaf,
  RecoveryBundle,
  SparkLeaf,
  SparkWalletLike,
  WalletBalance,
  WalletFactoryParams,
  WalletTokenBalances,
} from "./types.ts";

const DEFAULT_SCHEMA = "spark.unilateral-exit-bundle.v1";
const DEFAULT_OPERATOR_SET = "spark-sdk";

// The wallet factory and encodeTreeNode are dependency-injection seams. In
// production they call into the Spark SDK (dynamically imported, unchecked
// under skipLibCheck); in tests they are replaced by fakes. `any` here reflects
// the deliberately dynamic shape at these boundaries.
type WalletFactory = (params: WalletFactoryParams) => Promise<any>;
type EncodeTreeNode = (leaf: any) => string;

export class RecoveryBundleExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryBundleExportError";
  }
}

interface ExportFromSeedOptions {
  seed?: string;
  accountNumber?: AccountNumberInput;
  network?: string;
  operatorSet?: string;
  appVersion?: string;
  walletFactory?: WalletFactory;
  now?: () => Date;
  encodeTreeNode?: EncodeTreeNode;
  leafPollAttempts?: number;
  leafPollDelayMs?: number;
  cleanupWallet?: boolean;
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
}: ExportFromSeedOptions = {}): Promise<RecoveryBundle> {
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

interface ExportFromWalletOptions {
  wallet: SparkWalletLike;
  network?: string;
  operatorSet?: string;
  appVersion?: string;
  now?: () => Date;
  encodeTreeNode?: EncodeTreeNode;
  leafPollAttempts?: number;
  leafPollDelayMs?: number;
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
}: ExportFromWalletOptions): Promise<RecoveryBundle> {
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

async function pollLeaves({
  wallet,
  attempts,
  delayMs,
}: {
  wallet: SparkWalletLike;
  attempts: number;
  delayMs: number;
}): Promise<SparkLeaf[]> {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let leaves: SparkLeaf[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await wallet.experimental_syncWallet?.();
    leaves = await wallet.getLeaves();
    if (Array.isArray(leaves) && leaves.length > 0) return leaves;
    if (attempt < maxAttempts && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return leaves;
}

interface SparkWalletModule {
  SparkWallet: {
    initialize(config: {
      mnemonicOrSeed: string;
      accountNumber: number;
      options: { network: string };
    }): Promise<unknown>;
  };
}

async function defaultWalletFactory({ seed, accountNumber, network }: WalletFactoryParams) {
  const { SparkWallet } = (await import(
    "@buildonspark/spark-sdk"
  )) as unknown as SparkWalletModule;
  return SparkWallet.initialize({
    mnemonicOrSeed: seed,
    accountNumber,
    options: { network },
  });
}

function exportLeaf({
  leaf,
  index,
  encodeTreeNode,
}: {
  leaf: SparkLeaf;
  index: number;
  encodeTreeNode: EncodeTreeNode;
}): BundleLeaf {
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

function defaultEncodeTreeNode(leaf: SparkLeaf): string {
  return bytesToHex(TreeNode.encode(leaf as unknown as TreeNode).finish());
}

function exportBalances({
  balance,
  leaves,
}: {
  balance: WalletBalance | undefined | null;
  leaves: SparkLeaf[];
}): BundleBalances {
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

function normalizeTokenBalances(
  tokenBalances: WalletTokenBalances | undefined,
): string {
  if (!tokenBalances || typeof tokenBalances.values !== "function") return "unknown";
  let total = 0n;
  for (const tokenBalance of tokenBalances.values()) {
    total += BigInt(tokenBalance?.ownedBalance ?? 0n);
  }
  return total.toString();
}

function normalizeOptionalBalance(
  value: bigint | number | string | null | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return BigInt(value).toString();
}

function normalizeLeafValue(value: bigint | number | string | undefined): number {
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

function normalizeAccountNumber(value: AccountNumberInput): number {
  const accountNumber = Number(value);
  if (!Number.isSafeInteger(accountNumber) || accountNumber < 0) {
    throw new RecoveryBundleExportError("--account-number must be a non-negative integer");
  }
  return accountNumber;
}

function normalizeNetwork(value: string): string {
  const network = String(value ?? "").toUpperCase();
  if (!["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"].includes(network)) {
    throw new RecoveryBundleExportError(`Unsupported Spark network: ${value}`);
  }
  return network;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
