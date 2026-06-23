import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/legacy";
import { sha256 } from "@noble/hashes/sha2";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { Network, getNetwork } from "@buildonspark/spark-sdk";
import {
  BitcoinFaucet,
  SparkWalletTesting,
  createNewTree,
  signerTypes,
} from "@buildonspark/spark-sdk/test-utils";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

import { parseRecoveryBundle } from "../../src/bundle.js";
import { constructSparkPackages } from "../../src/spark-packages.js";

const runE2e = process.env.RUN_SPARK_E2E === "1";
const execFileAsync = promisify(execFile);
const LOCAL_OPERATORS = [
  {
    id: 0,
    port: 8535,
    identifier: "0000000000000000000000000000000000000000000000000000000000000001",
    identityPublicKey:
      "0322ca18fc489ae25418a0e768273c2c61cabb823edfb14feb891e9bec62016510",
  },
  {
    id: 1,
    port: 8536,
    identifier: "0000000000000000000000000000000000000000000000000000000000000002",
    identityPublicKey:
      "0341727a6c41b168f07eb50865ab8c397a53c7eef628ac1020956b705e43b6cb27",
  },
  {
    id: 2,
    port: 8537,
    identifier: "0000000000000000000000000000000000000000000000000000000000000003",
    identityPublicKey:
      "0305ab8d485cc752394de4981f8a5ae004f2becfea6f432c9a59d5022d8764f0a6",
  },
];

describe.skipIf(!runE2e)("Spark local unilateral-exit E2E", () => {
  it("constructs, broadcasts, and sweeps a unilateral-exit package from a saved bundle", async () => {
    const faucet = BitcoinFaucet.getInstance();
    const { Signer } = signerTypes[0];
    const { wallet, mnemonic } = await retry(
      () =>
        SparkWalletTesting.initialize({
          accountNumber: 1,
          options: { network: "LOCAL" },
          signer: new Signer(),
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
      const recoveryBundle = await exportBundleWithStandaloneTool(mnemonic);
      assertBundleContainsLeaf(recoveryBundle, leaf, { requireBundledNodes: true });

      const chains = await constructSparkPackages({
        bundle: recoveryBundle,
        cpfpUtxos: [funding.utxo],
        feeRate: 5,
      });

      expect(chains).toHaveLength(1);
      expect(chains[0]?.txPackages.length).toBeGreaterThanOrEqual(2);

      for (const txPackage of chains[0].txPackages) {
        await broadcastPackageAndMineTimelock(faucet, txPackage, funding.privateKey);
      }

      const destination = await faucet.getNewAddress();
      const sweepResult = await sweepWithCli(mnemonic, {
        destination,
        packages: chains,
      });

      expect(sweepResult.destination).toBe(destination);
      expect(sweepResult.sweeps).toHaveLength(1);
      expect(sweepResult.sweeps[0]).toMatchObject({
        leafId: leaf.id,
        refundVout: 0,
      });

      const sweepTxid = await faucet.broadcastTx(sweepResult.sweeps[0].sweepTx);
      expect(sweepTxid).toBe(sweepResult.sweeps[0].sweepTxid);
      await faucet.mineBlocksAndWaitForMiningToComplete(1);

      const sweepTxInfo = await faucet.getRawTransaction(sweepTxid);
      expect(sweepTxInfo.confirmations).toBeGreaterThan(0);
      assertSweepPaysDestination(sweepResult.sweeps[0], destination);
    } finally {
      await wallet.cleanup?.();
    }
  });
});

async function claimSingleDeposit(wallet, faucet, amount) {
  const leafId = randomUUID();
  await createNewTree(wallet, leafId, faucet, amount);

  return retry(
    async () => {
      await wallet.experimental_syncWallet?.();
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

async function exportBundleWithStandaloneTool(mnemonic) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spark-recovery-e2e-"));
  const seedFile = path.join(tempDir, "seed.txt");
  const outFile = path.join(tempDir, "bundle.json");
  await fs.writeFile(seedFile, `${mnemonic}\n`, { mode: 0o600 });

  const operatorArgs = [];
  for (const operator of LOCAL_OPERATORS) {
    const caCertFile = path.join(tempDir, `operator-${operator.id}.crt`);
    await fs.writeFile(caCertFile, await fetchOperatorCertificate(operator.port));
    operatorArgs.push("--operator");
    operatorArgs.push(
      [
        `id=${operator.id}`,
        `identifier=${operator.identifier}`,
        `address=https://localhost:${operator.port}`,
        `identity-public-key=${operator.identityPublicKey}`,
        `ca-cert=${caCertFile}`,
      ].join(","),
    );
  }

  await execFileAsync(
    "npm",
    [
      "run",
      "refresh-recovery-bundle",
      "--",
      "--seed-file",
      seedFile,
      "--network",
      "regtest",
      "--account-number",
      "1",
      "--out",
      outFile,
      "--operator-set",
      "local-docker-compose",
      "--app-version",
      "local-e2e",
      ...operatorArgs,
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return parseRecoveryBundle(await fs.readFile(outFile, "utf8"));
}

async function sweepWithCli(mnemonic, packageJson) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spark-sweep-e2e-"));
  const seedFile = path.join(tempDir, "seed.txt");
  const packagesFile = path.join(tempDir, "packages.json");
  await fs.writeFile(seedFile, `${mnemonic}\n`, { mode: 0o600 });
  await fs.writeFile(packagesFile, JSON.stringify(packageJson, null, 2));

  const { stdout } = await execFileAsync(
    "node",
    [
      "src/cli.js",
      "sweep",
      "--packages",
      packagesFile,
      "--seed-file",
      seedFile,
      "--network",
      "LOCAL",
      "--account-number",
      "1",
      "--fee-rate",
      "1",
    ],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return JSON.parse(stdout);
}

async function broadcastPackageAndMineTimelock(faucet, txPackage, fundingPrivateKey) {
  expect(txPackage?.tx).toBeTruthy();
  expect(txPackage?.feeBumpPsbt).toBeTruthy();

  const signedFeeBump = signPsbtWithKey(txPackage.feeBumpPsbt, fundingPrivateKey);
  const submitResult = await faucet.submitPackage([txPackage.tx, signedFeeBump]);

  if (!packageSubmitSucceeded(submitResult)) {
    console.error(
      "submitpackage tx summary",
      JSON.stringify(summarizePackage(txPackage.tx, signedFeeBump), null, 2),
    );
    console.error("submitpackage result", JSON.stringify(submitResult, null, 2));
  }
  expect(packageSubmitSucceeded(submitResult)).toBe(true);
  await faucet.mineBlocksAndWaitForMiningToComplete(2050);
}

function fetchOperatorCertificate(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: "localhost",
      port,
      servername: "localhost",
      rejectUnauthorized: false,
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(true);
      socket.destroy();
      if (!cert?.raw) {
        reject(new Error(`No TLS certificate returned by local operator ${port}`));
        return;
      }
      resolve(toPem(cert.raw));
    });
    socket.once("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`Timed out fetching TLS certificate from local operator ${port}`));
    });
  });
}

function toPem(der) {
  const body = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function assertBundleContainsLeaf(bundle, leaf, { requireBundledNodes = false } = {}) {
  expect(bundle.leaves).toHaveLength(1);
  expect(bundle.leaves[0]).toMatchObject({
    id: leaf.id,
    status: leaf.status,
    valueSats: Number(leaf.value),
  });
  if (requireBundledNodes) {
    expect(bundle.nodes?.length ?? 0).toBeGreaterThanOrEqual(1);
  }
  const decodedLeaf = TreeNode.decode(hexToBytes(bundle.leaves[0].treeNodeHex));
  expect(decodedLeaf.id).toBe(leaf.id);
  expect(decodedLeaf.value).toBe(leaf.value);
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

function assertSweepPaysDestination(sweep, destination) {
  const sweepTx = Transaction.fromRaw(hexToBytes(sweep.sweepTx), {
    allowUnknownOutputs: true,
  });
  const destinationScript = OutScript.encode(
    Address(getNetwork(Network.LOCAL)).decode(destination),
  );
  expect(sweepTx.id).toBe(sweep.sweepTxid);
  expect(sweepTx.inputsLength).toBe(1);
  expect(bytesToHex(sweepTx.getInput(0).txid)).toBe(sweep.refundTxid);
  expect(sweepTx.getInput(0).index).toBe(sweep.refundVout);
  expect(sweepTx.outputsLength).toBe(1);
  const output = sweepTx.getOutput(0);
  expect(output.amount).toBeGreaterThan(0n);
  expect(bytesToHex(output.script)).toBe(bytesToHex(destinationScript));
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
