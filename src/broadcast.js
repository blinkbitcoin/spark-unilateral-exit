import {
  EsploraError,
  esploraBaseUrl,
  submitPackage,
  broadcastTransaction,
  getTransaction,
} from "./esplora.js";

export { EsploraError };

export async function broadcastPackages({
  packages,
  network,
  esploraUrl,
  onPackageSubmitted,
}) {
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const results = [];

  for (const leafPackage of packages) {
    const leafId = leafPackage.leafId;
    if (!leafId || !Array.isArray(leafPackage.txPackages)) {
      throw new EsploraError(`Invalid package: missing leafId or txPackages`);
    }

    const leafResults = [];
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

      const entry = {
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

export async function broadcastSweeps({ sweeps, network, esploraUrl }) {
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const results = [];

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

export async function checkTransactionStatus({ txid, network, esploraUrl }) {
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
