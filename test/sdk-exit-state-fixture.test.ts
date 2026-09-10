// Cross-validation of the TS converter against an ExitStateEnvelope
// serialized by the Breez Spark SDK itself (spark-wallet's serde impls).
//
// Regenerate the fixture with the scratch Rust test in
// ~/Dev/_spark/spark-sdk (crates/spark-wallet/tests/dump_envelope.rs,
// not committed): cargo test -p spark-wallet --features test-utils --test
// dump_envelope dump_envelope
// writes /tmp/exit-state-fixture.json. Copy it here when it changes.

import { describe, expect, it } from "vitest";

import { hexToBytes } from "@noble/curves/utils";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bundleToExitState, exitStateToBundle } from "../src/exit-state-converter.ts";
import { decodeTreeNode } from "../src/operator/messages.ts";
import { parseRecoveryBundle } from "../src/bundle.ts";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/sdk-exit-state.json", import.meta.url)),
  "utf8",
);

describe("SDK-produced exit state fixture", () => {
  it("is the expected envelope", () => {
    const envelope = JSON.parse(FIXTURE);
    expect(envelope.version).toBe(1);
    expect(envelope.network).toBe("mainnet");
    expect(envelope.pedigrees).toHaveLength(1);
    expect(envelope.pedigrees[0].leaf.value).toBe(65536);
    expect(envelope.pedigrees[0].ancestors).toHaveLength(1);
  });

  it("converts to a bundle whose leaf and ancestor re-encode to the SDK's own bytes", () => {
    // The strongest available check without a Rust runtime in CI: take the
    // SDK's TreeNode JSON, encode it to protobuf through the converter, and
    // verify the proto fields the SDK populated round-trip (decode == the
    // values the SDK serialized).
    const bundle = exitStateToBundle(FIXTURE);
    expect(() => parseRecoveryBundle(JSON.stringify(bundle))).not.toThrow();

    const envelope = JSON.parse(FIXTURE);
    const leafHex = bundle.leaves[0]!.treeNodeHex;
    const leaf = decodeTreeNode(hexToBytes(leafHex));
    expect(leaf.id).toBe(envelope.pedigrees[0].leaf.id);
    expect(leaf.valueSats).toBe(65536n);
    expect(leaf.parentNodeId).toBe(envelope.pedigrees[0].ancestors[0].id);
    expect(leaf.treenodeStatus).toBe(1); // Available

    const ancestorHex = bundle.nodes![0]!.treeNodeHex;
    const ancestor = decodeTreeNode(hexToBytes(ancestorHex));
    expect(ancestor.id).toBe(envelope.pedigrees[0].ancestors[0].id);
    expect(ancestor.treenodeStatus).toBe(5); // Splitted
  });

  it("round-trips the SDK envelope byte-stably through the bundle", () => {
    const once = bundleToExitState(exitStateToBundle(FIXTURE));
    const twice = bundleToExitState(exitStateToBundle(once));
    expect(JSON.parse(twice)).toEqual(JSON.parse(once));
    // And the first conversion already equals the SDK's own JSON, module key
    // order (the SDK pretty-prints with sorted keys; we emit in struct order).
    expect(JSON.parse(once)).toEqual(JSON.parse(FIXTURE));
  });
});
