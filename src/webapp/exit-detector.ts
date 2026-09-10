// Classify Bitcoin transactions as Spark unilateral-exit on-chain artifacts.
//
// Stages and their structural signatures, validated against a real unilateral
// exit captured from the local Spark regtest stack (scripts/capture-regtest-exit.ts,
// fixtures in test/fixtures/webapp/exit-capture.json):
//
//   static-deposit  ordinary tx paying the deposit/refund tree (family mode only;
//                   nothing distinguishes it standalone)
//   node-tx         TRUC v3, pays 0-value P2A anchor + P2TR user output,
//                   spending input NOT CSV-locked (seq disables relative lock)
//   refund-tx       TRUC v3, pays 0-value P2A anchor + P2TR user output,
//                   spending input CSV relative-height locked (2000 blocks on
//                   the local stack; ~2048 elsewhere - read, don't assume)
//   cpfp-bump-child TRUC v3, >=2 inputs (P2A anchor + external funding), no
//                   anchor output; family mode: parent pays the anchor it spends
//   direct-tx       operator's alternative branch spending the same parent
//                   output as node-tx (family mode only)
//   direct-refund-tx CSV-locked child of direct-tx (family mode only)
//   sweep-tx        1-in/1-out spend of a (matured) refund output
//
// The classifier never needs wallet keys, only raw transaction bytes plus (for
// higher confidence) the stage of the parent tx in the same family. Anything
// unconfirmable is reported as "unknown" with the reason recorded.

import { Transaction } from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes, bytesToHex } from "@noble/curves/utils";

/** Anchor output script from BIP 431 (TRUC) and BIP 468 (P2A): OP_1 <4e73>. */
const P2A_ANCHOR_SCRIPT_HEX = "51024e73";

export type ExitStage =
  | "static-deposit"
  | "node-tx"
  | "direct-tx"
  | "refund-tx"
  | "direct-refund-tx"
  | "cpfp-bump-child"
  | "sweep-tx"
  | "unknown";

export type Confidence = "high" | "medium" | "low";

export interface MatchRule {
  name: string;
  description: string;
  fired: boolean;
}

export interface ClassifiedOutput {
  vout: number;
  value: number;
  script: string;
  isAnchor: boolean;
  type: string;
}

export interface TxClassification {
  txid: string;
  stage: ExitStage;
  confidence: Confidence;
  matchedRules: MatchRule[];
  reason: string;
  /** Relative-height CSV lock read off the first CSV-carrying input, blocks. */
  csvBlocks: number | null;
  isTruc: boolean;
  hasAnchorOutput: boolean;
  outputs: ClassifiedOutput[];
  inputs: number;
  /** Refund maturity height, when the parent confirmation height is known. */
  maturityHeight: number | null;
  /** Outpoints this transaction spends (display-order txids). */
  spentOutpoints: Array<{ txid: string; vout: number }>;
}

export function hasAnchorOutputScript(script: Uint8Array): boolean {
  return bytesToHex(script) === P2A_ANCHOR_SCRIPT_HEX;
}

export function outputType(script: Uint8Array): string {
  const hex = bytesToHex(script);
  if (hex === P2A_ANCHOR_SCRIPT_HEX) return "anchor";
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return "p2tr";
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return "p2wpkh";
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) return "p2wsh";
  if (script.length > 3 && script[0] === 0xa9) return "p2sh";
  if (script.length > 20 && script[0] === 0x76) return "p2pkh";
  return "other";
}

export function parseTx(txHex: string): Transaction {
  return Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
    disableScriptCheck: true,
  });
}

// The txid is defined over the legacy no-witness serialization, so compute it
// that way: identical to Transaction.id for finalized transactions and still
// well-defined for unsigned variants (e.g. tree-node directFromCpfpRefundTx).
export function txidFromHex(txHex: string): string {
  const tx = parseTx(txHex);
  const legacy = tx.toBytes(true, false);
  return bytesToHex(new Uint8Array([...sha256(sha256(legacy))].reverse()));
}

// BIP 68 relative lock in blocks, or null when the sequence disables relative
// locks or encodes a time-based lock. Mirrors auto-exit.ts relativeHeightLock.
export function csvRelativeBlocks(sequence: number | undefined): number | null {
  if (sequence === undefined) return null;
  if (sequence >= 0x80000000) return null;
  if ((sequence & 0x00400000) !== 0) return null;
  const blocks = sequence & 0xffff;
  return blocks === 0 ? null : blocks;
}

export interface TxStructure {
  txid: string;
  version: number;
  locktime: number;
  inputs: Array<{ txid: string; vout: number; sequence: number }>;
  outputs: ClassifiedOutput[];
  isTruc: boolean;
  hasAnchorOutput: boolean;
  /** First CSV relative-height lock found across inputs, in blocks. */
  csvBlocks: number | null;
}

export function txStructure(txHex: string): TxStructure {
  const tx = parseTx(txHex);
  const inputs: Array<{ txid: string; vout: number; sequence: number }> = [];
  let csv: number | null = null;
  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    // btc-signer exposes prev txids already in display (rpc/explora) order.
    const displayTxid = input?.txid
      ? bytesToHex(new Uint8Array(input.txid))
      : "";
    const sequence = Number(input?.sequence ?? 0);
    inputs.push({
      txid: displayTxid,
      vout: input?.index ?? 0,
      sequence,
    });
    if (csv === null) csv = csvRelativeBlocks(sequence);
  }
  const outputs: ClassifiedOutput[] = [];
  let hasAnchor = false;
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i);
    const script = output?.script ?? new Uint8Array();
    const isAnchor =
      hasAnchorOutputScript(script) && (output?.amount ?? 0n) === 0n;
    if (isAnchor) hasAnchor = true;
    outputs.push({
      vout: i,
      value: Number(output?.amount ?? 0n),
      script: bytesToHex(script),
      isAnchor,
      type: outputType(script),
    });
  }
  return {
    txid: txidFromHex(txHex),
    version: tx.version,
    locktime: tx.lockTime,
    inputs,
    outputs,
    isTruc: tx.version === 3,
    hasAnchorOutput: hasAnchor,
    csvBlocks: csv,
  };
}

export interface ClassifyOptions {
  /** Stage of the tx this one spends (family mode). */
  parentStage?: ExitStage;
  /** True when a spent prevout is known to be a P2A anchor output. */
  spendsAnchor?: boolean;
  /** Confirmation height of the parent, for refund maturity. */
  parentConfirmedHeight?: number | null;
}

/**
 * Classify one transaction's stage in a unilateral exit from structure plus
 * optional family context. Standalone shape matching yields the refund family
 * with medium confidence; parent context upgrades or redirects it.
 */
export function classifyTx(txHex: string, options: ClassifyOptions = {}): TxClassification {
  const structure = txStructure(txHex);
  const rules: MatchRule[] = [];
  const rule = (name: string, description: string, fired: boolean) => {
    rules.push({ name, description, fired });
    return fired;
  };

  // A parent classified "unknown" carries no family evidence; treat it the
  // same as no parent so family walks (deposit -> node-tx -> ...) still
  // classify children by shape.
  const parentStage =
    options.parentStage === "unknown" ? undefined : options.parentStage;
  const parentHeight = options.parentConfirmedHeight ?? null;

  const isTruc = rule("truc", "version 3 (TRUC) transaction", structure.isTruc);
  const anchor = rule(
    "p2a-anchor",
    "pays a 0-value P2A anchor output",
    structure.hasAnchorOutput,
  );
  const csv = rule(
    "csv-lock",
    `an input carries a BIP68 relative-height lock${
      structure.csvBlocks !== null ? ` of ${structure.csvBlocks} blocks` : ""
    }`,
    structure.csvBlocks !== null,
  );
  const p2trOutputs = structure.outputs.filter((o) => o.type === "p2tr");
  const paysP2tr = rule(
    "p2tr-output",
    "pays one or more P2TR outputs",
    p2trOutputs.length > 0,
  );
  const multiInput = rule(
    "multi-input",
    "consolidates multiple inputs",
    structure.inputs.length >= 2,
  );
  const spendsAnchor = rule(
    "spends-anchor",
    "spends a P2A anchor prevout (family evidence)",
    options.spendsAnchor === true,
  );
  const spendsRefundLike =
    parentStage === "refund-tx" || parentStage === "direct-refund-tx";
  const oneInOneOut =
    structure.inputs.length === 1 && structure.outputs.length === 1;

  let stage: ExitStage = "unknown";
  let confidence: Confidence = "low";
  const reasons: string[] = [];

  if (isTruc && anchor && csv) {
    // Canonical Spark refund shape. The CPFP-branch refund child of node-tx
    // and the direct-branch refund child of direct-tx are the same shape.
    if (parentStage === "direct-tx") {
      stage = "direct-refund-tx";
      confidence = "high";
      reasons.push("CSV-timelocked child of a direct-tx");
    } else if (parentStage === "node-tx") {
      stage = "refund-tx";
      confidence = "high";
      reasons.push("CSV-timelocked child of a node-tx");
    } else {
      stage = "refund-tx";
      confidence = "medium";
      reasons.push("TRUC v3 + 0-value P2A anchor + CSV relative lock");
    }
    if (paysP2tr) reasons.push("refund paid to a P2TR user key");
  } else if (isTruc && anchor && !csv) {
    // Node/direct branch tx: TRUC with anchor, spending the deposit without a
    // relative lock. Without operator keys the two branches are one bucket.
    if (
      parentStage === "static-deposit" ||
      parentStage === "node-tx" ||
      parentStage === undefined
    ) {
      stage = "node-tx";
      confidence = parentStage === "static-deposit" ? "high" : "medium";
      reasons.push(
        "TRUC v3 + 0-value P2A anchor, input not CSV-locked (branch tx shape)",
      );
      if (paysP2tr) reasons.push("pays a P2TR user output");
    }
  } else if (isTruc && !anchor && csv && parentStage === "node-tx") {
    // Operator direct refund: the chainwatcher completes the exit itself by
    // spending the node tx's user output after a CSV delay, fee baked in, no
    // anchor (observed on the local stack: TRUC, 1-in/1-out P2TR, CSV 2050).
    stage = "direct-refund-tx";
    confidence = "high";
    reasons.push("TRUC CSV-locked spend of a node-tx user output (operator direct refund)");
  } else if (isTruc && !anchor && csv && oneInOneOut && paysP2tr) {
    // Standalone operator direct refund shape: self-fee-paying CSV-locked
    // TRUC spend to a single P2TR output, no anchor (fees baked in). Without
    // parent context it could also be another protocol's TRUC+CSV spend,
    // hence medium confidence.
    stage = "direct-refund-tx";
    confidence = "medium";
    reasons.push("TRUC CSV-locked 1-in/1-out P2TR spend without anchor (self-fee refund shape)");
  } else if (isTruc && !anchor && (multiInput || spendsAnchor)) {
    // CPFP fee-bump child: TRUC, multiple inputs (the anchor + external
    // funding), no anchor output of its own.
    stage = "cpfp-bump-child";
    confidence = spendsAnchor ? "high" : "medium";
    reasons.push(
      spendsAnchor
        ? "TRUC tx spending a P2A anchor with external funding (CPFP bump)"
        : "TRUC multi-input tx without anchor output (CPFP bump shape)",
    );
  } else if (spendsRefundLike && oneInOneOut) {
    stage = "sweep-tx";
    confidence = paysP2tr ? "high" : "medium";
    reasons.push("1-in/1-out spend of a refund output");
  }

  if (stage === "unknown") {
    reasons.length = 0;
    if (parentStage === "static-deposit") {
      stage = "static-deposit";
      confidence = "low";
      reasons.push("family context only: related to a known deposit");
    } else {
      reasons.push("no unilateral-exit structural signature matched");
    }
  }

  const maturityHeight =
    stage === "refund-tx" || stage === "direct-refund-tx"
      ? structure.csvBlocks !== null && parentHeight !== null
        ? parentHeight + structure.csvBlocks + 1
        : null
      : null;

  return {
    txid: structure.txid,
    stage,
    confidence,
    matchedRules: rules,
    reason: reasons.join("; "),
    csvBlocks: structure.csvBlocks,
    isTruc: structure.isTruc,
    hasAnchorOutput: structure.hasAnchorOutput,
    outputs: structure.outputs,
    inputs: structure.inputs.length,
    maturityHeight,
    spentOutpoints: structure.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
  };
}
