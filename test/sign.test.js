import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/curves/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { Address, OutScript, Transaction, p2wpkh } from "@scure/btc-signer";
import { signPackages, signPsbt, SignError } from "../src/sign.js";

function makeTestPsbt(privateKey) {
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const hash = ripemd160(sha256(publicKey));
  const payment = p2wpkh(publicKey);
  const script = payment.script;

  const parentTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  parentTx.addOutput({
    amount: 0n,
    script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]),
  });
  parentTx.addOutput({ amount: 50000n, script });

  const childTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  childTx.addInput({
    txid: new Uint8Array(32),
    index: 0,
    witnessUtxo: { amount: 10000n, script },
  });
  childTx.addInput({
    txid: parentTx.id,
    index: 0,
    witnessUtxo: {
      amount: 0n,
      script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]),
    },
  });
  childTx.addOutputAddress(
    payment.address,
    8000n,
  );

  return bytesToHex(childTx.toPSBT(0));
}

describe("signPsbt", () => {
  it("signs non-anchor inputs and skips anchor inputs", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);
    const signedHex = signPsbt(psbtHex, privateKey);
    expect(typeof signedHex).toBe("string");
    expect(signedHex.length).toBeGreaterThan(0);

    const signedTx = Transaction.fromRaw(
      Uint8Array.from(Buffer.from(signedHex, "hex")),
      { allowUnknownOutputs: true },
    );
    expect(signedTx.inputsLength).toBe(2);
  });

  it("accepts hex string private key", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);
    const signedHex = signPsbt(psbtHex, bytesToHex(privateKey));
    expect(typeof signedHex).toBe("string");
    expect(signedHex.length).toBeGreaterThan(0);
  });
});

describe("signPackages", () => {
  it("signs all feeBumpPsbt entries and adds signedChildTx", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);

    const packages = [
      {
        leafId: "leaf-1",
        txPackages: [
          { tx: "deadbeef", feeBumpPsbt: psbtHex },
          { tx: "cafebabe", feeBumpPsbt: psbtHex },
        ],
      },
    ];

    const signed = signPackages({
      packages,
      privateKey: bytesToHex(privateKey),
    });

    expect(signed).toHaveLength(1);
    expect(signed[0].leafId).toBe("leaf-1");
    expect(signed[0].txPackages).toHaveLength(2);

    for (const txPkg of signed[0].txPackages) {
      expect(txPkg.signedChildTx).toBeDefined();
      expect(typeof txPkg.signedChildTx).toBe("string");
      expect(txPkg.signedChildTx.length).toBeGreaterThan(0);
      expect(txPkg.tx).toBeDefined();
      expect(txPkg.feeBumpPsbt).toBeDefined();
    }
  });

  it("preserves original fields on packages", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);

    const packages = [
      {
        leafId: "leaf-1",
        extraField: "preserved",
        txPackages: [
          { tx: "aabb", feeBumpPsbt: psbtHex, someOtherField: 42 },
        ],
      },
    ];

    const signed = signPackages({
      packages,
      privateKey: bytesToHex(privateKey),
    });

    expect(signed[0].extraField).toBe("preserved");
    expect(signed[0].txPackages[0].someOtherField).toBe(42);
    expect(signed[0].txPackages[0].tx).toBe("aabb");
  });

  it("handles multiple leaves", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);

    const packages = [
      {
        leafId: "leaf-1",
        txPackages: [{ tx: "aa", feeBumpPsbt: psbtHex }],
      },
      {
        leafId: "leaf-2",
        txPackages: [
          { tx: "bb", feeBumpPsbt: psbtHex },
          { tx: "cc", feeBumpPsbt: psbtHex },
          { tx: "dd", feeBumpPsbt: psbtHex },
        ],
      },
    ];

    const signed = signPackages({
      packages,
      privateKey: bytesToHex(privateKey),
    });

    expect(signed).toHaveLength(2);
    expect(signed[0].txPackages).toHaveLength(1);
    expect(signed[1].txPackages).toHaveLength(3);
    for (const leaf of signed) {
      for (const txPkg of leaf.txPackages) {
        expect(txPkg.signedChildTx).toBeDefined();
      }
    }
  });

  it("throws on missing leafId", () => {
    expect(() =>
      signPackages({
        packages: [{ txPackages: [] }],
        privateKey: "a".repeat(64),
      }),
    ).toThrow("leafId");
  });

  it("throws on missing feeBumpPsbt", () => {
    expect(() =>
      signPackages({
        packages: [
          { leafId: "leaf-1", txPackages: [{ tx: "aa" }] },
        ],
        privateKey: "a".repeat(64),
      }),
    ).toThrow("feeBumpPsbt");
  });

  it("throws on invalid private key", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);

    expect(() =>
      signPackages({
        packages: [
          { leafId: "leaf-1", txPackages: [{ tx: "aa", feeBumpPsbt: psbtHex }] },
        ],
        privateKey: "not-hex",
      }),
    ).toThrow("32-byte hex");
  });

  it("accepts Uint8Array private key", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const psbtHex = makeTestPsbt(privateKey);

    const signed = signPackages({
      packages: [
        { leafId: "leaf-1", txPackages: [{ tx: "aa", feeBumpPsbt: psbtHex }] },
      ],
      privateKey,
    });

    expect(signed[0].txPackages[0].signedChildTx).toBeDefined();
  });
});
