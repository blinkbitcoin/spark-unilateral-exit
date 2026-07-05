import { hexToBytes, bytesToHex } from "@noble/curves/utils";
import { Transaction } from "@scure/btc-signer";

import type { LeafPackage } from "./types.ts";

export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

interface SignPackagesOptions {
  packages: LeafPackage[];
  privateKey: string | Uint8Array;
}

export function signPackages({
  packages,
  privateKey,
}: SignPackagesOptions): LeafPackage[] {
  const keyBytes = parsePrivateKey(privateKey);
  const signed: LeafPackage[] = [];

  for (const leafPackage of packages) {
    if (!leafPackage?.leafId || !Array.isArray(leafPackage.txPackages)) {
      throw new SignError("Each package must include leafId and txPackages");
    }

    const signedTxPackages = leafPackage.txPackages.map((txPkg, i) => {
      if (!txPkg?.feeBumpPsbt) {
        throw new SignError(
          `Leaf ${leafPackage.leafId} txPackages[${i}] is missing feeBumpPsbt`,
        );
      }
      const signedChildTx = signPsbt(txPkg.feeBumpPsbt, keyBytes);
      return { ...txPkg, signedChildTx };
    });

    signed.push({ ...leafPackage, txPackages: signedTxPackages });
  }

  return signed;
}

export function signPsbt(
  psbtHex: string,
  privateKey: string | Uint8Array,
): string {
  const keyBytes =
    typeof privateKey === "string" ? parsePrivateKey(privateKey) : privateKey;

  const tx = Transaction.fromPSBT(hexToBytes(psbtHex), {
    allowUnknown: true,
    allowLegacyWitnessUtxo: true,
    version: 3,
  });

  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    if (isEphemeralAnchorOutput(input?.witnessUtxo?.script, input?.witnessUtxo?.amount)) {
      continue;
    }
    tx.updateInput(i, {
      witnessScript: input?.witnessUtxo?.script,
    });
    tx.signIdx(keyBytes, i);
    tx.finalizeIdx(i);
  }

  return bytesToHex(tx.toBytes(true, true));
}

function parsePrivateKey(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const hex = String(input).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new SignError("Private key must be 32-byte hex (64 characters)");
  }
  return hexToBytes(hex);
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
