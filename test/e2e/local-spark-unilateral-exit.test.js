import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { Network, getNetwork } from "@buildonspark/spark-sdk";
import {
  BitcoinFaucet,
  SparkWalletTesting,
  getTestWalletConfig,
} from "@buildonspark/spark-sdk/test-utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import { constructSparkPackages } from "../../src/spark-packages.js";

const runE2e = process.env.RUN_SPARK_E2E === "1";

describe.skipIf(!runE2e)("Spark local unilateral-exit E2E", () => {
  it("constructs and broadcasts a unilateral-exit package from a saved bundle", async () => {
    const faucet = BitcoinFaucet.getInstance();
    const { wallet } = await retry(
      () =>
        SparkWalletTesting.initialize({
          options: getTestWalletConfig(),
        }),
      "initialize Spark wallet",
    );

    try {
      const leaf = await retry(
        () => claimSingleDeposit(wallet, faucet, 100_000n),
        "claim Spark deposit leaf",
        20,
      );
      const funding = await makeCpfpFundingUtxo(faucet, 50_000n);
      const bundle = {
        schema: "blink.spark-unilateral-exit-bundle.v1",
        createdAt: new Date().toISOString(),
        network: "LOCAL",
        operatorSet: "local-docker-compose",
        leaves: [
          {
            id: leaf.id,
            status: leaf.status,
            valueSats: Number(leaf.value),
            treeNodeHex: bytesToHex(TreeNode.encode(leaf).finish()),
          },
        ],
      };

      const chains = await constructSparkPackages({
        bundle,
        cpfpUtxos: [funding.utxo],
        feeRate: 5,
        sparkClient: await createSparkClient(wallet),
      });

      expect(chains).toHaveLength(1);
      const firstPackage = chains[0]?.txPackages[0];
      expect(firstPackage?.tx).toBeTruthy();
      expect(firstPackage?.feeBumpPsbt).toBeTruthy();

      const signedFeeBump = signPsbtWithKey(
        firstPackage.feeBumpPsbt,
        funding.privateKey,
      );
      const submitResult = await faucet.submitPackage([
        firstPackage.tx,
        signedFeeBump,
      ]);

      if (!packageSubmitSucceeded(submitResult)) {
        console.error(
          "submitpackage tx summary",
          JSON.stringify(summarizePackage(firstPackage.tx, signedFeeBump), null, 2),
        );
        console.error(
          "submitpackage result",
          JSON.stringify(submitResult, null, 2),
        );
      }
      expect(packageSubmitSucceeded(submitResult)).toBe(true);
      await faucet.mineBlocksAndWaitForMiningToComplete(2000);
    } finally {
      await wallet.cleanup?.();
    }
  });
});

async function claimSingleDeposit(wallet, faucet, amount) {
  const depositAddress = await wallet.getSingleUseDepositAddress();
  if (!depositAddress) throw new Error("Deposit address not found");

  const fundingTx = await faucet.sendToAddress(depositAddress, amount);
  await faucet.mineBlocksAndWaitForMiningToComplete(6);
  await wallet.claimDeposit(fundingTx.id);

  return retry(
    async () => {
      const leaves = await wallet.getLeaves();
      if (leaves.length !== 1) {
        throw new Error(`Expected one claimed leaf, got ${leaves.length}`);
      }
      return leaves[0];
    },
    "wait for claimed Spark leaf",
    20,
  );
}

async function createSparkClient(wallet) {
  const connectionManager =
    wallet.getConnectionManager?.() ?? wallet.connectionManager;
  const configService = wallet.getConfigService?.() ?? wallet.config;
  if (!connectionManager?.createSparkClient || !configService?.getCoordinatorAddress) {
    return undefined;
  }
  return connectionManager.createSparkClient(configService.getCoordinatorAddress());
}

async function retry(fn, label, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.warn(
        `${label} failed on attempt ${attempt}/${attempts}; retrying: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

async function makeCpfpFundingUtxo(faucet, amount) {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const bitcoinNetwork = getNetwork(Network.LOCAL);
  const address = Address(bitcoinNetwork).encode({
    type: "wpkh",
    hash: hash160(publicKey),
  });

  const fundingTx = await faucet.sendToAddress(address, amount);
  await faucet.mineBlocksAndWaitForMiningToComplete(6);
  const script = OutScript.encode(Address(bitcoinNetwork).decode(address));
  const vout = findOutputIndex(fundingTx, script, amount);

  return {
    privateKey,
    utxo: {
      txid: fundingTx.id,
      vout,
      value: amount,
      script: bytesToHex(script),
      publicKey: bytesToHex(publicKey),
    },
  };
}

function signPsbtWithKey(psbtHex, privateKey) {
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
    tx.signIdx(privateKey, i);
    tx.finalizeIdx(i);
  }

  return bytesToHex(tx.toBytes(true, true));
}

function summarizePackage(parentHex, childHex) {
  return {
    parent: summarizeTx(parentHex),
    child: summarizeTx(childHex),
  };
}

function summarizeTx(txHex) {
  const tx = Transaction.fromRaw(hexToBytes(txHex), {
    allowUnknownOutputs: true,
  });
  const outputs = [];
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i);
    outputs.push({
      index: i,
      amount: output?.amount?.toString(),
      script: output?.script ? bytesToHex(output.script) : null,
    });
  }
  return {
    txid: getTransactionIdForDiagnostics(tx),
    inputs: tx.inputsLength,
    outputs,
  };
}

function getTransactionIdForDiagnostics(tx) {
  try {
    return tx.id;
  } catch {
    return null;
  }
}

function findOutputIndex(tx, script, amount) {
  for (let i = 0; i < tx.outputsLength; i += 1) {
    const output = tx.getOutput(i);
    if (
      output?.amount === amount &&
      bytesToHex(output.script) === bytesToHex(script)
    ) {
      return i;
    }
  }
  throw new Error("Could not find CPFP funding output");
}

function packageSubmitSucceeded(result) {
  if (!result || typeof result !== "object") return false;
  const packageMsg = String(
    result["package-msg"] ?? result.package_msg ?? "",
  ).toLowerCase();
  if (packageMsg === "success") return true;
  const txResults = result["tx-results"];
  if (!txResults || typeof txResults !== "object") return false;
  return Object.values(txResults).every((value) => {
    const error = value?.error;
    return error === undefined || error === null || error === "";
  });
}

function hash160(bytes) {
  return ripemd160(sha256(bytes));
}

function isEphemeralAnchorOutput(script, amount) {
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
