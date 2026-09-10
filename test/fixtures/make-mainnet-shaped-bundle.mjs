// Regenerates test/fixtures/mainnet-shaped-bundle.json:
//
//   node test/fixtures/make-mainnet-shaped-bundle.mjs > test/fixtures/mainnet-shaped-bundle.json
//
// WHY THIS FIXTURE EXISTS
//
// The local regtest stack does not produce the transactions a live operator set
// produces. Measured against a real mainnet export (SDK 0.9.0) and a leaf freshly
// claimed from local-infra's stack:
//
//                            local stack        real mainnet export
//   nodeTx                   signed             signed
//   refundTx                 signed             signed
//   directFromCpfpRefundTx   SIGNED             UNSIGNED
//   directTx                 ABSENT             present, UNSIGNED
//   directRefundTx           ABSENT             present, UNSIGNED
//
// The direct routes are the user's own to sign at exit time, so a real export
// hands them over unsigned. Every transaction the E2E and the unit fixtures build
// is signed and finalized before use, which left the unsigned shape completely
// uncovered -- and a txid computed through Transaction.id (which refuses to answer
// for a non-finalized transaction) threw on the first leaf of every real bundle.
//
// This fixture reproduces that shape with nothing real in it: synthetic keys,
// synthetic parent txids, round amounts. What it preserves from the real export is
// exactly what the decoders depend on -- v3 (TRUC) transactions, the P2A anchor on
// the CPFP route, the anchorless self-fee-paying direct route, the relative
// timelock sequences, and the signed/unsigned split above.
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { p2tr, Transaction } from "@scure/btc-signer";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

// OP_1 <0x4e73>: the pay-to-anchor output a v3 CPFP-able transaction carries so a
// child can pay its fee. Only the CPFP route has one; the direct route bakes the
// fee into the transaction instead.
const P2A_ANCHOR = hexToBytes("51024e73");

// Spark sets the relative timelock in the high bits; the offsets are the values a
// real export carries (2000 and 2050 blocks for the node/direct routes, 800 and
// 850 for the refunds that spend them).
const SEQUENCE_BASE = 0x40000000;
const SEQ = {
  node: SEQUENCE_BASE + 2000,
  refund: SEQUENCE_BASE + 800,
  directFromCpfpRefund: SEQUENCE_BASE + 850,
  direct: SEQUENCE_BASE + 2050,
  directRefund: SEQUENCE_BASE + 850,
};

// Deterministic so the committed fixture is stable across regenerations.
const AUX_RAND = new Uint8Array(32).fill(1);
const keyFor = (index) => {
  const privateKey = new Uint8Array(32).fill(index + 7);
  const xonly = secp256k1.getPublicKey(privateKey, true).slice(1);
  return { privateKey, xonly, script: p2tr(xonly).script };
};

function buildTx({ key, prevTxid, prevVout, prevAmount, sequence, amount, anchor, sign }) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({
    txid: prevTxid,
    index: prevVout,
    sequence,
    witnessUtxo: { script: key.script, amount: prevAmount },
    tapInternalKey: key.xonly,
  });
  tx.addOutput({ script: key.script, amount });
  if (anchor) tx.addOutput({ script: P2A_ANCHOR, amount: 0n });
  // An unsigned transaction still serializes; that is precisely the state a real
  // export's direct routes arrive in, and the txid is already fixed because
  // signing a segwit spend only fills in the witness.
  if (!sign) return tx.hex;
  // Fixed aux randomness: BIP340 signing is randomized by default, which would
  // make every regeneration produce a different committed file.
  tx.sign(key.privateKey, undefined, AUX_RAND);
  tx.finalize();
  return tx.hex;
}

const LEAVES = [
  { id: "00000000-0000-4000-8000-000000000001", valueSats: 546 },
  { id: "00000000-0000-4000-8000-000000000002", valueSats: 5_000 },
  { id: "00000000-0000-4000-8000-000000000003", valueSats: 100_000 },
];

const leaves = LEAVES.map((leaf, index) => {
  const key = keyFor(index);
  const amount = BigInt(leaf.valueSats);
  const parentTxid = `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32);
  const parent = { key, prevTxid: parentTxid, prevVout: 0, prevAmount: amount + 1_000n };

  // CPFP route: parent -> nodeTx -> refundTx, both anchored and signed.
  const nodeTx = buildTx({ ...parent, sequence: SEQ.node, amount, anchor: true, sign: true });
  const nodeTxid = Transaction.fromRaw(hexToBytes(nodeTx), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  }).id;
  const refundTx = buildTx({
    key, prevTxid: nodeTxid, prevVout: 0, prevAmount: amount,
    sequence: SEQ.refund, amount, anchor: true, sign: true,
  });

  // Self-fee-paying refund off the same node output, and the alternate direct
  // route off the same parent output -- all three unsigned, all three anchorless.
  const directFromCpfpRefundTx = buildTx({
    key, prevTxid: nodeTxid, prevVout: 0, prevAmount: amount,
    sequence: SEQ.directFromCpfpRefund, amount, anchor: false, sign: false,
  });
  const directTx = buildTx({ ...parent, sequence: SEQ.direct, amount, anchor: false, sign: false });
  const directTxid = Transaction.fromRaw(hexToBytes(directTx), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
  const directRefundTx = buildTx({
    key,
    prevTxid: bytesToHex(directTxid.toBytes(true).slice(0, 32)), // any 32-byte id; unsigned parent
    prevVout: 0,
    prevAmount: amount,
    sequence: SEQ.directRefund,
    amount,
    anchor: false,
    sign: false,
  });

  const treeNode = TreeNode.create({
    id: leaf.id,
    treeId: "00000000-0000-4000-8000-0000000000ff",
    value: leaf.valueSats,
    parentNodeId: "00000000-0000-4000-8000-0000000000fe",
    vout: 0,
    verifyingPublicKey: secp256k1.getPublicKey(key.privateKey, true),
    ownerIdentityPublicKey: secp256k1.getPublicKey(new Uint8Array(32).fill(9), true),
    ownerSigningPublicKey: secp256k1.getPublicKey(key.privateKey, true),
    nodeTx: hexToBytes(nodeTx),
    refundTx: hexToBytes(refundTx),
    directFromCpfpRefundTx: hexToBytes(directFromCpfpRefundTx),
    directTx: hexToBytes(directTx),
    directRefundTx: hexToBytes(directRefundTx),
  });

  return {
    id: leaf.id,
    status: "AVAILABLE",
    valueSats: leaf.valueSats,
    treeNodeHex: bytesToHex(TreeNode.encode(treeNode).finish()),
  };
});

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "spark.unilateral-exit-bundle.v1",
      _generatedBy: "test/fixtures/make-mainnet-shaped-bundle.mjs",
      createdAt: "2026-01-01T00:00:00.000Z",
      network: "MAINNET",
      leaves,
    },
    null,
    2,
  )}\n`,
);
