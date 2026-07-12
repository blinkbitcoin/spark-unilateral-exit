import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/curves/utils";

import { deriveIdentityKeyPair } from "../src/operator/identity.ts";
import type { FetchLike } from "../src/operator/grpc-web.ts";
import { ProtoWriter, decodeFields, firstField, utf8Decode } from "../src/operator/wire.ts";
import {
  RecoveryBundleExportError,
  exportRecoveryBundleFromSeed,
} from "../src/recovery-bundle.ts";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// --- test-side encoders for operator responses ---

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = flag;
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

function grpcBody(message: Uint8Array): Uint8Array {
  const messageFrame = frame(0, message);
  const trailer = frame(0x80, new TextEncoder().encode("grpc-status: 0"));
  const body = new Uint8Array(messageFrame.length + trailer.length);
  body.set(messageFrame, 0);
  body.set(trailer, messageFrame.length);
  return body;
}

interface TestNode {
  id: string;
  valueSats: number;
  parentNodeId?: string;
  owner: Uint8Array;
  available: boolean;
}

function encodeTreeNode(node: TestNode): Uint8Array {
  const writer = new ProtoWriter()
    .string(1, node.id)
    .string(2, "tree-1")
    .varint(3, node.valueSats);
  if (node.parentNodeId) writer.string(4, node.parentNodeId);
  return writer
    .bytes(9, node.owner)
    .string(11, node.available ? "AVAILABLE" : "SPLITTED")
    .varint(19, node.available ? 1 : 5)
    .finish();
}

function encodeQueryNodesResponse(nodes: TestNode[]): Uint8Array {
  const writer = new ProtoWriter();
  for (const node of nodes) {
    writer.bytes(
      1,
      new ProtoWriter().string(1, node.id).bytes(2, encodeTreeNode(node)).finish(),
    );
  }
  // offset omitted (0) terminates the exporter's paging loop
  return writer.finish();
}

function encodeChallengeResponse(): Uint8Array {
  const challenge = new ProtoWriter()
    .varint(1, 1)
    .varint(2, 1752300000)
    .bytes(3, new Uint8Array(32).fill(0x11))
    .finish();
  const protectedChallenge = new ProtoWriter()
    .varint(1, 1)
    .bytes(2, challenge)
    .bytes(3, new Uint8Array(32).fill(0xaa))
    .finish();
  return new ProtoWriter().bytes(1, protectedChallenge).finish();
}

function encodeVerifyResponse(): Uint8Array {
  return new ProtoWriter().string(1, "session-token").varint(2, 9999999999).finish();
}

/** A fake operator behind the exporter's fetch seam. */
function mockOperator({
  ownerQueryNodes,
  byIdNodes,
}: {
  ownerQueryNodes: TestNode[];
  byIdNodes: Record<string, TestNode>;
}): { fetchImpl: FetchLike; byIdRequests: string[][] } {
  const byIdRequests: string[][] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    const respond = (message: Uint8Array) => {
      const body = grpcBody(message);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
      };
    };

    if (url.endsWith("/spark_authn.SparkAuthnService/get_challenge")) {
      return respond(encodeChallengeResponse());
    }
    if (url.endsWith("/spark_authn.SparkAuthnService/verify_challenge")) {
      return respond(encodeVerifyResponse());
    }
    if (url.endsWith("/spark.SparkService/query_nodes")) {
      const request = decodeFields(Uint8Array.from(init.body).subarray(5));
      const nodeIdsField = firstField(request, 2);
      if (!nodeIdsField?.bytes) {
        return respond(encodeQueryNodesResponse(ownerQueryNodes));
      }
      const requestedIds = decodeFields(nodeIdsField.bytes).map((f) =>
        utf8Decode(f.bytes ?? new Uint8Array(0)),
      );
      byIdRequests.push(requestedIds);
      const found = requestedIds
        .map((id) => byIdNodes[id])
        .filter((n): n is TestNode => Boolean(n));
      return respond(encodeQueryNodesResponse(found));
    }
    throw new Error(`unexpected url: ${url}`);
  };

  return { fetchImpl, byIdRequests };
}

describe("exportRecoveryBundleFromSeed", () => {
  const identity = () =>
    deriveIdentityKeyPair(TEST_MNEMONIC, "MAINNET").publicKey;
  const otherOwner = new Uint8Array(33).fill(0x03);

  const exportOptions = (fetchImpl: FetchLike) => ({
    seed: TEST_MNEMONIC,
    network: "mainnet",
    appVersion: "test",
    now: () => new Date("2026-06-15T00:00:00.000Z"),
    fetchImpl,
  });

  it("assembles a bundle, re-fetching the root omitted by the owner query", async () => {
    const owner = identity();
    const leaf: TestNode = {
      id: "leaf-1",
      valueSats: 32768,
      parentNodeId: "mid-1",
      owner,
      available: true,
    };
    const mid: TestNode = {
      id: "mid-1",
      valueSats: 65536,
      parentNodeId: "root-1",
      owner: otherOwner,
      available: false,
    };
    const root: TestNode = {
      id: "root-1",
      valueSats: 100000,
      owner: otherOwner,
      available: false,
    };

    // Owner query omits the tree root (the legacy-tree operator bug)
    const { fetchImpl, byIdRequests } = mockOperator({
      ownerQueryNodes: [leaf, mid],
      byIdNodes: { "root-1": root },
    });

    const bundle = await exportRecoveryBundleFromSeed(exportOptions(fetchImpl));

    expect(byIdRequests).toEqual([["root-1"]]);
    expect(bundle).toMatchObject({
      schema: "spark.unilateral-exit-bundle.v1",
      createdAt: "2026-06-15T00:00:00.000Z",
      network: "MAINNET",
      operatorSet: "spark-sdk",
      walletIdentityPublicKey: bytesToHex(owner),
      appVersion: "test",
      balances: {
        btcSats: "32768",
        usdb: { status: "not-covered-by-bitcoin-unilateral-exit" },
      },
    });
    expect(bundle.leaves).toEqual([
      {
        id: "leaf-1",
        status: "AVAILABLE",
        valueSats: 32768,
        treeNodeHex: bytesToHex(encodeTreeNode(leaf)),
      },
    ]);
    expect(bundle.nodes?.map((n) => n.id)).toEqual(["leaf-1", "mid-1", "root-1"]);
    expect(bundle.nodes?.[2]?.treeNodeHex).toBe(bytesToHex(encodeTreeNode(root)));
  });

  it("refuses to build a bundle with an open exit chain", async () => {
    const leaf: TestNode = {
      id: "leaf-1",
      valueSats: 1000,
      parentNodeId: "root-1",
      owner: identity(),
      available: true,
    };
    const { fetchImpl } = mockOperator({ ownerQueryNodes: [leaf], byIdNodes: {} });

    await expect(
      exportRecoveryBundleFromSeed(exportOptions(fetchImpl)),
    ).rejects.toMatchObject({
      name: "RecoveryBundleExportError",
      reason: "incomplete-chain",
    });
  });

  it("errors when the wallet has no available leaves", async () => {
    const { fetchImpl } = mockOperator({ ownerQueryNodes: [], byIdNodes: {} });

    await expect(
      exportRecoveryBundleFromSeed(exportOptions(fetchImpl)),
    ).rejects.toMatchObject({ name: "RecoveryBundleExportError", reason: "no-leaves" });
  });

  it("excludes leaves owned by other identities", async () => {
    const mine: TestNode = {
      id: "leaf-mine",
      valueSats: 100,
      owner: identity(),
      available: true,
    };
    const theirs: TestNode = {
      id: "leaf-theirs",
      valueSats: 999,
      owner: otherOwner,
      available: true,
    };
    const { fetchImpl } = mockOperator({
      ownerQueryNodes: [mine, theirs],
      byIdNodes: {},
    });

    const bundle = await exportRecoveryBundleFromSeed(exportOptions(fetchImpl));
    expect(bundle.leaves.map((l) => l.id)).toEqual(["leaf-mine"]);
    expect(bundle.balances?.btcSats).toBe("100");
  });

  it("rejects missing seed input", async () => {
    await expect(exportRecoveryBundleFromSeed()).rejects.toThrow(/required/);
  });

  it("rejects unsupported networks", async () => {
    await expect(
      exportRecoveryBundleFromSeed({ seed: TEST_MNEMONIC, network: "nope" }),
    ).rejects.toThrow(RecoveryBundleExportError);
  });
});
