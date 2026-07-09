import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";

export interface HeightLock {
  blocks: number;
  prevTxidCandidates: string[];
}

export function transactionIdFromHex(txHex: string): string {
  return parseTransaction(txHex).id;
}

// Reads a BIP68 relative height lock from the transaction's first input.
// Returns null when the sequence disables relative locks or encodes a
// time-based lock (Spark refunds use height-based locks).
export function relativeHeightLock(txHex: string): HeightLock | null {
  const tx = parseTransaction(txHex);
  const input = tx.getInput(0);
  const sequence = input?.sequence;
  if (sequence === undefined || sequence >= 0x80000000) return null;
  if ((sequence & 0x00400000) !== 0) return null;
  const blocks = sequence & 0xffff;
  if (blocks === 0) return null;
  const rawTxid = input?.txid;
  const candidates: string[] = [];
  if (rawTxid) {
    const hex = bytesToHex(rawTxid instanceof Uint8Array ? rawTxid : new Uint8Array(rawTxid));
    candidates.push(hex, bytesToHex(new Uint8Array([...hexToBytes(hex)].reverse())));
  }
  return { blocks, prevTxidCandidates: candidates };
}

function parseTransaction(txHex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
}
