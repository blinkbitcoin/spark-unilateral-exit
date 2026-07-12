// Spark identity key derivation and challenge signing.
//
// The identity key lives at m/8797555'/{account}'/0' from the BIP39 seed
// (same derivation as the Spark SDK's DefaultSigner). The default account
// number is network-dependent: 1 on mainnet, 0 on regtest/local - hardcoding
// 0 on mainnet derives a different wallet identity that owns no leaves.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";

import { parseSeed } from "../sweep.ts";

const SPARK_IDENTITY_PATH = (account: number) => `m/8797555'/${account}'/0'`;

export interface IdentityKeyPair {
  privateKey: Uint8Array;
  /** Compressed (33-byte) secp256k1 public key. */
  publicKey: Uint8Array;
}

export function defaultAccountNumber(network: string): number {
  const normalized = network.toUpperCase();
  return normalized === "REGTEST" || normalized === "LOCAL" ? 0 : 1;
}

export function deriveIdentityKeyPair(
  seed: string,
  network: string,
  accountNumber?: number,
  passphrase = "",
): IdentityKeyPair {
  const seedBytes = parseSeed(seed, passphrase);
  const account = accountNumber ?? defaultAccountNumber(network);
  const key = HDKey.fromMasterSeed(seedBytes).derive(SPARK_IDENTITY_PATH(account));
  if (!key.privateKey) {
    throw new Error("BIP32: derived no private key for the Spark identity path");
  }
  return {
    privateKey: key.privateKey,
    publicKey: secp256k1.getPublicKey(key.privateKey, true),
  };
}

/** ECDSA over sha256(message), DER-encoded - the operator auth signature format. */
export function signChallenge(
  message: Uint8Array,
  privateKey: Uint8Array,
): Uint8Array {
  return secp256k1.sign(sha256(message), privateKey).toDERRawBytes();
}
