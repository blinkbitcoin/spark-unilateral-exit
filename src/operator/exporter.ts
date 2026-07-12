// Fetches the wallet's leaves and their full ancestor chains straight from
// the Spark operators - the data a recovery bundle needs and the seed alone
// cannot reconstruct once operators are offline.
//
// Flow: authenticate to the coordinator with the seed-derived identity key, page
// through query_nodes(owner, include_parents=true), then verify every leaf's
// ancestor chain is closed - re-fetching missing ancestors by node id, which
// bypasses the operators' root-skip bug on legacy mainnet trees. A bundle
// with an open chain is unusable for exit, so incompleteness is an error.
//
// Mirrors app/self-custodial/recovery-bundle/exporter.ts in blink-mobile;
// keep the two in sync.

import { bytesToHex } from "@noble/curves/utils";

import { grpcWebUnaryCall, type FetchLike } from "./grpc-web.ts";
import { deriveIdentityKeyPair, signChallenge, type IdentityKeyPair } from "./identity.ts";
import {
  decodeGetChallengeResponse,
  decodeQueryNodesResponse,
  decodeVerifyChallengeResponse,
  encodeChallenge,
  encodeGetChallengeRequest,
  encodeQueryNodesRequest,
  encodeVerifyChallengeRequest,
  SparkProtoNetwork,
  TREE_NODE_STATUS_AVAILABLE,
  type DecodedTreeNode,
} from "./messages.ts";

/** Operator id 0 is the pool coordinator in the Spark SDK's default config. */
export const SPARK_COORDINATOR_URL = "https://0.spark.lightspark.com";

const GET_CHALLENGE_PATH = "/spark_authn.SparkAuthnService/get_challenge";
const VERIFY_CHALLENGE_PATH = "/spark_authn.SparkAuthnService/verify_challenge";
const QUERY_NODES_PATH = "/spark.SparkService/query_nodes";

const DEFAULT_PAGE_SIZE = 100;
/** Chain walks converge in one refetch round; the cap only guards operator misbehavior. */
const MAX_ANCESTOR_REFETCH_ROUNDS = 10;

export class OperatorExportError extends Error {
  readonly reason: "no-leaves" | "incomplete-chain";

  constructor(reason: "no-leaves" | "incomplete-chain", message: string) {
    super(message);
    this.name = "OperatorExportError";
    this.reason = reason;
  }
}

function protoNetworkFor(network: string): SparkProtoNetwork {
  switch (network.toUpperCase()) {
    case "MAINNET":
      return SparkProtoNetwork.Mainnet;
    case "TESTNET":
      return SparkProtoNetwork.Testnet;
    case "SIGNET":
      return SparkProtoNetwork.Signet;
    // Spark treats a local stack as regtest
    default:
      return SparkProtoNetwork.Regtest;
  }
}

async function authenticate(
  baseUrl: string,
  keyPair: IdentityKeyPair,
  fetchImpl?: FetchLike,
): Promise<string> {
  const challengeResponse = await grpcWebUnaryCall({
    baseUrl,
    methodPath: GET_CHALLENGE_PATH,
    request: encodeGetChallengeRequest(keyPair.publicKey),
    fetchImpl,
  });
  const protectedChallenge = decodeGetChallengeResponse(challengeResponse);

  const signatureDer = signChallenge(
    encodeChallenge(protectedChallenge.challenge),
    keyPair.privateKey,
  );

  const verifyResponse = await grpcWebUnaryCall({
    baseUrl,
    methodPath: VERIFY_CHALLENGE_PATH,
    request: encodeVerifyChallengeRequest({
      protectedChallengeRaw: protectedChallenge.raw,
      signatureDer,
      publicKey: keyPair.publicKey,
    }),
    fetchImpl,
  });
  const { sessionToken } = decodeVerifyChallengeResponse(verifyResponse);
  return `Bearer ${sessionToken}`;
}

interface QueryContext {
  baseUrl: string;
  authorization: string;
  network: SparkProtoNetwork;
  pageSize: number;
  fetchImpl?: FetchLike;
}

async function queryNodesByOwner(
  context: QueryContext,
  ownerIdentityPublicKey: Uint8Array,
): Promise<Map<string, DecodedTreeNode>> {
  const nodes = new Map<string, DecodedTreeNode>();
  let offset = 0;

  for (;;) {
    const response = decodeQueryNodesResponse(
      await grpcWebUnaryCall({
        baseUrl: context.baseUrl,
        methodPath: QUERY_NODES_PATH,
        authorization: context.authorization,
        fetchImpl: context.fetchImpl,
        request: encodeQueryNodesRequest({
          ownerIdentityPublicKey,
          includeParents: true,
          limit: context.pageSize,
          offset,
          network: context.network,
        }),
      }),
    );
    for (const [id, node] of response.nodes) nodes.set(id, node);
    if (response.nodes.size === 0 || response.offset <= 0n) break;
    offset += context.pageSize;
  }

  return nodes;
}

async function queryNodesByIds(
  context: QueryContext,
  nodeIds: string[],
): Promise<Map<string, DecodedTreeNode>> {
  const nodes = new Map<string, DecodedTreeNode>();
  for (let start = 0; start < nodeIds.length; start += context.pageSize) {
    const response = decodeQueryNodesResponse(
      await grpcWebUnaryCall({
        baseUrl: context.baseUrl,
        methodPath: QUERY_NODES_PATH,
        authorization: context.authorization,
        fetchImpl: context.fetchImpl,
        request: encodeQueryNodesRequest({
          nodeIds: nodeIds.slice(start, start + context.pageSize),
          includeParents: true,
          limit: context.pageSize,
          offset: 0,
          network: context.network,
        }),
      }),
    );
    for (const [id, node] of response.nodes) nodes.set(id, node);
  }
  return nodes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function isAvailableOwnerLeaf(
  node: DecodedTreeNode,
  identityPublicKey: Uint8Array,
): boolean {
  return (
    (node.treenodeStatus === TREE_NODE_STATUS_AVAILABLE ||
      node.status.toUpperCase() === "AVAILABLE") &&
    bytesEqual(node.ownerIdentityPublicKey, identityPublicKey)
  );
}

/** Node ids whose parents are referenced but absent from the map. */
export function findMissingAncestors(
  leaves: DecodedTreeNode[],
  nodes: Map<string, DecodedTreeNode>,
): string[] {
  const missing = new Set<string>();
  for (const leaf of leaves) {
    let current: DecodedTreeNode | undefined = leaf;
    const visited = new Set<string>();
    while (current?.parentNodeId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent: DecodedTreeNode | undefined = nodes.get(current.parentNodeId);
      if (!parent) {
        missing.add(current.parentNodeId);
        break;
      }
      current = parent;
    }
  }
  return [...missing];
}

export interface OperatorLeafSet {
  identityPublicKeyHex: string;
  /** Available leaves owned by the identity, ascending by id. */
  leaves: DecodedTreeNode[];
  /** Every node returned (leaves + all ancestors), ascending by id. */
  nodes: DecodedTreeNode[];
  totalSats: bigint;
}

export interface FetchLeafSetOptions {
  seed: string;
  network: string;
  accountNumber?: number;
  passphrase?: string;
  coordinatorUrl?: string;
  pageSize?: number;
  fetchImpl?: FetchLike;
}

export async function fetchOwnedLeafSet({
  seed,
  network,
  accountNumber,
  passphrase,
  coordinatorUrl = SPARK_COORDINATOR_URL,
  pageSize = DEFAULT_PAGE_SIZE,
  fetchImpl,
}: FetchLeafSetOptions): Promise<OperatorLeafSet> {
  const keyPair = deriveIdentityKeyPair(seed, network, accountNumber, passphrase);

  const context: QueryContext = {
    baseUrl: coordinatorUrl,
    authorization: await authenticate(coordinatorUrl, keyPair, fetchImpl),
    network: protoNetworkFor(network),
    pageSize,
    fetchImpl,
  };

  const nodes = await queryNodesByOwner(context, keyPair.publicKey);
  const leaves = [...nodes.values()].filter((node) =>
    isAvailableOwnerLeaf(node, keyPair.publicKey),
  );

  if (leaves.length === 0) {
    throw new OperatorExportError(
      "no-leaves",
      "Spark operators returned no available leaves for this wallet",
    );
  }

  // The bulk owner query can omit tree roots on legacy mainnet trees; by-id
  // queries do not, so re-fetch missing ancestors until every chain closes.
  for (let round = 0; round < MAX_ANCESTOR_REFETCH_ROUNDS; round += 1) {
    const missing = findMissingAncestors(leaves, nodes);
    if (missing.length === 0) break;
    const fetched = await queryNodesByIds(context, missing);
    const stillMissing = missing.filter((id) => !fetched.has(id));
    if (stillMissing.length > 0) {
      throw new OperatorExportError(
        "incomplete-chain",
        `Exit chain incomplete: ancestors not returned by operators: ${stillMissing.join(", ")}`,
      );
    }
    for (const [id, node] of fetched) nodes.set(id, node);
  }

  const unresolved = findMissingAncestors(leaves, nodes);
  if (unresolved.length > 0) {
    throw new OperatorExportError(
      "incomplete-chain",
      `Exit chain incomplete after refetch: ${unresolved.join(", ")}`,
    );
  }

  const byIdAsc = <T extends { id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));

  return {
    identityPublicKeyHex: bytesToHex(keyPair.publicKey),
    leaves: byIdAsc(leaves),
    nodes: byIdAsc([...nodes.values()]),
    totalSats: leaves.reduce((sum, leaf) => sum + leaf.valueSats, 0n),
  };
}
