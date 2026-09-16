import { webcrypto } from "node:crypto";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { DEFAULT_SETTINGS, type WalletState, type RecoverySession } from "../../desktop/contracts.ts";
export const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const PASSWORD = "regtest vault password";
export function bundle(account = 1, seed = SEED, network: "LOCAL" | "MAINNET" = "LOCAL") {
  const key = deriveIdentityKeyPair(seed, network, account);
  const node = TreeNode.fromPartial({ id: "leaf", ownerIdentityPublicKey: key.publicKey, value: 100000, refundTx: new Uint8Array([1]) });
  return { schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-09-09T10:00:00Z", network: network as string,
    walletIdentityPublicKey: bytesToHex(key.publicKey), leaves: [{ id: "leaf", valueSats: 100000, treeNodeHex: bytesToHex(TreeNode.encode(node).finish()) }], nodes: [] };
}
export function wallet(): WalletState { return { version: 1, seed: SEED, settings: DEFAULT_SETTINGS, bundle: bundle(), completed: [] }; }
export function recovery(): RecoverySession {
  return { id: "review-1", leafId: "leaf", bundle: bundle(), destination: "bcrt1test", feeRate: 2, feeSats: "2000",
    packages: [{ leafId: "leaf", txPackages: [] }],
    sweep: { leafId: "leaf", refundTxid: "aa", refundVout: 0, refundValueSats: "100000", refundAddress: "bcrt1refund", derivationPath: "test", sweepTxid: "bb", sweepTx: "cc", feeSats: "200", vsize: 100 },
    approved: false, status: "review", message: "Review" };
}

// Match Blink's WebCrypto wire format independently of the desktop decoder.
export async function blinkBackup(value = bundle(0), plaintext = JSON.stringify(value)) {
  const context = "blink:recovery-bundle:aes-128-gcm:v1";
  const signingKey = await webcrypto.subtle.importKey("raw", mnemonicToSeedSync(SEED), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await webcrypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(context));
  const key = await webcrypto.subtle.importKey("raw", digest.slice(0, 16), "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(plaintext));
  return { schema: "blink.recovery-bundle-backup.v1", encrypted: true, cipher: "AES-128-GCM", keyDerivation: "hmac-sha256-seed", context,
    network: value.network, walletIdentityPublicKey: value.walletIdentityPublicKey, bundleCreatedAt: value.createdAt,
    iv: Buffer.from(iv).toString("base64"), data: Buffer.from(data).toString("base64") };
}
