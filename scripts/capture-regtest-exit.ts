// Drive a real Spark unilateral exit on the local regtest stack and capture
// every on-chain transaction it produces, so the detector can be validated
// against ground truth (and the webapp has real fixtures).
//
// Mirrors test/e2e/local-spark-unilateral-exit.test.ts but keeps every raw tx
// along the way: the static deposit that funds the leaf tree, the CPFP
// funding tx, the node tx / CPFP refund chain from the exit package, and the
// constructed sweep tx. The 2048-block refund timelock is NOT waited out;
// the sweep is recorded unsigned-broadcast for shape analysis.
//
// Usage (stack must be up: scripts/desktop-regtest.sh up or compose up):
//   node scripts/capture-regtest-exit.ts --out test/fixtures/webapp
//
// Output: <out>/exit-capture.json plus one .hex file per tx.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha256";
import { Transaction } from "@scure/btc-signer";
import {
  BitcoinFaucet,
  SparkWalletTesting,
  createNewTree,
  signerTypes,
} from "@buildonspark/spark-sdk/test-utils";
import { txStructure } from "../src/webapp/exit-detector.ts";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;

interface CliArgs {
  out?: string;
}
const parsed: CliArgs = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!.replace(/^--/, "");
  (parsed as Record<string, string | undefined>)[key] = process.argv[i + 1] ?? "";
}
const outDir = path.resolve(repoRoot, parsed.out ?? "test/fixtures/webapp");

interface CapturedTx {
  txid: string;
  txHex: string;
  labels: string[];
  broadcast: boolean;
}

interface Capture {
  schema: string;
  createdAt: string;
  network: string;
  description: string;
  txs: CapturedTx[];
  notes: Record<string, unknown>;
}

function step(label: string): void {
  process.stderr.write(`[capture] ${label}\n`);
}

async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 10,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${label} failed on attempt ${attempt}/${attempts}: ${message}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw lastError;
}

const LOCAL_OPERATORS = [
  { id: 0, port: 8535 },
  { id: 1, port: 8536 },
  { id: 2, port: 8537 },
];

function fetchOperatorCertificate(port: number): Promise<string> {
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
        reject(new Error(`no TLS certificate from local operator ${port}`));
        return;
      }
      const body = cert.raw.toString("base64").match(/.{1,64}/g)!.join("\n");
      resolve(
        `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
      );
    });
    socket.once("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error(`timed out fetching certificate from ${port}`));
    });
  });
}

function runCli(
  cliArgs: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("node", ["src/cli.ts", ...cliArgs], {
    cwd: repoRoot,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
}

// Minimal Esplora stand-in: serves the real CPFP funding UTXO and the tip
// height so the actual watch-cpfp CLI command runs end to end against the
// local stack (same trick as the e2e test's mock).
async function startRpcBackedEsplora({
  utxo,
  tipHeight,
}: {
  utxo: { txid: string; vout: number; value: number };
  tipHeight: number;
}) {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("/blocks/tip/height")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(String(tipHeight));
      return;
    }
    if (url.includes("/address/") && url.endsWith("/utxo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { ...utxo, status: { confirmed: true, block_height: 1 } },
        ]),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main(): Promise<void> {
  const faucet = BitcoinFaucet.getInstance();
  const { Signer } = signerTypes[0]!;
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

  const tempDir = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "spark-capture-"),
  );
  const capture: Capture = {
    schema: "spark.exit-capture.v1",
    createdAt: new Date().toISOString(),
    network: "LOCAL",
    description:
      "Ground-truth unilateral exit captured from the local Spark regtest stack",
    txs: [],
    notes: {},
  };
  const byTxid = new Map<string, CapturedTx>();
  const recordTx = (txHex: string, labels: string[], broadcast: boolean): void => {
    const tx = Transaction.fromRaw(hexToBytes(txHex), {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
      disableScriptCheck: true,
    });
    // Legacy no-witness serialization txid: works for signed and unsigned
    // transactions alike (same rule the repo's refundTxidFromHex applies).
    const legacy = tx.toBytes(true, false);
    const txid = bytesToHex(
      new Uint8Array([...sha256(sha256(legacy))].reverse()),
    );
    const existing = byTxid.get(txid);
    if (existing) {
      existing.labels = [...new Set([...existing.labels, ...labels])];
      existing.broadcast = existing.broadcast || broadcast;
      return;
    }
    const entry: CapturedTx = { txid, txHex, labels, broadcast };
    byTxid.set(txid, entry);
    capture.txs.push(entry);
  };

  try {
    step("claiming Spark deposit leaf");
    const leaf = await retry(
      async () => {
        await createNewTree(wallet, randomUUID(), faucet, 100_000n);
        await wallet.experimental_syncWallet?.();
        const leaves = await wallet.getLeaves();
        if (leaves.length !== 1) {
          throw new Error(`expected 1 leaf, got ${leaves.length}`);
        }
        return leaves[0]!;
      },
      "claim Spark deposit leaf",
      20,
    );

    const seedFile = path.join(tempDir, "seed.txt");
    await fs.writeFile(seedFile, `${mnemonic}\n`, { mode: 0o600 });

    step("refresh-bundle (direct operator export)");
    const bundlePath = path.join(tempDir, "bundle.json");
    const coordinator = LOCAL_OPERATORS[0]!;
    const caCertFile = path.join(tempDir, `operator-${coordinator.id}.crt`);
    await fs.writeFile(
      caCertFile,
      await fetchOperatorCertificate(coordinator.port),
    );
    await runCli(
      [
        "refresh-bundle",
        "--seed-file", seedFile,
        "--network", "regtest",
        "--account-number", "1",
        "--coordinator", `https://localhost:${coordinator.port}`,
        "--out", bundlePath,
        "--operator-set", "local-docker-compose",
        "--app-version", "exit-capture",
      ],
      { NODE_EXTRA_CA_CERTS: caCertFile },
    );

    // Route on-chain checks at the local bitcoind (same rationale as the
    // e2e resume test: REGTEST routing queries a public esplora that cannot
    // see this chain).
    const localBundle = JSON.parse(await fs.readFile(bundlePath, "utf8")) as {
      network: string;
    };
    localBundle.network = "LOCAL";
    await fs.writeFile(bundlePath, JSON.stringify(localBundle));

    step("cpfp-address (derive + estimate)");
    const { stdout: cpfpAddressOut } = await runCli([
      "cpfp-address",
      "--bundle", bundlePath,
      "--seed-file", seedFile,
      "--network", "LOCAL",
      "--account-number", "1",
      "--fee-rate", "5",
    ]);
    const cpfpInfo = JSON.parse(cpfpAddressOut) as {
      cpfpAddress: string;
      script: string;
      publicKey: string;
      requiredSats: string;
    };
    const requiredSats = BigInt(cpfpInfo.requiredSats);

    step("funding the CPFP address on-chain");
    const fundingTx = await faucet.sendToAddress(
      cpfpInfo.cpfpAddress,
      requiredSats,
    );
    await faucet.mineBlocksAndWaitForMiningToComplete(6);
    let fundingVout = -1;
    for (let i = 0; i < fundingTx.outputsLength; i += 1) {
      const output = fundingTx.getOutput(i);
      if (
        output &&
        bytesToHex(output.script!) === cpfpInfo.script &&
        output.amount === requiredSats
      ) {
        fundingVout = i;
      }
    }
    if (fundingVout < 0) throw new Error("CPFP funding output not found");
    recordTx(fundingTx.hex, ["cpfp-funding"], true);

    step("watch-cpfp via RPC-backed mock esplora");
    const esplora = await startRpcBackedEsplora({
      utxo: {
        txid: fundingTx.id,
        vout: fundingVout,
        value: Number(requiredSats),
      },
      tipHeight: 1,
    });
    let cpfpUtxoStr: string;
    try {
      const { stdout: watchOut } = await runCli([
        "watch-cpfp",
        "--seed-file", seedFile,
        "--network", "LOCAL",
        "--account-number", "1",
        "--min-sats", requiredSats.toString(),
        "--min-confirmations", "1",
        "--poll-interval", "1",
        "--timeout", "60",
        "--esplora-url", esplora.url,
      ]);
      const watched = JSON.parse(watchOut) as { cpfpUtxo: string };
      cpfpUtxoStr = watched.cpfpUtxo;
    } finally {
      await esplora.close();
    }

    step("package (CLI)");
    const destination = await faucet.getNewAddress();
    const { stdout: packageOut } = await runCli([
      "package",
      "--bundle", bundlePath,
      "--destination", destination,
      "--fee-rate", "5",
      "--cpfp-utxo", cpfpUtxoStr,
    ]);
    const packagesPath = path.join(tempDir, "packages.json");
    await fs.writeFile(packagesPath, packageOut);

    step("sign-packages (CLI)");
    const signedPath = path.join(tempDir, "packages-signed.json");
    await runCli([
      "sign-packages",
      "--packages", packagesPath,
      "--seed-file", seedFile,
      "--network", "LOCAL",
      "--account-number", "1",
      "--yes",
      "--out", signedPath,
    ]);
    const signed = JSON.parse(await fs.readFile(signedPath, "utf8")) as {
      packages: Array<{
        leafId: string;
        txPackages: Array<{ tx: string; signedChildTx: string }>;
      }>;
    };

    step("broadcasting exit chain (node tx + CPFP refund child)");
    for (const leafPkg of signed.packages) {
      for (const [stepIdx, txPkg] of leafPkg.txPackages.entries()) {
        await faucet.submitPackage([txPkg.tx, txPkg.signedChildTx]);
        // The SDK emits the leaf's exit chain as ordered steps: step 0 is the
        // node tx (TRUC+anchor, no CSV), step 1 the refund (CSV-locked). The
        // submit of step 1 fails until the CSV matures; that is expected on a
        // fresh capture and the tx is still recorded for shape analysis.
        const stepLabel = stepIdx === 0 ? "node-tx" : "refund-tx";
        if (stepIdx === 0) {
          recordTx(txPkg.tx, [stepLabel, `leaf:${leafPkg.leafId}`], true);
          // The static deposit backing the tree: the node tx's first prevout.
          // Pull it from the local bitcoind so the capture has the full family.
          const nodeStructure = txStructure(txPkg.tx);
          const prevTxid = nodeStructure.inputs[0]?.txid;
          if (prevTxid) {
            const prev = await faucet.getRawTransaction(prevTxid);
            if (prev?.hex) {
              recordTx(prev.hex, ["static-deposit", `leaf:${leafPkg.leafId}`], true);
            }
          }
        } else {
          recordTx(txPkg.tx, [stepLabel, `leaf:${leafPkg.leafId}`], true);
        }
        recordTx(txPkg.signedChildTx, ["cpfp-bump-child", `leaf:${leafPkg.leafId}`], true);
      }
    }
    await faucet.mineBlocksAndWaitForMiningToComplete(1);

    step("sweep (construct only; 2048-block CSV not waited out)");
    const { stdout: sweepOut } = await runCli([
      "sweep",
      "--packages", packagesPath,
      "--seed-file", seedFile,
      "--network", "LOCAL",
      "--destination", destination,
      "--account-number", "1",
      "--fee-rate", "1",
    ]);
    const sweepResult = JSON.parse(sweepOut) as {
      sweeps: Array<{ sweepTx: string; sweepTxid: string }>;
    };
    for (const s of sweepResult.sweeps) {
      recordTx(s.sweepTx, ["sweep"], false);
    }

    capture.notes = {
      destination,
      requiredSats: requiredSats.toString(),
      leafId: leaf.id,
      refundCsvBlocks: 2048,
      cpfpAddress: cpfpInfo.cpfpAddress,
    };

    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, "exit-capture.json"),
      JSON.stringify(capture, null, 2),
    );
    for (const t of capture.txs) {
      await fs.writeFile(path.join(outDir, `${t.txid}.hex`), t.txHex);
    }
    step(`wrote ${capture.txs.length} txs to ${outDir}`);
    process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
  } finally {
    await wallet.cleanup?.();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`capture failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
