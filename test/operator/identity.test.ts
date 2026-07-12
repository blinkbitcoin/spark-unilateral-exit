import { describe, expect, it } from "vitest";

import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";

import {
  defaultAccountNumber,
  deriveIdentityKeyPair,
  signChallenge,
} from "../../src/operator/identity.ts";

/**
 * Golden vectors computed with an independent pure-Python BIP32/BIP39
 * implementation (hashlib/hmac + textbook secp256k1 math) for the path
 * m/8797555'/{account}'/0'. The path itself is confirmed against both the
 * official JS spark-sdk (`hdkey.derive("m/8797555'/{account}'/0'")`) and the
 * Spark SDK's Rust default_signer.
 */
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MAINNET_IDENTITY_PUB =
  "0281363910b0dc0015a4a25e758da30f0e28388ea5252c0e3713936f2d4ef7d3d5";
const MAINNET_IDENTITY_PRIV =
  "07ede284a8976f380b6922de4b14f3a30d1c09b4e57e12cebad5d37ee2e2e6c1";
const REGTEST_IDENTITY_PUB =
  "02698b27ac308b275671b3ca25436346469d04a5bba578ae39feba1d65897a6abc";

describe("spark identity derivation", () => {
  it("uses the network-dependent default account number", () => {
    expect(defaultAccountNumber("MAINNET")).toBe(1);
    expect(defaultAccountNumber("TESTNET")).toBe(1);
    expect(defaultAccountNumber("SIGNET")).toBe(1);
    expect(defaultAccountNumber("REGTEST")).toBe(0);
    expect(defaultAccountNumber("LOCAL")).toBe(0);
  });

  it("derives the mainnet identity key at m/8797555'/1'/0'", () => {
    const keyPair = deriveIdentityKeyPair(TEST_MNEMONIC, "MAINNET");
    expect(bytesToHex(keyPair.privateKey)).toBe(MAINNET_IDENTITY_PRIV);
    expect(bytesToHex(keyPair.publicKey)).toBe(MAINNET_IDENTITY_PUB);
  });

  it("derives the regtest identity key at m/8797555'/0'/0'", () => {
    const keyPair = deriveIdentityKeyPair(TEST_MNEMONIC, "REGTEST");
    expect(bytesToHex(keyPair.publicKey)).toBe(REGTEST_IDENTITY_PUB);
  });

  it("respects an explicit account number override", () => {
    const withOverride = deriveIdentityKeyPair(TEST_MNEMONIC, "REGTEST", 1);
    expect(bytesToHex(withOverride.publicKey)).toBe(MAINNET_IDENTITY_PUB);
  });

  it("accepts a 64-byte hex seed", () => {
    // BIP39 seed of TEST_MNEMONIC (empty passphrase)
    const seedHex =
      "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1" +
      "9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";
    const keyPair = deriveIdentityKeyPair(seedHex, "MAINNET");
    expect(bytesToHex(keyPair.publicKey)).toBe(MAINNET_IDENTITY_PUB);
  });
});

describe("challenge signing", () => {
  it("produces a DER-encoded ECDSA signature over sha256(message) that verifies", () => {
    const keyPair = deriveIdentityKeyPair(TEST_MNEMONIC, "MAINNET");
    const message = new TextEncoder().encode("challenge-bytes");

    const der = signChallenge(message, keyPair.privateKey);

    // DER structure: 0x30 len 0x02 lenR R 0x02 lenS S
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(der.length - 2);
    expect(der[2]).toBe(0x02);

    const signature = secp256k1.Signature.fromDER(der);
    expect(
      secp256k1.verify(
        signature.toCompactRawBytes(),
        sha256(message),
        keyPair.publicKey,
      ),
    ).toBe(true);
  });
});
