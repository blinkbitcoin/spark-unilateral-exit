import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes, bytesToHex } from "@noble/curves/utils";
import { Transaction, p2wpkh } from "@scure/btc-signer";

import type { LeafPackage } from "./types.ts";

export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

export interface PackageSigningSummary {
  leafId: string;
  packageIndex: number;
  parentTxid: string;
  fundingInputCount: number;
  fundingInputSats: string;
  changeOutputSats: string;
  feeSats: string;
}

interface SignPackagesOptions {
  packages: LeafPackage[];
  privateKey: string | Uint8Array;
  /** The caller displayed and explicitly approved summarizePackages(). */
  approved?: boolean;
}

interface SummarizePackagesOptions {
  packages: LeafPackage[];
  privateKey: string | Uint8Array;
}

export function summarizePackages({
  packages,
  privateKey,
}: SummarizePackagesOptions): PackageSigningSummary[] {
  const keyBytes = parsePrivateKey(privateKey);
  const summaries: PackageSigningSummary[] = [];

  forEachPackage(packages, (leafId, txPkg, packageIndex) => {
    summaries.push(
      inspectFeeBumpPsbt({
        psbtHex: txPkg.feeBumpPsbt!,
        parentTxHex: txPkg.tx!,
        privateKey: keyBytes,
        leafId,
        packageIndex,
      }).summary,
    );
  });

  return summaries;
}

export function signPackages({
  packages,
  privateKey,
  approved = false,
}: SignPackagesOptions): LeafPackage[] {
  if (!approved) {
    throw new SignError(
      "Explicit signing approval is required after reviewing summarizePackages()",
    );
  }
  const keyBytes = parsePrivateKey(privateKey);
  const signed: LeafPackage[] = [];

  for (const leafPackage of packages) {
    validateLeafPackage(leafPackage);
    const signedTxPackages = leafPackage.txPackages!.map((txPkg, packageIndex) => {
      validateTxPackage(leafPackage.leafId!, txPkg, packageIndex);
      const signedChildTx = signPsbt(
        txPkg.feeBumpPsbt!,
        keyBytes,
        txPkg.tx!,
      );
      return { ...txPkg, signedChildTx };
    });

    signed.push({ ...leafPackage, txPackages: signedTxPackages });
  }

  return signed;
}

export function signPsbt(
  psbtHex: string,
  privateKey: string | Uint8Array,
  parentTxHex: string,
): string {
  const keyBytes =
    typeof privateKey === "string" ? parsePrivateKey(privateKey) : privateKey;
  const { tx, fundingInputIndexes } = inspectFeeBumpPsbt({
    psbtHex,
    parentTxHex,
    privateKey: keyBytes,
  });

  for (const index of fundingInputIndexes) {
    const input = tx.getInput(index)!;
    tx.updateInput(index, {
      witnessScript: input.witnessUtxo!.script,
    });
    tx.signIdx(keyBytes, index);
    tx.finalizeIdx(index);
  }

  return bytesToHex(tx.toBytes(true, true));
}

function inspectFeeBumpPsbt({
  psbtHex,
  parentTxHex,
  privateKey,
  leafId = "unknown",
  packageIndex = 0,
}: {
  psbtHex: string;
  parentTxHex: string;
  privateKey: Uint8Array;
  leafId?: string;
  packageIndex?: number;
}): {
  tx: Transaction;
  fundingInputIndexes: number[];
  summary: PackageSigningSummary;
} {
  let tx: Transaction;
  let parent: Transaction;
  try {
    tx = Transaction.fromPSBT(hexToBytes(psbtHex), {
      allowUnknown: true,
      allowLegacyWitnessUtxo: true,
      version: 3,
    });
    parent = Transaction.fromRaw(hexToBytes(parentTxHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
  } catch (error) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] contains invalid transaction data: ${errorMessage(error)}`,
    );
  }

  const parentAnchors: Array<{ index: number; script: Uint8Array }> = [];
  for (let index = 0; index < parent.outputsLength; index += 1) {
    const output = parent.getOutput(index);
    if (isEphemeralAnchorOutput(output?.script, output?.amount)) {
      parentAnchors.push({ index, script: output!.script! });
    }
  }
  if (parentAnchors.length !== 1) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] parent must contain exactly one ephemeral anchor output, got ${parentAnchors.length}`,
    );
  }

  const expectedScript = p2wpkh(secp256k1.getPublicKey(privateKey, true)).script;
  const fundingInputIndexes: number[] = [];
  let fundingInputSats = 0n;
  let anchorInputCount = 0;

  for (let index = 0; index < tx.inputsLength; index += 1) {
    const input = tx.getInput(index);
    const script = input?.witnessUtxo?.script;
    const amount = input?.witnessUtxo?.amount;
    if (isEphemeralAnchorOutput(script, amount)) {
      anchorInputCount += 1;
      const anchor = parentAnchors[0]!;
      if (
        input?.index !== anchor.index ||
        !inputReferencesTxid(input?.txid, parent.id) ||
        !bytesEqual(script!, anchor.script)
      ) {
        throw new SignError(
          `Leaf ${leafId} txPackages[${packageIndex}] anchor input is not bound to the companion parent transaction`,
        );
      }
      continue;
    }

    if (!script || amount === undefined || amount <= 0n) {
      throw new SignError(
        `Leaf ${leafId} txPackages[${packageIndex}] input ${index} is missing a positive witness UTXO`,
      );
    }
    if (!bytesEqual(script, expectedScript)) {
      throw new SignError(
        `Leaf ${leafId} txPackages[${packageIndex}] input ${index} is not owned by the supplied CPFP key`,
      );
    }
    fundingInputIndexes.push(index);
    fundingInputSats += amount;
  }

  if (anchorInputCount !== 1) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] must spend exactly one ephemeral anchor, got ${anchorInputCount}`,
    );
  }
  if (fundingInputIndexes.length === 0) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] has no CPFP funding input owned by the supplied key`,
    );
  }
  if (tx.outputsLength !== 1) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] must have exactly one CPFP change output, got ${tx.outputsLength}`,
    );
  }
  const change = tx.getOutput(0);
  if (
    !change?.script ||
    change.amount === undefined ||
    change.amount <= 0n ||
    !bytesEqual(change.script, expectedScript)
  ) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] change output is not a positive output owned by the supplied CPFP key`,
    );
  }
  if (change.amount >= fundingInputSats) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] has a non-positive fee`,
    );
  }

  return {
    tx,
    fundingInputIndexes,
    summary: {
      leafId,
      packageIndex,
      parentTxid: parent.id,
      fundingInputCount: fundingInputIndexes.length,
      fundingInputSats: fundingInputSats.toString(),
      changeOutputSats: change.amount.toString(),
      feeSats: (fundingInputSats - change.amount).toString(),
    },
  };
}

function forEachPackage(
  packages: LeafPackage[],
  visit: (
    leafId: string,
    txPkg: NonNullable<LeafPackage["txPackages"]>[number],
    packageIndex: number,
  ) => void,
): void {
  for (const leafPackage of packages) {
    validateLeafPackage(leafPackage);
    leafPackage.txPackages!.forEach((txPkg, packageIndex) => {
      validateTxPackage(leafPackage.leafId!, txPkg, packageIndex);
      visit(leafPackage.leafId!, txPkg, packageIndex);
    });
  }
}

function validateLeafPackage(leafPackage: LeafPackage): void {
  if (!leafPackage?.leafId || !Array.isArray(leafPackage.txPackages)) {
    throw new SignError("Each package must include leafId and txPackages");
  }
}

function validateTxPackage(
  leafId: string,
  txPkg: NonNullable<LeafPackage["txPackages"]>[number],
  packageIndex: number,
): void {
  if (!txPkg?.tx) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] is missing parent tx`,
    );
  }
  if (!txPkg.feeBumpPsbt) {
    throw new SignError(
      `Leaf ${leafId} txPackages[${packageIndex}] is missing feeBumpPsbt`,
    );
  }
}

function parsePrivateKey(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const hex = String(input).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new SignError("Private key must be 32-byte hex (64 characters)");
  }
  return hexToBytes(hex);
}

function inputReferencesTxid(
  txid: Uint8Array | string | undefined,
  expected: string,
): boolean {
  if (!txid) return false;
  const bytes =
    typeof txid === "string" ? hexToBytes(txid) : new Uint8Array(txid);
  const direct = bytesToHex(bytes);
  const reversed = bytesToHex(new Uint8Array([...bytes].reverse()));
  return direct === expected || reversed === expected;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEphemeralAnchorOutput(
  script: Uint8Array | undefined,
  amount: bigint | undefined,
): boolean {
  return Boolean(
    amount === 0n &&
      script &&
      ((script.length === 1 && script[0] === 0x51) ||
        (script.length === 2 && script[0] === 0x01 && script[1] === 0x51) ||
        (script.length === 7 &&
          script[0] === 0x01 &&
          script[1] === 0x51 &&
          script[2] === 0x52 &&
          script[3] === 0x01 &&
          script[4] === 0x4e &&
          script[5] === 0x01 &&
          script[6] === 0x73) ||
        (script.length === 4 &&
          script[0] === 0x51 &&
          script[1] === 0x02 &&
          script[2] === 0x4e &&
          script[3] === 0x73)),
  );
}
