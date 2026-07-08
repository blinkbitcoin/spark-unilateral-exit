#!/usr/bin/env node
import fs from "node:fs";

import { parseRecoveryBundle } from "./bundle.ts";
import {
  broadcastPackages,
  broadcastSweeps,
  checkTransactionStatus,
} from "./broadcast.ts";
import { loadSeed } from "./cli-input.ts";
import { parseCpfpUtxo, serializeForJson } from "./cpfp.ts";
import {
  assertSeedOnlyIsNotOfflineRecoverable,
  createRecoveryPlan,
} from "./planner.ts";
import { exportRecoveryBundleFromSeed } from "./recovery-bundle.ts";
import { signPackages } from "./sign.ts";
import { constructSparkPackages } from "./spark-packages.ts";
import {
  deriveCpfpFundingKey,
  estimateCpfpFunding,
  watchCpfpFunding,
} from "./cpfp-funding.ts";
import { constructSweepTransactions } from "./sweep.ts";
import type { CliArgs, CliArgValue, RecoveryBundle } from "./types.ts";

// The Spark SDK emits diagnostic logs through the global console.log, which
// writes to stdout. This CLI's contract is that stdout carries only the
// machine-readable JSON result, so redirect all incidental console.log output
// to stderr and emit results explicitly via emitJson/process.stdout.
console.log = (...args: unknown[]) => console.error(...args);

function emitJson(value: unknown): void {
  process.stdout.write(`${serializeForJson(value)}\n`);
}

async function main(): Promise<void> {
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
    emitJson(plan);
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
    emitJson({ destination: args.destination, packages });
    return;
  }

  if (command === "broadcast") {
    const input = JSON.parse(
      fs.readFileSync(required(args.packages, "--packages"), "utf8"),
    );
    const network = required(args.network, "--network");
    const results = await broadcastPackages({
      packages: input.packages ?? input,
      network,
      esploraUrl: optionalValue(args["esplora-url"]),
      onPackageSubmitted(entry) {
        console.error(
          `Submitted leaf ${entry.leafId} package ${entry.packageIndex}`,
        );
      },
    });
    emitJson(results);
    return;
  }

  if (command === "broadcast-sweep") {
    const input = JSON.parse(
      fs.readFileSync(required(args.sweeps, "--sweeps"), "utf8"),
    );
    const network = required(args.network, "--network");
    const results = await broadcastSweeps({
      sweeps: input.sweeps ?? input,
      network,
      esploraUrl: optionalValue(args["esplora-url"]),
    });
    emitJson(results);
    return;
  }

  if (command === "tx-status") {
    const txid = required(args.txid, "--txid");
    const network = required(args.network, "--network");
    const status = await checkTransactionStatus({
      txid,
      network,
      esploraUrl: optionalValue(args["esplora-url"]),
    });
    emitJson(status);
    return;
  }

  if (command === "cpfp-address") {
    const bundle = loadOptionalBundle(args.bundle);
    if (!bundle) throw new Error("--bundle is required to estimate CPFP funding");
    const seed = await loadSeed(args);
    const network = optionalValue(args.network) ?? bundle.network;
    const feeRate = Number(required(args["fee-rate"], "--fee-rate"));
    const key = deriveCpfpFundingKey({
      seed,
      network,
      accountNumber: args["account-number"],
    });
    const estimate = await estimateCpfpFunding({
      bundle,
      feeRate,
      fundingScript: key.script,
      fundingPublicKey: key.publicKey,
      bufferSats: optionalValue(args["buffer-sats"]),
    });
    emitJson({
      network,
      cpfpAddress: key.address,
      script: key.script,
      publicKey: key.publicKey,
      derivationPath: key.derivationPath,
      purposeXpub: key.purposeXpub,
      watchDescriptor: key.watchDescriptor,
      ...estimate,
    });
    return;
  }

  if (command === "watch-cpfp") {
    const network = required(args.network, "--network");
    let address = optionalValue(args.address);
    let script = optionalValue(args.script);
    let publicKey = optionalValue(args["public-key"]);
    let minSats = optionalValue(args["min-sats"]);

    // Derive the funding address/script/pubkey from the seed only when they
    // are not all supplied explicitly, so callers who pass them keep the seed
    // away from this step.
    if (!address || !script || !publicKey) {
      const seed = await loadSeed(args);
      const key = deriveCpfpFundingKey({
        seed,
        network,
        accountNumber: args["account-number"],
      });
      address = address ?? key.address;
      script = script ?? key.script;
      publicKey = publicKey ?? key.publicKey;
    }

    // Without a floor the watcher would match the first dust UTXO it sees and
    // the recovery would proceed with insufficient fees, so demand one.
    if (minSats === undefined) {
      const bundle = loadOptionalBundle(optionalValue(args.bundle));
      if (!bundle) {
        throw new Error(
          "--min-sats or --bundle (with --fee-rate) is required so watch-cpfp does not accept an underfunded UTXO",
        );
      }
      const estimate = await estimateCpfpFunding({
        bundle,
        feeRate: Number(required(args["fee-rate"], "--fee-rate")),
        fundingScript: script!,
        fundingPublicKey: publicKey!,
        bufferSats: optionalValue(args["buffer-sats"]),
      });
      minSats = estimate.requiredSats;
    }

    const minConfirmations = optionalNumber(
      args["min-confirmations"],
      1,
      "--min-confirmations",
    );
    // Announce each incoming UTXO once so the operator knows their funding tx
    // was seen (or is underfunded) instead of watching a bare attempt counter.
    const announced = new Set<string>();
    const utxo = await watchCpfpFunding({
      address,
      script,
      publicKey,
      network,
      esploraUrl: optionalValue(args["esplora-url"]),
      minSats,
      minConfirmations,
      pollIntervalMs: optionalSeconds(args["poll-interval"], "--poll-interval"),
      timeoutMs: optionalSeconds(args.timeout, "--timeout"),
      onPoll: ({ attempt, utxos }) => {
        for (const seen of utxos ?? []) {
          const key = `${seen.txid}:${seen.vout}`;
          if (announced.has(key)) continue;
          announced.add(key);
          const value = BigInt(seen.value ?? 0);
          const confirmed = Boolean(seen.status?.confirmed);
          if (value < BigInt(minSats!)) {
            console.error(
              `Seen ${confirmed ? "confirmed" : "unconfirmed"} UTXO ${key} at ${address}, but ${value} sats is below the required ${minSats} sats; send the difference as a new transaction`,
            );
          } else if (!confirmed) {
            console.error(
              `Seen unconfirmed funding tx ${seen.txid} (${value} sats) at ${address}; waiting for ${minConfirmations} confirmation(s)`,
            );
          }
        }
        console.error(`Waiting for CPFP funding at ${address} (attempt ${attempt})`);
      },
    });
    emitJson({
      ...utxo,
      cpfpUtxo: `${utxo.txid}:${utxo.vout}:${utxo.value}:${utxo.script}:${utxo.publicKey}`,
    });
    return;
  }

  if (command === "sign-packages") {
    const input = JSON.parse(
      fs.readFileSync(required(args.packages, "--packages"), "utf8"),
    );
    const privateKey = await resolveCpfpPrivateKey(args);
    const packages = input.packages ?? input;
    const signed = signPackages({ packages, privateKey });
    const output = serializeForJson({ ...input, packages: signed });
    if (args.out === true) throw new Error("--out requires a path");
    const outPath = optionalValue(args.out);
    if (outPath) {
      fs.writeFileSync(outPath, `${output}\n`, { mode: 0o600 });
    } else {
      process.stdout.write(`${output}\n`);
    }
    return;
  }

  if (command === "sweep") {
    const packages = JSON.parse(
      fs.readFileSync(required(args.packages, "--packages"), "utf8"),
    );
    const seed = await loadSeed(args);
    const sweeps = constructSweepTransactions({
      seed,
      passphrase: optionalValue(args.passphrase) ?? "",
      network: required(args.network, "--network"),
      packages,
      destination: optionalValue(args.destination),
      feeRate: Number(required(args["fee-rate"], "--fee-rate")),
      accountNumber: args["account-number"],
    });
    emitJson(sweeps);
    return;
  }

  if (command === "refresh-bundle") {
    const seed = await loadSeed(args);
    if (args.out === true) throw new Error("--out requires a path");
    const bundle = await exportRecoveryBundleFromSeed({
      seed,
      accountNumber: args["account-number"] ?? 0,
      network: optionalValue(args.network) ?? "MAINNET",
      operatorSet: optionalValue(args["operator-set"]) ?? "spark-sdk",
      appVersion: optionalValue(args["app-version"]) ?? "unknown",
    });
    const output = `${serializeForJson(bundle)}\n`;
    const outPath = optionalValue(args.out);
    if (outPath) {
      fs.writeFileSync(outPath, output, { mode: 0o600 });
    } else {
      process.stdout.write(output);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    const existing = args[key];
    if (!value || value.startsWith("--")) {
      args[key] = true;
    } else if (existing === undefined) {
      args[key] = value;
      i += 1;
    } else if (Array.isArray(existing)) {
      existing.push(value);
      i += 1;
    } else {
      // `existing` is a scalar: a string, or `true` from an earlier bare flag.
      args[key] = [String(existing), value];
      i += 1;
    }
  }
  return args;
}

function loadOptionalBundle(path: CliArgValue): RecoveryBundle | null {
  const resolved = optionalValue(path);
  if (!resolved) return null;
  return parseRecoveryBundle(fs.readFileSync(resolved, "utf8"));
}

function collect(value: CliArgValue): string[] {
  if (Array.isArray(value)) return value;
  const single = optionalValue(value);
  return single === undefined ? [] : [single];
}

function required(value: CliArgValue, name: string): string {
  const raw = optionalValue(value);
  if (raw === undefined || raw === "") {
    throw new Error(`${name} is required`);
  }
  return raw;
}

// A flag passed without a value parses to `true` and a repeated flag parses to
// a string[]; neither is a usable scalar, so treat both as absent. This is the
// single narrowing point from CliArgValue to string — read scalar args through
// it (or required()) instead of casting at each use site.
function optionalValue(value: CliArgValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(
  value: CliArgValue,
  fallback: number | undefined,
  name: string,
): number | undefined {
  const raw = optionalValue(value);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function optionalSeconds(value: CliArgValue, name: string): number | undefined {
  const seconds = optionalNumber(value, undefined, name);
  return seconds === undefined ? undefined : seconds * 1000;
}

async function resolveCpfpPrivateKey(args: CliArgs): Promise<string> {
  const keyFile = optionalValue(args["key-file"]);
  const keyArg = optionalValue(args["private-key"]);
  if (keyFile) return fs.readFileSync(keyFile, "utf8").trim();
  if (keyArg) return keyArg;
  if (optionalValue(args["seed-file"]) || optionalValue(args.seed) || process.env.SPARK_SEED) {
    const seed = await loadSeed(args);
    const key = deriveCpfpFundingKey({
      seed,
      network: required(args.network, "--network"),
      accountNumber: args["account-number"],
    });
    return key.privateKeyHex;
  }
  throw new Error("--key-file, --private-key, or --seed-file/--seed is required");
}

function printHelp(): void {
  process.stdout.write(`spark-unilateral-exit

Commands:
  refresh-bundle   Query live Spark leaves from a seed and write a bundle
  plan             Validate a saved recovery bundle and print a recovery plan
  cpfp-address     Derive a CPFP funding address from the seed and estimate the sats to send it
  watch-cpfp       Watch the CPFP funding address for an incoming UTXO and emit it as --cpfp-utxo
  package          Construct Spark unilateral-exit packages using upstream Spark SDK
  broadcast        Submit signed packages via Esplora (replaces bitcoin-cli submitpackage)
  broadcast-sweep  Broadcast signed sweep transactions via Esplora
  tx-status        Check confirmation status of a transaction via Esplora
  sign-packages    Sign all CPFP PSBTs in a package JSON (CPFP key from seed, key-file, or hex)
  sweep            Spend confirmed refund outputs to a destination address

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

Inputs for cpfp-address:
  --bundle <path>          Saved Spark recovery bundle JSON
  --seed-file <path>       File containing Spark seed or mnemonic; prompts when omitted
  --fee-rate <number>      Fee rate in sat/vbyte used to size the fee bumps
  --network <network>      Defaults to the bundle network
  --account-number <n>     Account number for the funding key derivation, default 0
  --buffer-sats <n>        Extra sats added on top of the estimated fees, default 1000
  Outputs the funding address, script/publicKey, and requiredSats to fund it.

Inputs for watch-cpfp:
  --network <network>      MAINNET, REGTEST, TESTNET, SIGNET, or LOCAL
  --seed-file <path>       Seed used to derive the funding address (or pass --address/--script/--public-key)
  --bundle <path>          Bundle used to compute --min-sats; one of --min-sats or --bundle is required
  --fee-rate <number>      Fee rate for the min-sats estimate (with --bundle)
  --min-sats <n>           Minimum UTXO value to accept
  --min-confirmations <n>  Confirmations required before use, default 1 (0 accepts mempool)
  --poll-interval <sec>    Seconds between polls, default 5
  --timeout <sec>          Give up after this many seconds (default: wait forever)
  --esplora-url <url>      Custom Esplora API base URL (optional)
  Emits the funded UTXO and a cpfpUtxo string to pass to package --cpfp-utxo.

Inputs for broadcast:
  --packages <path>        JSON produced by package, with signedChildTx added
  --network <network>      MAINNET, TESTNET, or SIGNET
  --esplora-url <url>      Custom Esplora API base URL (optional)

Inputs for broadcast-sweep:
  --sweeps <path>          JSON produced by sweep
  --network <network>      MAINNET, TESTNET, or SIGNET
  --esplora-url <url>      Custom Esplora API base URL (optional)

Inputs for tx-status:
  --txid <txid>            Transaction ID to check
  --network <network>      MAINNET, TESTNET, or SIGNET
  --esplora-url <url>      Custom Esplora API base URL (optional)

Inputs for sign-packages:
  --packages <path>        JSON produced by package
  --seed-file <path>       Seed to derive the CPFP funding key (needs --network)
  --key-file <path>        File containing CPFP private key hex (alternative to --seed-file)
  --private-key <hex>      CPFP private key as 32-byte hex (alternative to --seed-file)
  --network <network>      Required with --seed-file to derive the funding key
  --account-number <n>     Account number for the funding key derivation, default 0
  --out <path>             Output path for signed packages; stdout when omitted

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
  console.error((error as Error).message);
  process.exitCode = 1;
});
