import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/curves/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Transaction, p2wpkh } from "@scure/btc-signer";

import {
  signPackages,
  signPsbt,
  summarizePackages,
  SignError,
} from "../src/sign.ts";

function makeTestPackage({
  fundingPrivateKey,
  outputPrivateKey = fundingPrivateKey,
  fundingAmount = 10_000n,
  outputAmount = 8_000n,
  parentAnchorCount = 1,
  childAnchorCount = 1,
  includeFundingInput = true,
  childOutputCount = 1,
}: {
  fundingPrivateKey: Uint8Array;
  outputPrivateKey?: Uint8Array;
  fundingAmount?: bigint;
  outputAmount?: bigint;
  parentAnchorCount?: number;
  childAnchorCount?: number;
  includeFundingInput?: boolean;
  childOutputCount?: number;
}) {
  const fundingPayment = p2wpkh(
    secp256k1.getPublicKey(fundingPrivateKey, true),
  );
  const outputPayment = p2wpkh(
    secp256k1.getPublicKey(outputPrivateKey, true),
  );
  const anchorScript = new Uint8Array([0x51, 0x02, 0x4e, 0x73]);

  const parentTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  parentTx.addInput({
    txid: "11".repeat(32),
    index: 0,
    witnessUtxo: { amount: 1_000n, script: fundingPayment.script },
  });
  for (let index = 0; index < parentAnchorCount; index += 1) {
    parentTx.addOutput({ amount: 0n, script: anchorScript });
  }
  parentTx.addOutput({ amount: 900n, script: fundingPayment.script });
  parentTx.sign(fundingPrivateKey);
  parentTx.finalize();

  const childTx = new Transaction({ version: 3, allowUnknownOutputs: true });
  if (includeFundingInput) {
    childTx.addInput({
      txid: "22".repeat(32),
      index: 0,
      witnessUtxo: { amount: fundingAmount, script: fundingPayment.script },
    });
  }
  for (let index = 0; index < childAnchorCount; index += 1) {
    childTx.addInput({
      txid: parentTx.id,
      index: 0,
      witnessUtxo: { amount: 0n, script: anchorScript },
    });
  }
  for (let index = 0; index < childOutputCount; index += 1) {
    childTx.addOutput({
      amount: index === 0 ? outputAmount : 1n,
      script: outputPayment.script,
    });
  }

  return {
    parentTxHex: parentTx.hex,
    psbtHex: bytesToHex(childTx.toPSBT(0)),
  };
}

describe("signPsbt", () => {
  it("rejects malformed transaction data", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });

    expect(() => signPsbt("not-hex", privateKey, pkg.parentTxHex)).toThrow(
      /contains invalid transaction data/,
    );
  });

  it("signs owned funding inputs and skips the parent-bound anchor input", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });
    const signedHex = signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex);

    const signedTx = Transaction.fromRaw(
      Uint8Array.from(Buffer.from(signedHex, "hex")),
      { allowUnknownOutputs: true },
    );
    expect(signedTx.inputsLength).toBe(2);
  });

  it("accepts a hex string private key", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });
    expect(
      signPsbt(pkg.psbtHex, bytesToHex(privateKey), pkg.parentTxHex),
    ).toEqual(expect.any(String));
  });

  it("rejects a funding input not owned by the supplied key", () => {
    const suppliedKey = secp256k1.utils.randomPrivateKey();
    const attackerKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: attackerKey });

    expect(() => signPsbt(pkg.psbtHex, suppliedKey, pkg.parentTxHex)).toThrow(
      /input 0 is not owned/,
    );
  });

  it("rejects change redirected away from the supplied key", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const attackerKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({
      fundingPrivateKey: privateKey,
      outputPrivateKey: attackerKey,
    });

    expect(() => signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex)).toThrow(
      /change output is not.*owned/,
    );
  });

  it("rejects an anchor input not bound to the companion parent", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });
    const differentParent = makeTestPackage({
      fundingPrivateKey: secp256k1.utils.randomPrivateKey(),
    });

    expect(() =>
      signPsbt(pkg.psbtHex, privateKey, differentParent.parentTxHex),
    ).toThrow(/anchor input is not bound/);
  });

  it.each([
    { parentAnchorCount: 0, expectedCount: 0 },
    { parentAnchorCount: 2, expectedCount: 2 },
  ])(
    "rejects a parent with $expectedCount ephemeral anchors",
    ({ parentAnchorCount, expectedCount }) => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const pkg = makeTestPackage({
        fundingPrivateKey: privateKey,
        parentAnchorCount,
      });

      expect(() =>
        signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex),
      ).toThrow(
        `parent must contain exactly one ephemeral anchor output, got ${expectedCount}`,
      );
    },
  );

  it("rejects a funding input without a positive witness UTXO", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({
      fundingPrivateKey: privateKey,
      fundingAmount: 0n,
    });

    expect(() => signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex)).toThrow(
      "input 0 is missing a positive witness UTXO",
    );
  });

  it.each([
    { childAnchorCount: 0, expectedCount: 0 },
    { childAnchorCount: 2, expectedCount: 2 },
  ])(
    "rejects a fee-bump transaction spending $expectedCount anchors",
    ({ childAnchorCount, expectedCount }) => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const pkg = makeTestPackage({
        fundingPrivateKey: privateKey,
        childAnchorCount,
      });

      expect(() =>
        signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex),
      ).toThrow(`must spend exactly one ephemeral anchor, got ${expectedCount}`);
    },
  );

  it("rejects a fee-bump transaction without a CPFP funding input", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({
      fundingPrivateKey: privateKey,
      includeFundingInput: false,
    });

    expect(() => signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex)).toThrow(
      "has no CPFP funding input owned by the supplied key",
    );
  });

  it.each([0, 2])(
    "rejects a fee-bump transaction with %i change outputs",
    (childOutputCount) => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const pkg = makeTestPackage({
        fundingPrivateKey: privateKey,
        childOutputCount,
      });

      expect(() =>
        signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex),
      ).toThrow(
        `must have exactly one CPFP change output, got ${childOutputCount}`,
      );
    },
  );

  it("rejects a zero-valued change output", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({
      fundingPrivateKey: privateKey,
      outputAmount: 0n,
    });

    expect(() => signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex)).toThrow(
      /change output is not a positive output owned/,
    );
  });

  it.each([
    { outputAmount: 10_000n, description: "zero" },
    { outputAmount: 10_001n, description: "negative" },
  ])(
    "rejects a $description fee",
    ({ outputAmount }) => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const pkg = makeTestPackage({
        fundingPrivateKey: privateKey,
        outputAmount,
      });

      expect(() => signPsbt(pkg.psbtHex, privateKey, pkg.parentTxHex)).toThrow(
        "has a non-positive fee",
      );
    },
  );
});

describe("signPackages", () => {
  it("summarizes validated inputs, change, and fee before signing", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });

    expect(
      summarizePackages({
        packages: [
          {
            leafId: "leaf-1",
            txPackages: [{ tx: pkg.parentTxHex, feeBumpPsbt: pkg.psbtHex }],
          },
        ],
        privateKey,
      }),
    ).toEqual([
      expect.objectContaining({
        leafId: "leaf-1",
        packageIndex: 0,
        fundingInputCount: 1,
        fundingInputSats: "10000",
        changeOutputSats: "8000",
        feeSats: "2000",
      }),
    ]);
  });

  it("requires an explicit approval signal", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const pkg = makeTestPackage({ fundingPrivateKey: privateKey });

    expect(() =>
      signPackages({
        packages: [
          {
            leafId: "leaf-1",
            txPackages: [{ tx: pkg.parentTxHex, feeBumpPsbt: pkg.psbtHex }],
          },
        ],
        privateKey,
      }),
    ).toThrow(/Explicit signing approval/);
  });

  it("signs every validated entry and preserves original fields", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const first = makeTestPackage({ fundingPrivateKey: privateKey });
    const second = makeTestPackage({ fundingPrivateKey: privateKey });
    const packages = [
      {
        leafId: "leaf-1",
        extraField: "preserved",
        txPackages: [
          {
            tx: first.parentTxHex,
            feeBumpPsbt: first.psbtHex,
            someOtherField: 42,
          },
          { tx: second.parentTxHex, feeBumpPsbt: second.psbtHex },
        ],
      },
    ];

    const signed = signPackages({
      packages,
      privateKey: bytesToHex(privateKey),
      approved: true,
    });

    expect(signed[0]!.extraField).toBe("preserved");
    expect(signed[0]!.txPackages).toHaveLength(2);
    expect(signed[0]!.txPackages![0]!.someOtherField).toBe(42);
    for (const txPkg of signed[0]!.txPackages!) {
      expect(txPkg.signedChildTx).toEqual(expect.any(String));
    }
  });

  it("throws on missing leafId", () => {
    expect(() =>
      summarizePackages({
        packages: [{ txPackages: [] }],
        privateKey: "a".repeat(64),
      }),
    ).toThrow("leafId");
  });

  it("throws on missing parent tx", () => {
    expect(() =>
      summarizePackages({
        packages: [
          { leafId: "leaf-1", txPackages: [{ feeBumpPsbt: "aa" }] },
        ],
        privateKey: "a".repeat(64),
      }),
    ).toThrow("parent tx");
  });

  it("throws on missing feeBumpPsbt", () => {
    expect(() =>
      summarizePackages({
        packages: [{ leafId: "leaf-1", txPackages: [{ tx: "aa" }] }],
        privateKey: "a".repeat(64),
      }),
    ).toThrow("feeBumpPsbt");
  });

  it("throws on invalid private key", () => {
    expect(() =>
      summarizePackages({ packages: [], privateKey: "not-hex" }),
    ).toThrow(SignError);
  });
});
