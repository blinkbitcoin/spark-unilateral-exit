import {
  EsploraError,
  esploraBaseUrl,
  submitPackage,
  broadcastTransaction,
  getTransaction,
} from "./esplora.ts";
import type { LeafPackage, SweepBroadcastInput } from "./types.ts";

export { EsploraError };

interface PackageSubmitEntry {
  leafId: string;
  packageIndex: number;
  parentTx: string;
  result: unknown;
}

interface BroadcastPackagesResult {
  leafId: string;
  packages: PackageSubmitEntry[];
}

interface BroadcastPackagesOptions {
  packages: LeafPackage[];
  network: string;
  esploraUrl?: string;
  onPackageSubmitted?: (entry: PackageSubmitEntry) => void;
}

export async function broadcastPackages({
  packages,
  network,
  esploraUrl,
  onPackageSubmitted,
}: BroadcastPackagesOptions): Promise<BroadcastPackagesResult[]> {
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const results: BroadcastPackagesResult[] = [];

  for (const leafPackage of packages) {
    const leafId = leafPackage.leafId;
    if (!leafId || !Array.isArray(leafPackage.txPackages)) {
      throw new EsploraError(`Invalid package: missing leafId or txPackages`);
    }

    const leafResults: PackageSubmitEntry[] = [];
    for (let i = 0; i < leafPackage.txPackages.length; i += 1) {
      const txPkg = leafPackage.txPackages[i];
      if (!txPkg?.tx) {
        throw new EsploraError(
          `Leaf ${leafId} txPackages[${i}] is missing the tx field`,
        );
      }
      if (!txPkg.signedChildTx) {
        throw new EsploraError(
          `Leaf ${leafId} txPackages[${i}] is missing signedChildTx. ` +
            `Sign the feeBumpPsbt and add the result as "signedChildTx" before broadcasting.`,
        );
      }

      const result = await submitPackage(
        [txPkg.tx, txPkg.signedChildTx],
        baseUrl,
      );

      const entry: PackageSubmitEntry = {
        leafId,
        packageIndex: i,
        parentTx: txPkg.tx.slice(0, 16) + "...",
        result,
      };
      leafResults.push(entry);
      onPackageSubmitted?.(entry);
    }
    results.push({ leafId, packages: leafResults });
  }
  return results;
}

interface BroadcastSweepsOptions {
  sweeps: SweepBroadcastInput[];
  network: string;
  esploraUrl?: string;
}

interface BroadcastSweepResult {
  leafId: string | undefined;
  sweepTxid: string;
  expectedTxid: string | undefined;
  match: boolean;
}

export async function broadcastSweeps({
  sweeps,
  network,
  esploraUrl,
}: BroadcastSweepsOptions): Promise<BroadcastSweepResult[]> {
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const results: BroadcastSweepResult[] = [];

  for (const sweep of sweeps) {
    if (!sweep?.sweepTx) {
      throw new EsploraError(
        `Sweep for leaf ${sweep?.leafId ?? "unknown"} is missing sweepTx`,
      );
    }
    const txid = await broadcastTransaction(sweep.sweepTx, baseUrl);
    results.push({
      leafId: sweep.leafId,
      sweepTxid: txid,
      expectedTxid: sweep.sweepTxid,
      match: txid === sweep.sweepTxid,
    });
  }
  return results;
}

interface CheckTransactionStatusOptions {
  txid: string;
  network: string;
  esploraUrl?: string;
}

interface TransactionStatus {
  txid: string;
  found: boolean;
  confirmed: boolean;
  blockHeight?: number | null;
  blockHash?: string | null;
}

export async function checkTransactionStatus({
  txid,
  network,
  esploraUrl,
}: CheckTransactionStatusOptions): Promise<TransactionStatus> {
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const tx = await getTransaction(txid, baseUrl);
  if (!tx) return { txid, found: false, confirmed: false };
  return {
    txid,
    found: true,
    confirmed: tx.status?.confirmed ?? false,
    blockHeight: tx.status?.block_height ?? null,
    blockHash: tx.status?.block_hash ?? null,
  };
}
