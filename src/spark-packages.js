import { getNodeHexStrings } from "./bundle.js";
import { hexToBytes } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const NETWORKS = new Set(["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"]);

export async function constructSparkPackages({
  bundle,
  cpfpUtxos,
  feeRate,
  sparkClient,
}) {
  const { constructUnilateralExitFeeBumpPackages, Network } = await import(
    "@buildonspark/spark-sdk"
  );

  const network = normalizeNetwork(bundle.network, Network);
  const bundleSparkClient = sparkClient ?? createBundleSparkClient(bundle);
  return constructUnilateralExitFeeBumpPackages(
    getNodeHexStrings(bundle),
    cpfpUtxos,
    { satPerVbyte: feeRate },
    network,
    bundleSparkClient,
  );
}

function createBundleSparkClient(bundle) {
  const encodedNodes = new Map();
  for (const leaf of bundle.leaves ?? []) {
    if (leaf?.id && leaf?.treeNodeHex) encodedNodes.set(leaf.id, leaf.treeNodeHex);
  }
  for (const node of bundle.nodes ?? []) {
    if (node?.id && node?.treeNodeHex) encodedNodes.set(node.id, node.treeNodeHex);
  }
  if (encodedNodes.size === 0) return undefined;

  const decodedNodes = new Map();
  const decodeNode = (id) => {
    if (decodedNodes.has(id)) return decodedNodes.get(id);
    const hex = encodedNodes.get(id);
    if (!hex) return undefined;
    const node = TreeNode.decode(hexToBytes(hex));
    decodedNodes.set(id, node);
    return node;
  };

  return {
    async query_nodes(request) {
      const requestedIds =
        request?.source?.$case === "nodeIds"
          ? (request.source.nodeIds?.nodeIds ?? [])
          : Array.from(encodedNodes.keys());
      const nodes = {};
      for (const id of requestedIds) {
        addNodeAndParents({ id, nodes, decodeNode, includeParents: request?.includeParents });
      }
      return { nodes, offset: 0 };
    },
  };
}

function addNodeAndParents({ id, nodes, decodeNode, includeParents }) {
  let current = decodeNode(id);
  while (current) {
    nodes[current.id] = current;
    if (!includeParents || !current.parentNodeId) return;
    current = decodeNode(current.parentNodeId);
  }
}

function normalizeNetwork(network, sparkNetwork) {
  const normalized = String(network).toUpperCase();
  if (!NETWORKS.has(normalized)) {
    throw new Error(`Unsupported Spark network: ${network}`);
  }
  return sparkNetwork[normalized];
}
