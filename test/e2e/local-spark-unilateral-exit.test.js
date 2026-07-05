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

const runE2e = process.env.RUN_SPARK_E2E === "1";
const execFileAsync = promisify(execFile);
const repoRoot = new URL("../..", import.meta.url).pathname;
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
  it("constructs, signs, broadcasts, and sweeps via CLI commands", async () => {
    // Progress markers so CI shows which phase is running and how long each
    // took (this test has no per-step output otherwise, so a slow phase looks
    // like a hang). Emitted on stderr, which vitest streams live.
    const startedAt = Date.now();
    let lastStepAt = startedAt;
    const step = (label) => {
      const now = Date.now();
      const total = ((now - startedAt) / 1000).toFixed(1);
      const delta = ((now - lastStepAt) / 1000).toFixed(1);
      lastStepAt = now;
      console.error(`[e2e +${total}s Δ${delta}s] ${label}`);
    };

    const faucet = BitcoinFaucet.getInstance();
    const { Signer } = signerTypes[0];
    step("initializing Spark wallet");
    const { wallet, mnemonic } = await retry(
      () =>
        SparkWalletTesting.initialize({
          accountNumber: 1,
          options: { network: "LOCAL" },
          signer: new Signer(),
        }),
      "initialize Spark wallet",
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spark-e2e-"));

    try {
      step("claiming Spark deposit leaf");
      const leaf = await retry(
        () => claimSingleDeposit(wallet, faucet, 100_000n),
        "claim Spark deposit leaf",
        20,
      );
      step("creating CPFP funding utxo");
      const funding = await makeCpfpFundingUtxo(faucet, 50_000n);

      // Step 1: refresh-bundle (via standalone Rust tool, same as make refresh-recovery-bundle)
      step("refresh-bundle (standalone Rust tool)");
      const bundlePath = path.join(tempDir, "bundle.json");
      await exportBundleWithStandaloneTool(mnemonic, tempDir, bundlePath);
      const recoveryBundle = parseRecoveryBundle(await fs.readFile(bundlePath, "utf8"));
      assertBundleContainsLeaf(recoveryBundle, leaf, { requireBundledNodes: true });

      // Step 2: package (equivalent to: make package)
      step("package (CLI)");
      const cpfpUtxoStr = [
        funding.utxo.txid,
        funding.utxo.vout,
        funding.utxo.value.toString(),
        funding.utxo.script,
        funding.utxo.publicKey,
      ].join(":");
      const destination = await faucet.getNewAddress();
      const packagesPath = path.join(tempDir, "packages.json");
      const { stdout: packageOut } = await execFileAsync(
        "node",
        [
          "src/cli.js", "package",
          "--bundle", bundlePath,
          "--destination", destination,
          "--fee-rate", "5",
          "--cpfp-utxo", cpfpUtxoStr,
        ],
        { cwd: repoRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      await fs.writeFile(packagesPath, packageOut);
      const packageJson = JSON.parse(packageOut);
      expect(packageJson.packages).toHaveLength(1);
      expect(packageJson.packages[0]?.txPackages.length).toBeGreaterThanOrEqual(2);

      // Step 3: sign-packages (equivalent to: make sign-packages)
      step("sign-packages (CLI)");
      const keyFilePath = path.join(tempDir, "cpfp-key.hex");
      await fs.writeFile(keyFilePath, bytesToHex(funding.privateKey), { mode: 0o600 });
      const signedPath = path.join(tempDir, "packages-signed.json");
      await execFileAsync(
        "node",
        [
          "src/cli.js", "sign-packages",
          "--packages", packagesPath,
          "--key-file", keyFilePath,
          "--out", signedPath,
        ],
        { cwd: repoRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const signedJson = JSON.parse(await fs.readFile(signedPath, "utf8"));
      expect(signedJson.packages).toHaveLength(1);
      for (const txPkg of signedJson.packages[0].txPackages) {
        expect(txPkg.signedChildTx).toBeTruthy();
        expect(txPkg.tx).toBeTruthy();
      }

      // Step 4: broadcast signed packages (submitpackage to regtest bitcoind)
      step("broadcast packages + mine CPFP timelock");
      for (const leafPkg of signedJson.packages) {
        for (const txPkg of leafPkg.txPackages) {
          await broadcastSignedPackageAndMineTimelock(faucet, txPkg);
        }
      }

      // Step 5: sweep (equivalent to: make sweep)
      step("sweep (CLI)");
      const seedFile = path.join(tempDir, "seed.txt");
      await fs.writeFile(seedFile, `${mnemonic}\n`, { mode: 0o600 });
      const { stdout: sweepOut } = await execFileAsync(
        "node",
        [
          "src/cli.js", "sweep",
          "--packages", packagesPath,
          "--seed-file", seedFile,
          "--network", "LOCAL",
          "--destination", destination,
          "--account-number", "1",
          "--fee-rate", "1",
        ],
        { cwd: repoRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
      const sweepResult = JSON.parse(sweepOut);

      expect(sweepResult.destination).toBe(destination);
      expect(sweepResult.sweeps).toHaveLength(1);
      expect(sweepResult.sweeps[0]).toMatchObject({
        leafId: leaf.id,
        refundVout: 0,
      });

      // Step 6: broadcast sweep tx
      step("broadcast sweep tx + mine");
      const sweepTxid = await faucet.broadcastTx(sweepResult.sweeps[0].sweepTx);
      expect(sweepTxid).toBe(sweepResult.sweeps[0].sweepTxid);
      await faucet.mineBlocksAndWaitForMiningToComplete(1);

      const sweepTxInfo = await faucet.getRawTransaction(sweepTxid);
      expect(sweepTxInfo.confirmations).toBeGreaterThan(0);
      assertSweepPaysDestination(sweepResult.sweeps[0], destination);
      step("done");
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

async function exportBundleWithStandaloneTool(mnemonic, tempDir, outFile) {
  const seedFile = path.join(tempDir, "seed.txt");
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
    { cwd: repoRoot, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function broadcastSignedPackageAndMineTimelock(faucet, txPackage) {
  expect(txPackage?.tx).toBeTruthy();
  expect(txPackage?.signedChildTx).toBeTruthy();

  const submitResult = await faucet.submitPackage([txPackage.tx, txPackage.signedChildTx]);

  if (!packageSubmitSucceeded(submitResult)) {
    console.error(
      "submitpackage tx summary",
      JSON.stringify(summarizePackage(txPackage.tx, txPackage.signedChildTx), null, 2),
    );
    console.error("submitpackage result", JSON.stringify(submitResult, null, 2));
  }
  expect(packageSubmitSucceeded(submitResult)).toBe(true);
  const mineStart = Date.now();
  console.error("[e2e] mining 2050 blocks to clear the CPFP relative timelock...");
  await faucet.mineBlocksAndWaitForMiningToComplete(2050);
  console.error(
    `[e2e] mined 2050 blocks in ${((Date.now() - mineStart) / 1000).toFixed(1)}s`,
  );
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
