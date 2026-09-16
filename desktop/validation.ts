import { Address, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { validateRecoveryBundle } from "../src/bundle.ts";
import { deriveIdentityKeyPair } from "../src/operator/identity.ts";
import type { RecoveryBundle } from "../src/types.ts";
import type { Settings, Network, ProfileOptions, BitcoinRpc, BundleMode } from "./contracts.ts";

export const REGTEST = { ...TEST_NETWORK, bech32: "bcrt" };
export function localUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("A local coordinator URL is required.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Regtest requires an HTTPS coordinator on loopback.");
  }
  return url.origin;
}
export function networkCheck(value: unknown): Network {
  if (value !== "LOCAL" && value !== "MAINNET") throw new Error("Choose regtest or mainnet.");
  return value;
}
export function profileOptionsCheck(value: ProfileOptions): ProfileOptions {
  if (!value || typeof value.label !== "string" || !value.label.trim() || value.label.length > 60) throw new Error("Use a seed profile name between 1 and 60 characters.");
  return { label: value.label.trim(), network: networkCheck(value.network) };
}
export function rpcCheck(value: BitcoinRpc): BitcoinRpc {
  if (!value || typeof value.url !== "string") throw new Error("A local Bitcoin RPC URL is required.");
  const url = new URL(value.url);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Bitcoin RPC must use HTTP on loopback, without a path or embedded credentials.");
  if (typeof value.username !== "string" || value.username.length > 1024 || value.username.includes(":") ||
      typeof value.password !== "string" || value.password.length > 1024) throw new Error("Invalid Bitcoin RPC credentials.");
  return { url: url.origin, username: value.username, password: value.password };
}
export function settingsCheck(value: Settings): Settings {
  if (!value || !Number.isSafeInteger(value.accountNumber) || value.accountNumber < 0 || value.accountNumber >= 0x80000000) {
    throw new Error("Account must be a non-negative hardened account index.");
  }
  if (typeof value.coordinatorCa !== "string" || value.coordinatorCa.length > 100_000) throw new Error("Invalid coordinator certificate.");
  const network = networkCheck(value.network ?? "LOCAL");
  let coordinatorUrl: string;
  if (network === "LOCAL") coordinatorUrl = localUrl(value.coordinatorUrl);
  else {
    const url = new URL(value.coordinatorUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use an HTTPS Spark coordinator without a path or credentials.");
    coordinatorUrl = url.origin;
  }
  const bitcoinRpc = value.bitcoinRpc === undefined ? undefined : rpcCheck(value.bitcoinRpc);
  if (network === "LOCAL" && bitcoinRpc) throw new Error("Regtest uses the isolated stack's fixed Bitcoin RPC configuration.");
  return { accountNumber: value.accountNumber, coordinatorUrl, coordinatorCa: value.coordinatorCa, network, ...(bitcoinRpc ? { bitcoinRpc } : {}) };
}
export function destinationCheck(value: unknown, network: Network = "LOCAL"): string {
  const prefix = network === "MAINNET" ? "bc1" : "bcrt1";
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error(`Use a ${prefix} Bitcoin ${network === "MAINNET" ? "mainnet" : "regtest"} destination.`);
  Address(network === "MAINNET" ? NETWORK : REGTEST).decode(value);
  return value;
}
export function feeCheck(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100) throw new Error("Fee rate must be between 1 and 100 sat/vB.");
  return value;
}
export function bundleModeCheck(value: unknown): BundleMode {
  if (value !== "standard" && value !== "exit") throw new Error("Choose a bundle download mode.");
  return value;
}
export function bundleCheck(raw: unknown, seed: string, account: number, network: Network = "LOCAL"): RecoveryBundle {
  const bundle = validateRecoveryBundle(raw);
  if (!(network === "MAINNET" ? bundle.network === "MAINNET" : ["LOCAL", "REGTEST"].includes(bundle.network))) throw new Error(`The bundle does not match this profile's ${network === "MAINNET" ? "mainnet" : "regtest"} network.`);
  if (bundle.leaves.length > 1000 || (bundle.nodes?.length ?? 0) > 20000) throw new Error("Bundle exceeds app limits.");
  if (new Set(bundle.leaves.map((leaf) => leaf.id)).size !== bundle.leaves.length) throw new Error("Backup contains duplicate leaves.");
  const identity = bytesToHex(deriveIdentityKeyPair(seed, network, account).publicKey);
  if (bundle.walletIdentityPublicKey !== identity) throw new Error("Backup does not match this seed and account.");
  const nodes = new Map<string, TreeNode>();
  for (const node of [...(bundle.nodes ?? []), ...bundle.leaves]) {
    const decoded = TreeNode.decode(hexToBytes(node.treeNodeHex));
    if (decoded.id !== node.id) throw new Error("Backup node ID mismatch.");
    if (nodes.has(node.id) && bytesToHex(TreeNode.encode(nodes.get(node.id)!).finish()) !== bytesToHex(TreeNode.encode(decoded).finish())) {
      throw new Error("Conflicting backup nodes.");
    }
    nodes.set(node.id, decoded);
  }
  for (const leaf of bundle.leaves) {
    const node = nodes.get(leaf.id)!;
    if (bytesToHex(node.ownerIdentityPublicKey) !== identity) throw new Error("Leaf belongs to another wallet.");
    if (!node.refundTx.length) throw new Error("Leaf is missing its refund transaction.");
    const amount = Number(node.value);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid leaf amount.");
    leaf.valueSats = amount;
    const visited = new Set<string>();
    let cursor: TreeNode | undefined = node;
    while (cursor) {
      if (visited.has(cursor.id)) throw new Error("Cycle in backup ancestors.");
      visited.add(cursor.id);
      if (!cursor.parentNodeId) break;
      cursor = nodes.get(cursor.parentNodeId);
      if (!cursor) throw new Error("Backup is missing an ancestor transaction.");
    }
  }
  // LOCAL directs all SDK chain lookups to the local Bitcoin RPC, never hosted regtest.
  return { ...bundle, network };
}
