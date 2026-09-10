import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "@noble/curves/utils";

import { parseRecoveryBundle } from "../src/bundle.ts";
import {
  bundleToExitState,
  consensusEncodeTx,
  ExitStateConversionError,
  exitStateToBundle,
  txFromConsensus,
  type SdkTransaction,
} from "../src/exit-state-converter.ts";
import { decodeTreeNode } from "../src/operator/messages.ts";
import type { RecoveryBundle } from "../src/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const IDENTITY_KEY =
  "02e6642fd69bd211f93f7f1f36ca51a26a5290eb2dd1b0d8279a87bb0d480c8443";
const OTHER_KEY =
  "03a40561986fa647c3b67b82ceb207786608d4ddd7a5ab09d6e3b71788da3cf566";
const LEAF_ID = "019d96b8-72fb-7b0b-9a90-f3fd57e415ee";
const ROOT_ID = "019d96b8-73a4-7385-955d-411da15bca42";

/** Minimal consensus-valid segwit tx hex (1 in 1 out, one witness item). */
const TX_HEX =
  "02000000000101" +
  "5a91c8a197b7f0b2b2f1d998e6c1e7f45a50b8c6f9ee04aa3e7a3d1f65c1b1f8" + // txid (LE)
  "00000000" + // vout
  "00" + // empty scriptSig
  "ffffffff" + // sequence
  "01" + // 1 output
  "204e000000000000" + // 20_000 sats
  "1600141c0b2b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b" + // p2wpkh
  "0247" + // witness: 1 item of 0x47 bytes
  "304402202f1d3e5a6b7c8d9e0f1a2b3c4d5e6f708182838485868788898a9b9c9d9e9f0002206a1b2c3d4e5f60718293a4b5c6d7e8f900112233445566778899aabbccddeef001" +
  "21" +
  "03deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" +
  "00000000"; // locktime

/** Legacy (non-segwit) tx: no marker/flag, no witness. */
const LEGACY_TX_HEX =
  "0100000001" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "00000000" +
  "69" +
  "4630440220101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f0220404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
  "2103deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" +
  "ffffffff" +
  "01" +
  "204e000000000000" +
  "1976a914000000000000000000000000000000000000000088ac" +
  "00000000";

function txJson(): SdkTransaction {
  return txFromConsensus(hexToBytes(TX_HEX));
}

/**
 * Builds a protobuf TreeNode hex string with the fields the converter reads.
 * Field numbers per spark.proto: id=1, tree_id=2, value=3, parent=4,
 * node_tx=5, refund_tx=6, vout=7, verifying_key=8, owner_key=9,
 * signing_keyshare=10, status=11, network=12, treenode_status=19.
 */
function treeNodeHex(overrides: {
  id?: string;
  treeId?: string;
  value?: bigint;
  parentId?: string;
  nodeTx?: string;
  refundTx?: string;
  directTx?: string;
  vout?: number;
  verifyingKey?: Uint8Array;
  ownerKey?: Uint8Array;
  statusString?: string;
  treenodeStatus?: number;
  includeStatusString?: boolean;
}): string {
  const chunks: number[] = [];
  const push = (byte: number) => chunks.push(byte & 0xff);
  const pushVarint = (value: bigint) => {
    let v = value;
    while (v > 0x7fn) {
      push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    push(Number(v));
  };
  const tag = (field: number, wire: number) =>
    pushVarint(BigInt((field << 3) | wire));
  const bytes = (field: number, value: Uint8Array) => {
    if (value.length === 0) return;
    tag(field, 2);
    pushVarint(BigInt(value.length));
    for (const byte of value) push(byte);
  };
  const string = (field: number, value: string) =>
    bytes(field, new TextEncoder().encode(value));

  string(1, overrides.id ?? LEAF_ID);
  string(2, overrides.treeId ?? "test_tree");
  const value = overrides.value ?? 65536n;
  if (value > 0n) {
    tag(3, 0);
    pushVarint(value);
  }
  if (overrides.parentId) string(4, overrides.parentId);
  bytes(5, hexToBytes(overrides.nodeTx ?? TX_HEX));
  if (overrides.refundTx) bytes(6, hexToBytes(overrides.refundTx));
  if (overrides.directTx) bytes(16, hexToBytes(overrides.directTx));
  const vout = overrides.vout ?? 0;
  if (vout > 0) {
    tag(7, 0);
    pushVarint(BigInt(vout));
  }
  bytes(8, overrides.verifyingKey ?? hexToBytes(IDENTITY_KEY));
  bytes(9, overrides.ownerKey ?? hexToBytes(IDENTITY_KEY));
  // keyshare: owner_identifiers=[1], threshold=2, public_key=identity
  const keyshare: number[] = [];
  const ksPush = (byte: number) => keyshare.push(byte & 0xff);
  const ksVarint = (v: bigint) => {
    let x = v;
    while (x > 0x7fn) {
      ksPush(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    ksPush(Number(x));
  };
  ksVarint(0x0an); // field 1, wire 2: owner_identifiers entry
  // The proto field holds the identifier's 32-byte scalar as a hex string.
  const identifierHex = "0000000000000000000000000000000000000000000000000000000000000001";
  ksVarint(BigInt(identifierHex.length));
  for (const byte of new TextEncoder().encode(identifierHex)) {
    ksPush(byte);
  }
  ksVarint(0x10n); // field 2, wire 0
  ksVarint(2n);
  ksVarint(0x1an); // field 3, wire 2
  ksVarint(0x21n); // 33 bytes
  for (const byte of hexToBytes(IDENTITY_KEY)) ksPush(byte);
  tag(10, 2);
  pushVarint(BigInt(keyshare.length));
  for (const byte of keyshare) push(byte);
  if (overrides.includeStatusString !== false) {
    string(11, overrides.statusString ?? "AVAILABLE");
  }
  const treenodeStatus = overrides.treenodeStatus ?? 1;
  if (treenodeStatus > 0) {
    tag(19, 0);
    pushVarint(BigInt(treenodeStatus));
  }
  return bytesToHex(Uint8Array.from(chunks));
}

function bundle(): RecoveryBundle {
  return parseRecoveryBundle(
    JSON.stringify({
      schema: "spark.unilateral-exit-bundle.v1",
      createdAt: "2026-08-24T21:07:09.587Z",
      network: "MAINNET",
      operatorSet: "spark-sdk",
      walletIdentityPublicKey: IDENTITY_KEY,
      sparkSdkVersion: "none (direct operator export)",
      appVersion: "unknown",
      leaves: [
        {
          id: LEAF_ID,
          status: "AVAILABLE",
          valueSats: 65536,
          treeNodeHex: treeNodeHex({ parentId: ROOT_ID }),
        },
      ],
      nodes: [
        {
          id: ROOT_ID,
          treeNodeHex: treeNodeHex({
            id: ROOT_ID,
            parentId: undefined,
            value: 100000n,
            treenodeStatus: 5,
            statusString: "SPLITTED",
          }),
        },
      ],
      balances: {
        btcSats: "65536",
        usdb: { amount: "unknown", status: "not-covered-by-bitcoin-unilateral-exit" },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// transaction codec
// ---------------------------------------------------------------------------

describe("transaction consensus <-> SDK JSON", () => {
  it("round-trips a segwit transaction through the SDK JSON shape", () => {
    const json = txFromConsensus(hexToBytes(TX_HEX));
    expect(json.version).toBe(2);
    expect(json.lock_time).toBe(0);
    expect(json.input).toHaveLength(1);
    expect(json.input[0]!.previous_output).toBe(
      "f8b1c1651f3d7a3eaa04eef9c6b8505af4e7c1e698d9f1b2b2f0b797a1c8915a:0",
    );
    expect(json.input[0]!.witness).toHaveLength(2);
    expect(json.output[0]!.value).toBe(20000);

    const encoded = bytesToHex(consensusEncodeTx(json));
    expect(encoded).toBe(TX_HEX);
  });

  it("round-trips a legacy transaction", () => {
    const json = txFromConsensus(hexToBytes(LEGACY_TX_HEX));
    expect(json.version).toBe(1);
    expect(json.input[0]!.witness).toEqual([]);
    expect(bytesToHex(consensusEncodeTx(json))).toBe(LEGACY_TX_HEX);
  });

  it("encodes a zero-input transaction in segwit form", () => {
    // bitcoin's serde: no inputs -> BIP-141 serialization, matching the
    // empty node_tx the SDK test helpers produce.
    const empty: SdkTransaction = {
      version: 0,
      lock_time: 0,
      input: [],
      output: [],
    };
    expect(bytesToHex(consensusEncodeTx(empty))).toBe(
      "00000000" + "0001" + "00" + "00" + "00000000",
    );
  });

  it("rejects trailing bytes", () => {
    expect(() =>
      txFromConsensus(hexToBytes(TX_HEX + "00")),
    ).toThrow(ExitStateConversionError);
  });

  it("rejects a malformed outpoint on encode", () => {
    const json = txJson();
    json.input[0]!.previous_output = "not-an-outpoint";
    expect(() => consensusEncodeTx(json)).toThrow(ExitStateConversionError);
  });

  it("rejects an unsafe output value on encode", () => {
    const json = txJson();
    json.output[0]!.value = 2 ** 53;
    expect(() => consensusEncodeTx(json)).toThrow(ExitStateConversionError);
  });
});

// ---------------------------------------------------------------------------
// proto TreeNode <-> SDK node
// ---------------------------------------------------------------------------

describe("proto TreeNode conversion", () => {
  it("reads every modelled field out of the proto bytes", () => {
    const hex = treeNodeHex({
      vout: 3,
      refundTx: LEGACY_TX_HEX,
      treenodeStatus: 1,
    });
    const node = decodeTreeNode(hexToBytes(hex));

    // Drive through both public converters so the SdkTreeNode shape is the
    // one the converters actually produce.
    const exitState = JSON.parse(
      bundleToExitState(
        parseRecoveryBundle(
          JSON.stringify({
            schema: "spark.unilateral-exit-bundle.v1",
            createdAt: "2026-08-24T21:07:09.587Z",
            network: "MAINNET",
            walletIdentityPublicKey: IDENTITY_KEY,
            leaves: [
              { id: LEAF_ID, status: "AVAILABLE", valueSats: 65536, treeNodeHex: hex },
            ],
          }),
        ),
      ),
    );
    const leaf = exitState.pedigrees[0].leaf;
    expect(leaf.id).toBe(node.id);
    expect(leaf.tree_id).toBe("test_tree");
    expect(leaf.value).toBe(65536);
    expect(leaf.parent_node_id).toBeNull();
    expect(leaf.vout).toBe(3);
    expect(leaf.status).toBe("Available");
    expect(leaf.verifying_public_key).toBe(IDENTITY_KEY.toLowerCase());
    expect(leaf.owner_identity_public_key).toBe(IDENTITY_KEY.toLowerCase());
    expect(leaf.signing_keyshare.threshold).toBe(2);
    expect(leaf.signing_keyshare.owner_identifiers).toEqual([
      "0000000000000000000000000000000000000000000000000000000000000001",
    ]);
    expect(leaf.node_tx.version).toBe(2);
    expect(leaf.refund_tx!.version).toBe(1);
    expect(leaf.direct_tx).toBeNull();
  });

  it("maps the proto enum and the legacy string status", () => {
    const enumOnly = treeNodeHex({
      includeStatusString: false,
      treenodeStatus: 5,
    });
    const stringOnly = treeNodeHex({
      includeStatusString: true,
      statusString: "SPLITTED",
      treenodeStatus: 0,
    });
    const hexes = [enumOnly, stringOnly];
    for (const hex of hexes) {
      const exitState = JSON.parse(
        bundleToExitState(
          parseRecoveryBundle(
            JSON.stringify({
              schema: "spark.unilateral-exit-bundle.v1",
              createdAt: "2026-08-24T21:07:09.587Z",
              network: "MAINNET",
              walletIdentityPublicKey: IDENTITY_KEY,
              leaves: [{ id: LEAF_ID, treeNodeHex: hex, valueSats: 1 }],
            }),
          ),
        ),
      );
      expect(exitState.pedigrees[0].leaf.status).toBe("Splitted");
    }
  });

  it("maps unknown statuses to Unknown and back to the string field", () => {
    const unknown = treeNodeHex({ statusString: "SOMETHING_NEW", treenodeStatus: 0 });
    const exitState = JSON.parse(
      bundleToExitState(
        parseRecoveryBundle(
          JSON.stringify({
            schema: "spark.unilateral-exit-bundle.v1",
            createdAt: "2026-08-24T21:07:09.587Z",
            network: "MAINNET",
            walletIdentityPublicKey: IDENTITY_KEY,
            leaves: [{ id: LEAF_ID, treeNodeHex: unknown, valueSats: 1 }],
          }),
        ),
      ),
    );
    expect(exitState.pedigrees[0].leaf.status).toBe("Unknown");

    // Unknown has no proto value; the string field carries it back.
    const back = exitStateToBundle(exitStateToJson(exitState));
    expect(back.leaves[0]!.status).toBe("UNKNOWN");
    const decoded = decodeTreeNode(hexToBytes(back.leaves[0]!.treeNodeHex));
    expect(decoded.status).toBe("UNKNOWN");
    expect(decoded.treenodeStatus).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bundle -> exit state
// ---------------------------------------------------------------------------

function exitStateToJson(exitState: {
  version: number;
  network: string;
  identity_public_key: string;
  pedigrees: unknown[];
}): string {
  return JSON.stringify(exitState);
}

describe("bundleToExitState", () => {
  it("produces a version-1 envelope with the right network and identity", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    expect(json.version).toBe(1);
    expect(json.network).toBe("mainnet");
    expect(json.identity_public_key).toBe(IDENTITY_KEY);
    expect(json.pedigrees).toHaveLength(1);
  });

  it("groups ancestors nearest-first under the leaf's pedigree", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    const pedigree = json.pedigrees[0];
    expect(pedigree.leaf.id).toBe(LEAF_ID);
    expect(pedigree.ancestors).toHaveLength(1);
    expect(pedigree.ancestors[0].id).toBe(ROOT_ID);
    expect(pedigree.leaf.parent_node_id).toBe(ROOT_ID);
  });

  it("walks multi-level ancestor chains", () => {
    const midId = "mid-node";
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        walletIdentityPublicKey: IDENTITY_KEY,
        leaves: [{ id: LEAF_ID, treeNodeHex: treeNodeHex({}), valueSats: 1 }],
        nodes: [
          {
            id: ROOT_ID,
            treeNodeHex: treeNodeHex({ id: ROOT_ID, value: 3n, treenodeStatus: 5, statusString: "SPLITTED" }),
          },
          {
            id: midId,
            treeNodeHex: treeNodeHex({
              id: midId,
              parentId: ROOT_ID,
              value: 2n,
              treenodeStatus: 5,
              statusString: "SPLITTED",
            }),
          },
        ],
      }),
    );
    // Rewire the leaf's parent to the mid node.
    const leafHex = treeNodeHex({ parentId: midId });
    parsed.leaves[0]!.treeNodeHex = leafHex;
    const json = JSON.parse(bundleToExitState(parsed));
    expect(json.pedigrees[0].ancestors.map((a: { id: string }) => a.id)).toEqual([
      midId,
      ROOT_ID,
    ]);
  });

  it("breaks the ancestor walk on a missing parent", () => {
    const leafHex = treeNodeHex({ parentId: "no-such-node" });
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        walletIdentityPublicKey: IDENTITY_KEY,
        leaves: [{ id: LEAF_ID, treeNodeHex: leafHex, valueSats: 1 }],
        nodes: [],
      }),
    );
    const json = JSON.parse(bundleToExitState(parsed));
    expect(json.pedigrees[0].ancestors).toEqual([]);
  });

  it("rejects LOCAL networks", () => {
    const local = bundle();
    local.network = "LOCAL";
    expect(() => bundleToExitState(local)).toThrow(ExitStateConversionError);
  });

  it("infers the identity key from a leaf when the bundle lacks it", () => {
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        leaves: [{ id: LEAF_ID, treeNodeHex: treeNodeHex({}), valueSats: 1 }],
      }),
    );
    const json = JSON.parse(bundleToExitState(parsed));
    expect(json.identity_public_key).toBe(IDENTITY_KEY.toLowerCase());
  });

  it("refuses to invent an identity key", () => {
    const leafHex = treeNodeHex({ ownerKey: new Uint8Array() });
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        leaves: [{ id: LEAF_ID, treeNodeHex: leafHex, valueSats: 1 }],
      }),
    );
    expect(() => bundleToExitState(parsed)).toThrow(ExitStateConversionError);
  });

  it("keeps a declared identity key even when leaves carry another", () => {
    const leafHex = treeNodeHex({ ownerKey: hexToBytes(OTHER_KEY) });
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        walletIdentityPublicKey: IDENTITY_KEY,
        leaves: [{ id: LEAF_ID, treeNodeHex: leafHex, valueSats: 1 }],
      }),
    );
    const json = JSON.parse(bundleToExitState(parsed));
    expect(json.identity_public_key).toBe(IDENTITY_KEY);
  });
});

// ---------------------------------------------------------------------------
// exit state -> bundle
// ---------------------------------------------------------------------------

describe("exitStateToBundle", () => {
  it("produces a valid v1 bundle parseable by parseRecoveryBundle", () => {
    const back = exitStateToBundle(bundleToExitState(bundle()));
    expect(() => parseRecoveryBundle(JSON.stringify(back))).not.toThrow();
    expect(back.network).toBe("MAINNET");
    expect(back.walletIdentityPublicKey).toBe(IDENTITY_KEY);
    expect(back.leaves).toHaveLength(1);
    expect(back.leaves[0]!.id).toBe(LEAF_ID);
    expect(back.leaves[0]!.valueSats).toBe(65536);
    expect(back.nodes!.map((n) => n.id).sort()).toEqual([ROOT_ID]);
  });

  it("sums leaf values into balances.btcSats", () => {
    const back = exitStateToBundle(bundleToExitState(bundle()));
    expect(back.balances!.btcSats).toBe("65536");
  });

  it("applies operatorSet and appVersion options", () => {
    const back = exitStateToBundle(bundleToExitState(bundle()), {
      operatorSet: "breez",
      appVersion: "glow 1.2.3",
      now: () => new Date("2026-09-10T00:00:00Z"),
    });
    expect(back.operatorSet).toBe("breez");
    expect(back.appVersion).toBe("glow 1.2.3");
    expect(back.createdAt).toBe("2026-09-10T00:00:00.000Z");
  });

  it("rejects an unsupported version", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    json.version = 2;
    expect(() => exitStateToBundle(JSON.stringify(json))).toThrow(
      ExitStateConversionError,
    );
  });

  it("rejects a network the bundle cannot carry", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    json.network = "localnet";
    expect(() => exitStateToBundle(JSON.stringify(json))).toThrow(
      ExitStateConversionError,
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => exitStateToBundle("{")).toThrow(ExitStateConversionError);
  });

  it("rejects a non-object", () => {
    expect(() => exitStateToBundle("[]")).toThrow(ExitStateConversionError);
  });

  it("rejects a missing identity key", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    delete json.identity_public_key;
    expect(() => exitStateToBundle(JSON.stringify(json))).toThrow(
      ExitStateConversionError,
    );
  });

  it("rejects missing pedigrees", () => {
    const json = JSON.parse(bundleToExitState(bundle()));
    delete json.pedigrees;
    expect(() => exitStateToBundle(JSON.stringify(json))).toThrow(
      ExitStateConversionError,
    );
  });
});

// ---------------------------------------------------------------------------
// round trips
// ---------------------------------------------------------------------------

describe("round trips", () => {
  it("bundle -> exit state -> bundle preserves every treeNode hex", () => {
    const original = bundle();
    const back = exitStateToBundle(bundleToExitState(original));

    const originalLeaves = new Map(
      original.leaves.map((leaf) => [leaf.id, leaf.treeNodeHex]),
    );
    const backLeaves = new Map(
      back.leaves.map((leaf) => [leaf.id, leaf.treeNodeHex]),
    );
    expect(backLeaves).toEqual(originalLeaves);

    const originalNodes = new Map(
      (original.nodes ?? []).map((node) => [node.id, node.treeNodeHex]),
    );
    const backNodes = new Map(
      (back.nodes ?? []).map((node) => [node.id, node.treeNodeHex]),
    );
    expect(backNodes).toEqual(originalNodes);
  });

  it("bundle -> exit state -> bundle preserves the ancestor grouping", () => {
    const original = bundle();
    const back = exitStateToBundle(bundleToExitState(original));
    // The leaf's parent link survives, so a re-conversion groups identically.
    const exitState = JSON.parse(bundleToExitState(back));
    const originalExitState = JSON.parse(bundleToExitState(original));
    expect(exitState.pedigrees).toEqual(originalExitState.pedigrees);
  });

  it("exit state -> bundle -> exit state is byte-stable", () => {
    const first = bundleToExitState(bundle());
    const second = bundleToExitState(exitStateToBundle(first));
    expect(JSON.parse(second)).toEqual(JSON.parse(first));
  });

  it("round-trips SDK-only statuses through the string field", () => {
    const leafHex = treeNodeHex({ statusString: "LOST", treenodeStatus: 0 });
    const parsed = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-08-24T21:07:09.587Z",
        network: "MAINNET",
        walletIdentityPublicKey: IDENTITY_KEY,
        leaves: [{ id: LEAF_ID, treeNodeHex: leafHex, valueSats: 1 }],
      }),
    );
    const json = JSON.parse(bundleToExitState(parsed));
    expect(json.pedigrees[0].leaf.status).toBe("Lost");
    const back = exitStateToBundle(JSON.stringify(json));
    expect(back.leaves[0]!.status).toBe("LOST");
  });
});
