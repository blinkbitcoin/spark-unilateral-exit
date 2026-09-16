import { createHash } from "node:crypto";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import type { RecoveryBundle } from "../src/types.ts";

// Call only after bundleCheck has proved a closed, acyclic parent-ID graph.
// Canonical protobuf includes every known recovery field, not merely leaf IDs.
export function bundleFingerprint(bundle: RecoveryBundle): string {
  const nodes = new Map([...bundle.nodes ?? [], ...bundle.leaves].map((node) =>
    [node.id, TreeNode.decode(hexToBytes(node.treeNodeHex))]));
  const reachable = new Map<string, string>();
  for (const leaf of bundle.leaves) {
    let node = nodes.get(leaf.id)!;
    while (!reachable.has(node.id)) {
      // The SDK preserves protobuf map insertion order rather than sorting it.
      if (node.signingKeyshare) {
        const shares = node.signingKeyshare.publicShares;
        node.signingKeyshare.publicShares = Object.fromEntries(Object.keys(shares).sort().map((key) => [key, shares[key]!]));
      }
      reachable.set(node.id, bytesToHex(TreeNode.encode({ ...node, createdTime: undefined, updatedTime: undefined }).finish()));
      if (!node.parentNodeId) break;
      node = nodes.get(node.parentNodeId)!;
    }
  }
  return createHash("sha256").update(JSON.stringify({
    leaves: bundle.leaves.map((leaf) => leaf.id).sort(), nodes: [...reachable].sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
}
