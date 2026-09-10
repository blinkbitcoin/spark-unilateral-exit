import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { p2wpkh } from "@scure/btc-signer";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { bundleCheck, localUrl, settingsCheck, destinationCheck, feeCheck, bundleModeCheck, REGTEST } from "../../desktop/validation.ts";
import { DEFAULT_SETTINGS } from "../../desktop/contracts.ts";
import { bundle, SEED } from "./helpers.ts";
describe("desktop input boundaries", () => {
  it("only accepts HTTPS loopback coordinators", () => {
    for (const url of ["https://localhost:8535", "https://127.0.0.1:8535", "https://[::1]:8535"]) expect(localUrl(url)).toBe(url);
    for (const url of [null, "https://example.com", "http://localhost", "https://localhost.evil.test", "https://user:pass@localhost", "https://localhost/path", "https://localhost?q=1", "https://localhost/#x"]) expect(() => localUrl(url)).toThrow();
  });
  it("validates accounts, certificate sizes, fee bounds and destinations", () => {
    expect(settingsCheck(DEFAULT_SETTINGS)).toEqual({ ...DEFAULT_SETTINGS, network: "LOCAL" });
    for (const accountNumber of [-1, 0.1, NaN, 0x80000000]) expect(() => settingsCheck({ ...DEFAULT_SETTINGS, accountNumber })).toThrow();
    expect(() => settingsCheck({ ...DEFAULT_SETTINGS, coordinatorCa: "x".repeat(100001) })).toThrow();
    for (const fee of [0, 101, NaN, Infinity, "2"]) expect(() => feeCheck(fee)).toThrow();
    expect(feeCheck(2.5)).toBe(2.5);
    expect(bundleModeCheck("standard")).toBe("standard");
    expect(bundleModeCheck("exit")).toBe("exit");
    for (const mode of [null, "", "economical", 0]) expect(() => bundleModeCheck(mode)).toThrow("download mode");
    const dest = p2wpkh(deriveIdentityKeyPair(SEED, "LOCAL", 1).publicKey, REGTEST).address!;
    expect(destinationCheck(dest)).toBe(dest);
    for (const dest of [null, "bc1whatever", "bcrt1invalid"]) expect(() => destinationCheck(dest)).toThrow();
  });
  it("binds bundles to wallet, decodes amounts and checks ancestry", () => {
    const good = bundle(); good.leaves[0]!.valueSats = 1;
    expect(bundleCheck(good, SEED, 1).leaves[0]!.valueSats).toBe(100000);
    const hosted = bundle(); hosted.network = "REGTEST";
    expect(bundleCheck(hosted, SEED, 1).network).toBe("LOCAL");
    expect(() => bundleCheck(bundle(), SEED, 0)).toThrow("does not match");
    expect(() => bundleCheck({ ...bundle(), network: "MAINNET" }, SEED, 1)).toThrow("regtest");
    const mutate = (change: (node: TreeNode) => void) => {
      const b = bundle(); const n = TreeNode.decode(hexToBytes(b.leaves[0]!.treeNodeHex)); change(n);
      b.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(n).finish()); return b;
    };
    for (const [change, message] of [
      [(n: TreeNode) => { n.id = "other"; }, "ID mismatch"],
      [(n: TreeNode) => { n.ownerIdentityPublicKey = new Uint8Array(33); }, "another wallet"],
      [(n: TreeNode) => { n.refundTx = new Uint8Array(); }, "refund"],
      [(n: TreeNode) => { n.value = 0; }, "amount"],
      [(n: TreeNode) => { n.parentNodeId = "missing"; }, "ancestor"],
      [(n: TreeNode) => { n.parentNodeId = "leaf"; }, "Cycle"],
    ] as const) expect(() => bundleCheck(mutate(change), SEED, 1)).toThrow(message);
    expect(() => bundleCheck({ ...bundle(), leaves: Array(1001).fill(bundle().leaves[0]) }, SEED, 1)).toThrow("limits");
    const conflicting = mutate((n) => { n.value = 200000; });
    expect(() => bundleCheck({ ...bundle(), nodes: conflicting.leaves }, SEED, 1)).toThrow("Conflicting");
    expect(() => bundleCheck({ ...bundle(), nodes: Array(20001).fill(bundle().leaves[0]) }, SEED, 1)).toThrow("limits");
    expect(bundleCheck({ ...bundle(), nodes: bundle().leaves }, SEED, 1).leaves).toHaveLength(1);
    const { nodes: _nodes, ...noAncestors } = bundle();
    expect(bundleCheck(noAncestors, SEED, 1).leaves).toHaveLength(1);
    expect(() => bundleCheck({ ...bundle(), leaves: [bundle().leaves[0], bundle().leaves[0]] }, SEED, 1)).toThrow("duplicate leaves");
  });
});
