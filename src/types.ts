// Shared domain types for the spark-unilateral-exit tool.
//
// These describe the JSON documents that flow between the CLI subcommands
// (recovery bundle, tx packages, sweep results) and the responses returned by
// the Esplora HTTP API and the Spark SDK. They are intentionally permissive:
// most fields come from parsed JSON or an injected dependency, so optional
// members and index signatures reflect what the runtime code actually guards.

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

// parseArgs only ever assigns a bare flag (`true`), a single string value, or a
// string[] when the same flag is repeated -- never `false`.
export type CliArgValue = string | true | string[] | undefined;
export type CliArgs = Record<string, CliArgValue>;

// Account numbers can arrive raw from the CLI (CliArgValue) or as a number from
// programmatic callers/tests; the normalizers also compare against null.
export type AccountNumberInput = CliArgValue | number | null;

// ---------------------------------------------------------------------------
// Recovery bundle
// ---------------------------------------------------------------------------

export interface BundleLeaf {
  id: string;
  status?: string;
  valueSats?: number;
  treeNodeHex: string;
  [key: string]: unknown;
}

export interface BundleNode {
  id: string;
  treeNodeHex: string;
  [key: string]: unknown;
}

export interface UsdbBalance {
  amount?: string;
  status?: string;
}

export interface BundleBalances {
  btcSats?: string;
  usdb?: UsdbBalance;
}

export interface RecoveryBundle {
  schema: string;
  createdAt: string;
  network: string;
  operatorSet?: string;
  walletIdentityPublicKey?: string;
  sparkSdkVersion?: string;
  appVersion?: string;
  leaves: BundleLeaf[];
  nodes?: BundleNode[];
  balances?: BundleBalances;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CPFP UTXO / tx packages
// ---------------------------------------------------------------------------

export interface CpfpUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: string;
  publicKey: string;
}

export interface TxPackage {
  tx?: string;
  feeBumpPsbt?: string;
  signedChildTx?: string;
  [key: string]: unknown;
}

export interface LeafPackage {
  // JSON documents may carry an explicit null leafId; the code guards on it.
  leafId?: string | null;
  txPackages?: TxPackage[];
  [key: string]: unknown;
}

export interface PackageFile {
  destination?: string;
  packages: LeafPackage[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface LeafSweep {
  leafId: string | null | undefined;
  refundTxid: string;
  refundVout: number;
  refundValueSats: string;
  refundAddress: string | undefined;
  derivationPath: string;
  sweepTxid: string;
  sweepTx: string;
  feeSats: string;
  vsize: number;
}

export interface SweepResult {
  destination: string;
  feeRateSatPerVbyte: number;
  sweeps: LeafSweep[];
}

export interface SweepBroadcastInput {
  leafId?: string;
  sweepTx?: string;
  sweepTxid?: string;
}

// ---------------------------------------------------------------------------
// Esplora HTTP responses
// ---------------------------------------------------------------------------

export interface EsploraTxStatus {
  confirmed?: boolean;
  block_height?: number;
  block_hash?: string;
}

export interface EsploraTransaction {
  txid?: string;
  status?: EsploraTxStatus;
  [key: string]: unknown;
}

export interface EsploraUtxo {
  txid: string;
  vout: number;
  /** Sats as a JSON number from Esplora; convert to bigint for arithmetic. */
  value: number;
  status?: EsploraTxStatus;
}

// ---------------------------------------------------------------------------
// Spark SDK wallet seam (used by leaf consolidation)
// ---------------------------------------------------------------------------

export interface SparkLeaf {
  id?: string;
  status?: unknown;
  value?: bigint | number | string;
  valueSats?: bigint | number | string;
  [key: string]: unknown;
}

export interface OptimizeLeavesStep {
  step: number;
  total: number;
  controller?: { abort(): void };
}

export interface SparkWalletLike {
  getLeaves(): Promise<SparkLeaf[]>;
  experimental_syncWallet?(): Promise<void>;
  cleanup?(): Promise<void>;
  optimizeLeaves?(
    multiplicity?: number,
  ): AsyncGenerator<OptimizeLeavesStep, void, void>;
}

export interface WalletFactoryParams {
  seed: string;
  /** undefined lets the SDK pick its network default (0 on regtest, 1 elsewhere). */
  accountNumber: number | undefined;
  network: string;
}
