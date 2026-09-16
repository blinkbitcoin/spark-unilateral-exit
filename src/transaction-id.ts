import { Transaction } from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";

// Txids exclude witness data. Transaction.id additionally requires every
// input to have final script data, which rejects valid empty P2A anchor inputs
// and unsigned segwit templates. Preserve scriptSig and omit only witnesses.
export function transactionIdFromHex(hex: string): string {
  const tx = Transaction.fromRaw(hexToBytes(hex), {
    allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true,
  });
  return bytesToHex(sha256(sha256(tx.toBytes(true, false))).reverse());
}
