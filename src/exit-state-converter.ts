// Converter between the recovery bundle (`spark.unilateral-exit-bundle.v1`,
// this repo's own format, shared with the Blink mobile app) and the Breez
// Spark SDK's unilateral-exit state (`exportUnilateralExitState`'s
// `ExitStateEnvelope`, the format inside a glow-web backup zip).
//
// Both formats carry the same payload: each Spark leaf as a protobuf
// `TreeNode` (bundle: hex in `leaves[]`/`nodes[]`) or as the serde JSON of
// spark::tree::TreeNode (exit state: `pedigrees[].leaf`/`ancestors`), plus the
// network and the wallet identity key.
//
// Round-trip guarantee: converting either way and back preserves the protobuf
// wire bytes of every leaf and of every ancestor still reachable from a leaf
// by parent links, because the SDK JSON is re-encoded through the same
// canonical field order the operators emit. Two documented losses:
//
//   1. Proto fields the SDK TreeNode model does not carry (network=12,
//      created/updated timestamps, owner_signing_public_key=15, keyshare
//      public_shares) are dropped, exactly as the SDK itself drops them when
//      it imports operator nodes.
//   2. Ancestor entries in nodes[] that no leaf reaches by walking parent
//      links (terminal ON_CHAIN/EXITED leftovers) have no pedigree to live in
//      and are dropped; the SDK's own export_exit_state would not have
//      produced them either.
//
// Metadata the exit state cannot hold (balances, provenance) becomes a
// neutral default rather than an invented value.

import { bytesToHex, hexToBytes } from "@noble/curves/utils";

import { decodeTreeNode, type DecodedTreeNode } from "./operator/messages.ts";
import { decodeFields, ProtoWriter, type WireField } from "./operator/wire.ts";
import type { RecoveryBundle } from "./types.ts";

/** spark_wallet::Network serde names, as the SDK envelope spells them. */
const SDK_NETWORK: Record<string, string> = {
  MAINNET: "mainnet",
  REGTEST: "regtest",
  TESTNET: "testnet",
  SIGNET: "signet",
};
const NETWORK_FROM_SDK: Record<string, string> = {
  mainnet: "MAINNET",
  regtest: "REGTEST",
  testnet: "TESTNET",
  signet: "SIGNET",
};

/**
 * TreeNodeStatus names of spark::tree::TreeNodeStatus keyed by the proto
 * enum value. Index 11 (proto UNAVAILABLE) and anything unrecognized have no
 * SDK variant and land on `Unknown`.
 */
const STATUS_BY_PROTO: Record<number, string> = {
  0: "Creating",
  1: "Available",
  2: "FrozenByIssuer",
  3: "TransferLocked",
  4: "SplitLocked",
  5: "Splitted",
  6: "Aggregated",
  7: "OnChain",
  8: "AggregateLock",
  9: "Exited",
  10: "RenewLocked",
  12: "ParentExited",
};
/** SDK status name to proto enum value; -1 marks SDK-only statuses. */
const STATUS_TO_PROTO: Record<string, number> = {
  Creating: 0,
  Available: 1,
  FrozenByIssuer: 2,
  TransferLocked: 3,
  SplitLocked: 4,
  Splitted: 5,
  Aggregated: 6,
  OnChain: 7,
  AggregateLock: 8,
  Exited: 9,
  RenewLocked: 10,
  ParentExited: 12,
  Investigation: -1,
  Lost: -1,
  Reimbursed: -1,
};

/** Operator legacy string statuses (SCREAMING_SNAKE) to SDK variant names. */
const STATUS_FROM_STRING: Record<string, string> = Object.fromEntries(
  Object.keys(STATUS_TO_PROTO)
    .filter((name) => name !== "Unknown")
    .map((name) => [name.toUpperCase(), name]),
);

export class ExitStateConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExitStateConversionError";
  }
}

export const EXIT_STATE_VERSION = 1;

/** Mirror of the SDK's `ExitStateEnvelope` JSON (version 1). */
export interface ExitStateEnvelope {
  version: number;
  network: string;
  identity_public_key: string;
  pedigrees: Array<{
    leaf: SdkTreeNode;
    ancestors: SdkTreeNode[];
  }>;
}

/**
 * Mirror of spark::tree::TreeNode's serde JSON. Transactions use the
 * bitcoin crate's human-readable serde shapes.
 */
export interface SdkTreeNode {
  id: string;
  tree_id: string;
  value: number;
  parent_node_id: string | null;
  node_tx: SdkTransaction;
  refund_tx: SdkTransaction | null;
  direct_tx: SdkTransaction | null;
  direct_refund_tx: SdkTransaction | null;
  direct_from_cpfp_refund_tx: SdkTransaction | null;
  vout: number;
  verifying_public_key: string;
  owner_identity_public_key: string | null;
  signing_keyshare: {
    owner_identifiers: string[];
    threshold: number;
    public_key: string;
  };
  status: string;
}

/** bitcoin::Transaction serde shape (bitcoin 0.32, human-readable). */
export interface SdkTransaction {
  version: number;
  lock_time: number;
  input: Array<{
    previous_output: string;
    script_sig: string;
    sequence: number;
    witness: string[];
  }>;
  output: Array<{
    value: number;
    script_pubkey: string;
  }>;
}

// ---------------------------------------------------------------------------
// bundle -> exit state
// ---------------------------------------------------------------------------

/**
 * Converts a recovery bundle to the SDK's exit-state JSON. The bundle's
 * network must be one the SDK envelope can carry (MAINNET, TESTNET, SIGNET,
 * REGTEST); LOCAL belongs to a private stack the SDK has no enum for.
 */
export function bundleToExitState(bundle: RecoveryBundle): string {
  const network = SDK_NETWORK[bundle.network];
  if (!network) {
    throw new ExitStateConversionError(
      `Bundle network ${bundle.network} has no exit-state equivalent`,
    );
  }
  const grouped = groupBundleNodes(bundle);
  const envelope: ExitStateEnvelope = {
    version: EXIT_STATE_VERSION,
    network,
    identity_public_key: requireIdentityKey(bundle, grouped.ownerKeyHex),
    pedigrees: grouped.pedigrees,
  };
  return JSON.stringify(envelope);
}

interface BundlePedigrees {
  pedigrees: ExitStateEnvelope["pedigrees"];
  ownerKeyHex: string | null;
}

/**
 * Groups the bundle's leaves and ancestor nodes into SDK pedigrees. A leaf's
 * ancestors walk parent links through the bundled ancestor nodes, nearest
 * first, which is the order the SDK's store loads exit chains in.
 */
function groupBundleNodes(bundle: RecoveryBundle): BundlePedigrees {
  const ancestorsById = new Map<string, DecodedTreeNode>();
  for (const node of bundle.nodes ?? []) {
    ancestorsById.set(node.id, decodeTreeNode(hexToBytes(node.treeNodeHex)));
  }

  const pedigrees: ExitStateEnvelope["pedigrees"] = [];
  let ownerKeyHex: string | null = null;
  for (const leafEntry of bundle.leaves) {
    const leaf = decodeTreeNode(hexToBytes(leafEntry.treeNodeHex));
    if (ownerKeyHex === null && leaf.ownerIdentityPublicKey.length > 0) {
      ownerKeyHex = bytesToHex(leaf.ownerIdentityPublicKey);
    }
    const ancestors: DecodedTreeNode[] = [];
    const seen = new Set<string>([leaf.id]);
    let cursor: DecodedTreeNode | undefined = leaf;
    while (cursor?.parentNodeId && !seen.has(cursor.parentNodeId)) {
      const parent = ancestorsById.get(cursor.parentNodeId);
      if (!parent) break;
      ancestors.push(parent);
      seen.add(parent.id);
      cursor = parent;
    }
    pedigrees.push({
      leaf: sdkNodeFromProto(leaf),
      ancestors: ancestors.map(sdkNodeFromProto),
    });
  }
  return { pedigrees, ownerKeyHex };
}

function requireIdentityKey(
  bundle: RecoveryBundle,
  ownerKeyHex: string | null,
): string {
  const declared = bundle.walletIdentityPublicKey?.trim();
  if (isNonEmptyString(declared)) return declared;
  if (ownerKeyHex) return ownerKeyHex;
  throw new ExitStateConversionError(
    "Cannot infer identity_public_key: the bundle has no walletIdentityPublicKey and no leaf carries an owner key",
  );
}

// ---------------------------------------------------------------------------
// exit state -> bundle
// ---------------------------------------------------------------------------

export interface ExitStateToBundleOptions {
  operatorSet?: string;
  appVersion?: string;
  now?: () => Date;
}

/**
 * Converts the SDK's exit-state JSON to a recovery bundle. Provenance the
 * exit state does not carry (`operatorSet`, `appVersion`, `sparkSdkVersion`)
 * comes from the options or a neutral default.
 */
export function exitStateToBundle(
  exitStateJson: string,
  options: ExitStateToBundleOptions = {},
): RecoveryBundle {
  const envelope = parseExitStateEnvelope(exitStateJson);
  const network = NETWORK_FROM_SDK[envelope.network];
  if (!network) {
    throw new ExitStateConversionError(
      `Exit state network ${envelope.network} has no bundle equivalent`,
    );
  }

  const leaves: RecoveryBundle["leaves"] = [];
  const nodes: RecoveryBundle["nodes"] = [];
  const ancestorHexById = new Map<string, string>();
  for (const pedigree of envelope.pedigrees) {
    leaves.push({
      id: pedigree.leaf.id,
      status: bundleStatus(pedigree.leaf),
      valueSats: pedigree.leaf.value,
      treeNodeHex: treeNodeHexFromSdk(pedigree.leaf),
    });
    // The bundle format keeps only ancestors in nodes[]; leaf hexes live in
    // leaves[] and carry their own parent links.
    for (const ancestor of pedigree.ancestors) {
      if (!ancestorHexById.has(ancestor.id)) {
        ancestorHexById.set(ancestor.id, treeNodeHexFromSdk(ancestor));
      }
    }
  }
  for (const [id, treeNodeHex] of ancestorHexById) {
    nodes.push({ id, treeNodeHex });
  }

  return {
    schema: "spark.unilateral-exit-bundle.v1",
    createdAt: options.now?.().toISOString() ?? new Date().toISOString(),
    network,
    operatorSet: isNonEmptyString(options.operatorSet)
      ? options.operatorSet
      : "spark-sdk",
    walletIdentityPublicKey: envelope.identity_public_key,
    sparkSdkVersion: "converted from breez exit state v1",
    appVersion: isNonEmptyString(options.appVersion)
      ? options.appVersion
      : "unknown",
    leaves,
    nodes,
    balances: {
      btcSats: envelope.pedigrees
        .reduce((sum, pedigree) => sum + pedigree.leaf.value, 0)
        .toString(),
      usdb: {
        amount: "unknown",
        status: "not-covered-by-bitcoin-unilateral-exit",
      },
    },
  };
}

function parseExitStateEnvelope(raw: string): ExitStateEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExitStateConversionError(
      `Invalid JSON exit state: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExitStateConversionError("Exit state must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== EXIT_STATE_VERSION) {
    throw new ExitStateConversionError(
      `Unsupported exit state version ${String(record.version)}, expected ${EXIT_STATE_VERSION}`,
    );
  }
  if (!isNonEmptyString(record.network)) {
    throw new ExitStateConversionError("Exit state network is required");
  }
  if (!isNonEmptyString(record.identity_public_key)) {
    throw new ExitStateConversionError(
      "Exit state identity_public_key is required",
    );
  }
  if (!Array.isArray(record.pedigrees)) {
    throw new ExitStateConversionError("Exit state pedigrees must be an array");
  }
  return parsed as ExitStateEnvelope;
}

/** Bundle statuses keep the operator's SCREAMING_SNAKE spelling. */
function bundleStatus(node: SdkTreeNode): string {
  return node.status.toUpperCase();
}

// ---------------------------------------------------------------------------
// protobuf TreeNode <-> SDK JSON node
// ---------------------------------------------------------------------------

function sdkNodeFromProto(node: DecodedTreeNode): SdkTreeNode {
  const fields = decodeFields(node.raw);
  const txField = (n: number): SdkTransaction | null => {
    const bytes = firstBytes(fields, n);
    return bytes ? txFromConsensus(bytes) : null;
  };
  const keyshareBytes = firstBytes(fields, 10);
  const keyshareFields = keyshareBytes ? decodeFields(keyshareBytes) : [];

  return {
    id: node.id,
    tree_id: utf8(firstBytes(fields, 2)) ?? "",
    value: requireSafeValue(node.valueSats, node.id),
    parent_node_id: node.parentNodeId ?? null,
    node_tx: txField(5) ?? emptyTx(),
    refund_tx: txField(6),
    direct_tx: txField(16),
    direct_refund_tx: txField(17),
    direct_from_cpfp_refund_tx: txField(18),
    vout: Number(firstVarint(fields, 7) ?? 0n),
    verifying_public_key: bytesToHex(firstBytes(fields, 8) ?? new Uint8Array()),
    owner_identity_public_key:
      node.ownerIdentityPublicKey.length > 0
        ? bytesToHex(node.ownerIdentityPublicKey)
        : null,
    signing_keyshare: {
      owner_identifiers: keyshareIdentifiers(keyshareFields),
      threshold: Number(firstVarint(keyshareFields, 2) ?? 0n),
      public_key: bytesToHex(
        firstBytes(keyshareFields, 3) ?? new Uint8Array(),
      ),
    },
    status: statusFromProto(node),
  };
}

function statusFromProto(node: DecodedTreeNode): string {
  // Same precedence as the SDK's proto import: the legacy string field wins,
  // the typed enum backs it up when the operator omitted the string.
  if (node.status) {
    return STATUS_FROM_STRING[node.status.toUpperCase()] ?? "Unknown";
  }
  if (node.treenodeStatus !== 0) {
    return STATUS_BY_PROTO[node.treenodeStatus] ?? "Unknown";
  }
  return "Unknown";
}

/**
 * Owner identifiers cross the wire as a hex string in both directions: the
 * proto field holds the hex of the 32-byte FROST scalar, and the SDK serde
 * emits the same bytes as lowercase hex.
 */
function keyshareIdentifiers(keyshareFields: WireField[]): string[] {
  const identifiers: string[] = [];
  for (const field of keyshareFields) {
    if (field.fieldNumber === 1 && field.bytes) {
      identifiers.push(new TextDecoder().decode(field.bytes));
    }
  }
  return identifiers;
}

function treeNodeHexFromSdk(node: SdkTreeNode): string {
  const writer = new ProtoWriter();
  writer.string(1, node.id);
  writer.string(2, node.tree_id);
  writer.varint(3, node.value);
  if (node.parent_node_id !== null) writer.string(4, node.parent_node_id);
  writer.bytes(5, consensusEncodeTx(node.node_tx));
  if (node.refund_tx) writer.bytes(6, consensusEncodeTx(node.refund_tx));
  writer.varint(7, node.vout);
  writer.bytes(8, hexToBytes(node.verifying_public_key));
  if (node.owner_identity_public_key !== null) {
    writer.bytes(9, hexToBytes(node.owner_identity_public_key));
  }
  const keyshare = new ProtoWriter();
  for (const identifier of node.signing_keyshare.owner_identifiers) {
    keyshare.string(1, identifier);
  }
  keyshare.varint(2, node.signing_keyshare.threshold);
  keyshare.bytes(3, hexToBytes(node.signing_keyshare.public_key));
  writer.bytes(10, keyshare.finish());
  const protoStatus = STATUS_TO_PROTO[node.status];
  if (protoStatus !== undefined && protoStatus >= 0) {
    writer.string(11, node.status.toUpperCase());
    writer.varint(19, protoStatus);
  } else {
    // Unknown to this map or SDK-only (Lost, ...): the legacy string field is
    // the only slot the proto has for it.
    writer.string(11, node.status.toUpperCase());
  }
  return bytesToHex(writer.finish());
}

// ---------------------------------------------------------------------------
// bitcoin transaction: consensus <-> SDK JSON
// ---------------------------------------------------------------------------

function emptyTx(): SdkTransaction {
  return { version: 0, lock_time: 0, input: [], output: [] };
}

/** Parses consensus transaction bytes into the SDK's serde JSON shape. */
export function txFromConsensus(raw: Uint8Array): SdkTransaction {
  let offset = 0;
  const u8 = () => {
    if (offset >= raw.length) {
      throw new ExitStateConversionError("Transaction ended mid-field");
    }
    return raw[offset++]!;
  };
  const u32 = () =>
    (u8() | (u8() << 8) | (u8() << 16) | (u8() << 24)) >>> 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = u8();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
  };
  const read = (length: number) => {
    if (offset + length > raw.length) {
      throw new ExitStateConversionError("Transaction ended mid-field");
    }
    const slice = raw.slice(offset, offset + length);
    offset += length;
    return slice;
  };

  const version = u32();
  let inputCount = Number(varint());
  let segwit = false;
  if (inputCount === 0) {
    // BIP-144: a zero input count is followed by the segwit marker (0x00,
    // already consumed as that input count) and flag. A flag of exactly 1
    // marks BIP-144 witnesses; anything else is not a consensus-encoded
    // transaction this parser can read.
    const flag = u8();
    if (flag === 1) {
      segwit = true;
      inputCount = Number(varint());
    } else {
      throw new ExitStateConversionError(
        `Unsupported segwit flag ${flag}`,
      );
    }
  }
  const input = Array.from({ length: inputCount }, () => {
    const txid = read(32);
    const vout = u32();
    const scriptSig = read(Number(varint()));
    const sequence = u32();
    return { txid: bytesToHex(txid.reverse()), vout, scriptSig, sequence };
  });
  const output = Array.from({ length: Number(varint()) }, () => {
    // Amount is u64: read as two LE u32 halves to stay exact past 2^53 only
    // up to the sats any real output carries; beyond that the value check
    // below rejects rather than silently rounding.
    const low = u32();
    const high = u32();
    const value = high * 4294967296 + low;
    if (!Number.isSafeInteger(value)) {
      throw new ExitStateConversionError(
        `Output value ${value} exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    const script = read(Number(varint()));
    return { value, script };
  });
  const witness = input.map(() => {
    if (!segwit) return [];
    return Array.from({ length: Number(varint()) }, () =>
      bytesToHex(read(Number(varint()))),
    );
  });
  const lockTime = u32();
  if (offset !== raw.length) {
    throw new ExitStateConversionError(
      `Transaction has ${raw.length - offset} trailing bytes`,
    );
  }

  return {
    version: signed32(version),
    lock_time: lockTime,
    input: input.map((entry, i) => ({
      previous_output: `${entry.txid}:${entry.vout}`,
      script_sig: bytesToHex(entry.scriptSig),
      sequence: entry.sequence,
      witness: witness[i] ?? [],
    })),
    output: output.map((entry) => ({
      value: entry.value,
      script_pubkey: bytesToHex(entry.script),
    })),
  };
}

/** Encodes the SDK's serde JSON shape back to consensus transaction bytes. */
export function consensusEncodeTx(tx: SdkTransaction): Uint8Array {
  const segwit =
    tx.input.length === 0 || tx.input.some((i) => i.witness.length > 0);
  const chunks: number[] = [];
  const push = (byte: number) => chunks.push(byte & 0xff);
  const pushU32 = (value: number) => {
    const v = value >>> 0;
    push(v);
    push(v >>> 8);
    push(v >>> 16);
    push(v >>> 24);
  };
  const pushVarint = (value: bigint | number) => {
    let v = BigInt(value);
    if (v < 0n) v &= 0xffffffffffffffffn;
    while (v > 0x7fn) {
      push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    push(Number(v));
  };
  const pushBytes = (bytes: Uint8Array) => {
    pushVarint(bytes.length);
    for (const byte of bytes) push(byte);
  };

  pushU32(tx.version);
  if (segwit) {
    push(0x00);
    push(0x01);
  }
  pushVarint(tx.input.length);
  for (const entry of tx.input) {
    const [txid, vout] = splitOutPoint(entry.previous_output);
    for (const byte of hexToBytes(txid).reverse()) push(byte);
    pushU32(vout);
    pushBytes(hexToBytes(entry.script_sig));
    pushU32(entry.sequence);
  }
  pushVarint(tx.output.length);
  for (const entry of tx.output) {
    if (!Number.isSafeInteger(entry.value) || entry.value < 0) {
      throw new ExitStateConversionError(
        `Output value ${entry.value} is not a safe non-negative integer`,
      );
    }
    pushU32(entry.value % 4294967296);
    pushU32(Math.floor(entry.value / 4294967296));
    pushBytes(hexToBytes(entry.script_pubkey));
  }
  if (segwit) {
    for (const entry of tx.input) {
      pushVarint(entry.witness.length);
      for (const item of entry.witness) pushBytes(hexToBytes(item));
    }
  }
  pushU32(tx.lock_time);
  return Uint8Array.from(chunks);
}

function splitOutPoint(outPoint: string): [string, number] {
  const separator = outPoint.lastIndexOf(":");
  if (separator === -1) {
    throw new ExitStateConversionError(`Malformed outpoint: ${outPoint}`);
  }
  const vout = Number(outPoint.slice(separator + 1));
  if (!Number.isInteger(vout) || vout < 0) {
    throw new ExitStateConversionError(`Malformed outpoint: ${outPoint}`);
  }
  return [outPoint.slice(0, separator), vout];
}

function signed32(value: number): number {
  return value | 0;
}

/** Leaf values share the exporter's safe-integer rule (leafValueAsNumber). */
function requireSafeValue(valueSats: bigint, id: string): number {
  const value = Number(valueSats);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExitStateConversionError(
      `Spark node ${id} has an unsafe value for conversion: ${valueSats}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// protobuf field helpers (first occurrence wins, like operator/wire's
// firstField; the operators emit each field at most once per TreeNode)
// ---------------------------------------------------------------------------

function firstBytes(fields: WireField[], n: number): Uint8Array | undefined {
  for (const field of fields) {
    if (field.fieldNumber === n && field.bytes) return field.bytes;
  }
  return undefined;
}

function firstVarint(fields: WireField[], n: number): bigint | undefined {
  for (const field of fields) {
    if (field.fieldNumber === n && field.varint !== undefined) {
      return field.varint;
    }
  }
  return undefined;
}

function utf8(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
