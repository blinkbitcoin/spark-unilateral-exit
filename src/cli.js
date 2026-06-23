#!/usr/bin/env node
import fs from "node:fs";

import { parseRecoveryBundle } from "./bundle.js";
import { loadSeed } from "./cli-input.js";
import { parseCpfpUtxo, serializeForJson } from "./cpfp.js";
import {
  assertSeedOnlyIsNotOfflineRecoverable,
  createRecoveryPlan,
} from "./planner.js";
import { exportRecoveryBundleFromSeed } from "./recovery-bundle.js";
import { constructSparkPackages } from "./spark-packages.js";
import { constructSweepTransactions } from "./sweep.js";

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || args.help) {
    printHelp();
    return;
  }

  if (command === "plan") {
    const bundle = loadOptionalBundle(args.bundle);
    assertSeedOnlyIsNotOfflineRecoverable({ seed: args.seed, bundle });
    if (!bundle) throw new Error("--bundle is required for offline recovery planning");
    const plan = createRecoveryPlan({
      bundle,
      destination: required(args.destination, "--destination"),
      feeRate: Number(required(args["fee-rate"], "--fee-rate")),
      cpfpUtxos: collect(args["cpfp-utxo"]),
    });
    console.log(serializeForJson(plan));
    return;
  }

  if (command === "package") {
    const bundle = loadOptionalBundle(args.bundle);
    assertSeedOnlyIsNotOfflineRecoverable({ seed: args.seed, bundle });
    if (!bundle) throw new Error("--bundle is required for offline package construction");
    const cpfpUtxos = collect(args["cpfp-utxo"]).map(parseCpfpUtxo);
    const packages = await constructSparkPackages({
      bundle,
      cpfpUtxos,
      feeRate: Number(required(args["fee-rate"], "--fee-rate")),
    });
    console.log(serializeForJson({ destination: args.destination, packages }));
    return;
  }

  if (command === "sweep") {
    const packages = JSON.parse(
      fs.readFileSync(required(args.packages, "--packages"), "utf8"),
    );
    const seed = await loadSeed(args);
    const sweeps = constructSweepTransactions({
      seed,
      passphrase: args.passphrase ?? "",
      network: required(args.network, "--network"),
      packages,
      destination: args.destination,
      feeRate: Number(required(args["fee-rate"], "--fee-rate")),
      accountNumber: args["account-number"],
    });
    console.log(serializeForJson(sweeps));
    return;
  }

  if (command === "refresh-bundle") {
    const seed = await loadSeed(args);
    if (args.out === true) throw new Error("--out requires a path");
    const bundle = await exportRecoveryBundleFromSeed({
      seed,
      accountNumber: args["account-number"] ?? 0,
      network: args.network ?? "MAINNET",
      operatorSet: args["operator-set"] ?? "spark-sdk",
      appVersion: args["app-version"] ?? "unknown",
    });
    const output = `${serializeForJson(bundle)}\n`;
    if (args.out) {
      fs.writeFileSync(args.out, output, { mode: 0o600 });
    } else {
      process.stdout.write(output);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
    } else if (args[key] === undefined) {
      args[key] = value;
      i += 1;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
      i += 1;
    } else {
      args[key] = [args[key], value];
      i += 1;
    }
  }
  return args;
}

function loadOptionalBundle(path) {
  if (!path) return null;
  return parseRecoveryBundle(fs.readFileSync(path, "utf8"));
}

function collect(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function required(value, name) {
  if (value === undefined || value === true || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function printHelp() {
  console.log(`spark-unilateral-exit

Commands:
  refresh-bundle  Query live Spark leaves from a seed and write a bundle
  plan            Validate a saved recovery bundle and print a recovery plan
  package         Construct Spark unilateral-exit packages using upstream Spark SDK
  sweep           Spend confirmed refund outputs to a destination address

Required for offline recovery:
  --bundle <path>          Saved Spark recovery bundle JSON
  --destination <address>  On-chain Bitcoin destination
  --fee-rate <number>     Fee rate in sat/vbyte
  --cpfp-utxo <utxo>      txid:vout:value:script:publicKey, repeatable

Inputs for refresh-bundle:
  --seed-file <path>       File containing Spark seed or mnemonic; prompts when omitted
  --seed <value>           Spark seed or mnemonic; prefer --seed-file
  --out <path>             Bundle output path; stdout when omitted
  --network <network>      MAINNET, REGTEST, TESTNET, SIGNET, or LOCAL
  --account-number <n>     Spark account number, default 0

Optional provenance metadata for refresh-bundle:
  --operator-set <label>   Operator-set label stored in the bundle
  --app-version <version>  App version label stored in the bundle

Inputs for sweep:
  --packages <path>         JSON produced by package
  --seed-file <path>        File containing Spark seed or mnemonic; prompts when omitted
  --network <network>       MAINNET, REGTEST, TESTNET, SIGNET, or LOCAL
  --destination <address>   Destination; defaults to package JSON destination
  --fee-rate <number>      Sweep fee rate in sat/vbyte
  --account-number <n>     Spark account number used by the wallet

Seed-only mode is intentionally rejected for offline recovery.
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
