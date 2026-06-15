import { getNodeHexStrings } from "./bundle.js";

const NETWORKS = new Set(["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"]);

export async function constructSparkPackages({ bundle, cpfpUtxos, feeRate }) {
  const { constructUnilateralExitFeeBumpPackages, Network } = await import(
    "@buildonspark/spark-sdk"
  );

  const network = normalizeNetwork(bundle.network, Network);
  return constructUnilateralExitFeeBumpPackages(
    getNodeHexStrings(bundle),
    cpfpUtxos,
    { satPerVbyte: feeRate },
    network,
  );
}

function normalizeNetwork(network, sparkNetwork) {
  const normalized = String(network).toUpperCase();
  if (!NETWORKS.has(normalized)) {
    throw new Error(`Unsupported Spark network: ${network}`);
  }
  return sparkNetwork[normalized];
}
