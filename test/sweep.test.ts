import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p2tr, Transaction } from "@scure/btc-signer";

import {
  SweepError,
  constructSweepTransactions,
  deriveRefundKeyCandidates,
} from "../src/sweep.ts";

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const REGTEST = { bech32: "bcrt", pubKeyHash: 111, scriptHash: 196, wif: 239 };

describe("sweep construction", () => {
  it("spends a Spark refund output to the destination", () => {
    const leafId = "leaf-1";
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId,
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");

    const refundTx = createSignedRefundTx(refundKey!.script, 10_000n);
    const result = constructSweepTransactions({
      seed: SEED,
      network: "REGTEST",
      packages: {
        destination: refundKey!.address,
        packages: [{ leafId, txPackages: [{ tx: refundTx.hex }] }],
      },
      destination: refundKey!.address!,
      feeRate: 1,
      accountNumber: 1,
    });

    expect(result.sweeps).toHaveLength(1);
    expect(result.sweeps[0]).toMatchObject({
      leafId,
      refundTxid: refundTx.id,
      refundVout: 0,
      refundValueSats: "10000",
      refundAddress: refundKey!.address,
      derivationPath: "m/8797555'/1'/1'/1094762254'",
      feeSats: "111",
      vsize: 111,
    });

    const sweepTx = Transaction.fromRaw(
      Uint8Array.from(Buffer.from(result.sweeps[0]!.sweepTx, "hex")),
      { allowUnknownOutputs: true },
    );
    expect(sweepTx.id).toBe(result.sweeps[0]!.sweepTxid);
  });

  it("spends the preserved terminal refund when txPackages is empty", () => {
    const leafId = "leaf-direct-refund";
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId,
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");
    const refundTx = createSignedRefundTx(refundKey!.script, 10_000n);

    const result = constructSweepTransactions({
      seed: SEED,
      network: "REGTEST",
      packages: {
        packages: [{ leafId, txPackages: [], sweepTx: refundTx.hex }],
      },
      destination: refundKey!.address!,
      feeRate: 1,
      accountNumber: 1,
    });

    expect(result.sweeps).toHaveLength(1);
    expect(result.sweeps[0]).toMatchObject({
      leafId,
      refundTxid: refundTx.id,
      refundValueSats: "10000",
    });
  });

  // reattachPendingRefunds can preserve one of the operator's alternate refund
  // routes, and those arrive unsigned. The sweep must still be constructible:
  // Transaction.id throws on an unfinalized input, but the txid is already known.
  it("sweeps a preserved terminal refund the operator left unsigned", () => {
    const leafId = "leaf-unsigned-refund";
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId,
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");
    const refundTx = createUnsignedRefundTx(refundKey!.script, 10_000n);

    const result = constructSweepTransactions({
      seed: SEED,
      network: "REGTEST",
      packages: {
        packages: [{ leafId, txPackages: [], sweepTx: refundTx.hex }],
      },
      destination: refundKey!.address!,
      feeRate: 1,
      accountNumber: 1,
    });

    expect(result.sweeps).toHaveLength(1);
    expect(result.sweeps[0]).toMatchObject({
      leafId,
      // The txid the refund keeps once signed — what the sweep must spend.
      refundTxid: refundTx.signedTxid,
      refundVout: 0,
      refundValueSats: "10000",
    });

    const sweepTx = Transaction.fromRaw(
      Uint8Array.from(Buffer.from(result.sweeps[0]!.sweepTx, "hex")),
      { allowUnknownOutputs: true },
    );
    expect(sweepTx.id).toBe(result.sweeps[0]!.sweepTxid);
  });

  it("fails closed when the seed does not match the refund output", () => {
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId: "leaf-1",
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");
    const refundTx = createSignedRefundTx(refundKey!.script, 10_000n);

    expect(() =>
      constructSweepTransactions({
        seed:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon",
        network: "REGTEST",
        packages: {
          destination: refundKey!.address,
          packages: [{ leafId: "leaf-1", txPackages: [{ tx: refundTx.hex }] }],
        },
        destination: refundKey!.address!,
        feeRate: 1,
        accountNumber: 1,
      }),
    ).toThrow(SweepError);
  });

  it("requires a trusted destination instead of falling back to package JSON", () => {
    const leafId = "leaf-1";
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId,
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");
    const refundTx = createSignedRefundTx(refundKey!.script, 10_000n);

    expect(() =>
      constructSweepTransactions({
        seed: SEED,
        network: "REGTEST",
        packages: {
          destination: refundKey!.address,
          packages: [{ leafId, txPackages: [{ tx: refundTx.hex }] }],
        },
        destination: undefined as unknown as string,
        feeRate: 1,
        accountNumber: 1,
      }),
    ).toThrow(/--destination is required.*package JSON destination is never used/);
  });

  it("uses the explicit destination when package JSON contains another address", () => {
    const leafId = "leaf-1";
    const refundKey = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId,
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key");
    const packageAddress = deriveRefundKeyCandidates({
      seed: SEED,
      network: "REGTEST",
      leafId: "tampered-package-value",
      accountNumber: 1,
    }).find((candidate) => candidate.label === "node signing key")!.address;
    const refundTx = createSignedRefundTx(refundKey!.script, 10_000n);

    const result = constructSweepTransactions({
      seed: SEED,
      network: "REGTEST",
      packages: {
        destination: packageAddress,
        packages: [{ leafId, txPackages: [{ tx: refundTx.hex }] }],
      },
      destination: refundKey!.address!,
      feeRate: 1,
      accountNumber: 1,
    });

    expect(packageAddress).not.toBe(refundKey!.address);
    expect(result.destination).toBe(refundKey!.address);
  });
});

function createSignedRefundTx(refundScript: Uint8Array, amount: bigint) {
  const fundingPrivateKey = new Uint8Array(32).fill(2);
  const fundingXonly = secp256k1.getPublicKey(fundingPrivateKey, true).slice(1);
  const fundingOutput = p2tr(fundingXonly, undefined, REGTEST);
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: "00".repeat(32),
    index: 0,
    witnessUtxo: {
      amount: amount + 1_000n,
      script: fundingOutput.script,
    },
    tapInternalKey: fundingXonly,
  });
  tx.addOutput({ script: refundScript, amount });
  tx.sign(fundingPrivateKey);
  tx.finalize();
  return tx;
}

// The same refund as it leaves the operator: serialized before signing, with the
// txid it will still have afterwards.
function createUnsignedRefundTx(
  refundScript: Uint8Array,
  amount: bigint,
): { hex: string; signedTxid: string } {
  const fundingPrivateKey = new Uint8Array(32).fill(2);
  const fundingXonly = secp256k1.getPublicKey(fundingPrivateKey, true).slice(1);
  const fundingOutput = p2tr(fundingXonly, undefined, REGTEST);
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: "00".repeat(32),
    index: 0,
    witnessUtxo: { amount: amount + 1_000n, script: fundingOutput.script },
    tapInternalKey: fundingXonly,
  });
  tx.addOutput({ script: refundScript, amount });
  const hex = tx.hex;
  tx.sign(fundingPrivateKey);
  tx.finalize();
  return { hex, signedTxid: tx.id };
}
