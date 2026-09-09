import { bytesToHex } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import { Transaction } from "@scure/btc-signer";

// Transaction.id refuses to compute a txid until every input is finalized, but a
// real operator export carries the alternate exit routes UNSIGNED: directTx,
// directRefundTx and directFromCpfpRefundTx are the user's own to sign at exit
// time, so asking btc-signer for their id throws "Transaction is not finalized"
// (only refundTx arrives signed). Their txids are knowable regardless: these are
// v3 (TRUC) segwit spends, whose txid commits to the inputs' scriptSigs (empty
// here) and not to the witnesses, so the value computed below is byte-identical
// to the txid the signed transaction will have. Mirrors Transaction.id minus the
// finality guard.
//
// Lives in its own module so every consumer can reach it: the refund decode in
// spark-packages.ts, auto-exit's txIdOf seam, and sweep.ts — which stays free of
// the Spark SDK that spark-packages.ts pulls in.
export function txidOfPossiblyUnsigned(tx: Transaction): string {
  return bytesToHex(sha256(sha256(tx.toBytes(true))).reverse());
}
