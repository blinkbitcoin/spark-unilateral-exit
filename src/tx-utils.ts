// Shared transaction utilities for relaxed parsing and txid computation.
//
// Spark exit transactions are TRUC (v3) with P2A anchor outputs and may be
// unsigned templates (TreeNodes carry an unsigned directFromCpfpRefundTx),
// so every parser here passes the relaxed btc-signer options and every txid
// is computed over the legacy no-witness serialization. That serialization is
// the txid's definition, so the result equals Transaction.id for finalized
// transactions and stays well-defined for unsigned ones, where .id throws
// "Transaction is not finalized".

import { Transaction } from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";

export function parseRelaxedTx(txHex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
    // Real mainnet txs exist with arbitrary version fields; the version is
    // irrelevant to structural classification, so accept any number.
    allowUnknownVersion: true,
  });
}

export function legacyTxid(tx: Transaction): string {
  const legacy = tx.toBytes(true, false);
  return bytesToHex(new Uint8Array([...sha256(sha256(legacy))].reverse()));
}

export function legacyTxidFromHex(txHex: string): string {
  return legacyTxid(parseRelaxedTx(txHex));
}

// BIP 68 relative lock in blocks, or null when the sequence disables relative
// locks or encodes a time-based lock (Spark refunds use height-based locks).
export function csvRelativeBlocks(sequence: number | undefined): number | null {
  if (sequence === undefined) return null;
  if (sequence >= 0x80000000) return null;
  if ((sequence & 0x00400000) !== 0) return null;
  const blocks = sequence & 0xffff;
  return blocks === 0 ? null : blocks;
}
