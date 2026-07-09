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
import { consolidateLeavesFromSeed } from "./consolidate.ts";
import { exportRecoveryBundleFromSeed } from "./recovery-bundle.ts";
import { signPackages } from "./sign.ts";
import { constructSparkPackages } from "./spark-packages.ts";
import { autoExit } from "./auto-exit.ts";
import {
  createFundingWatchLogger,
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
      minNetSats: optionalValue(args["min-net-sats"]),
      includeUneconomical: args["include-uneconomical"] === true,
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
      onPoll: createFundingWatchLogger({
        address: address!,
        minSats: minSats!,
        minConfirmations,
        log: (message) => console.error(message),
      }),
    });
    emitJson({
      ...utxo,
      cpfpUtxo: `${utxo.txid}:${utxo.vout}:${utxo.value}:${utxo.script}:${utxo.publicKey}`,
    });
    return;
  }

  if (command === "auto-exit") {
    const bundle = loadOptionalBundle(args.bundle);
    if (!bundle) throw new Error("--bundle is required for auto-exit");
    const seed = await loadSeed(args);
    const network = optionalValue(args.network) ?? bundle.network;
    const result = await autoExit({
      bundle,
      seed,
      network,
      feeRate: Number(required(args["fee-rate"], "--fee-rate")),
      esploraUrl: optionalValue(args["esplora-url"]),
      accountNumber: args["account-number"],
      minNetSats: optionalValue(args["min-net-sats"]),
      includeUneconomical: args["include-uneconomical"] === true,
      fanOut: args["fan-out"] === true,
      bufferSats: optionalValue(args["buffer-sats"]),
      pollIntervalMs: optionalSeconds(args["poll-interval"], "--poll-interval"),
      onEvent: (message) => console.error(message),
    });
    if (args.out === true) throw new Error("--out requires a path");
    const outPath = optionalValue(args.out);
    if (outPath) {
      // Sweep-compatible packages file: `sweep` reads the last tx per leaf as
      // the refund transaction.
      fs.writeFileSync(
        outPath,
        `${serializeForJson({ packages: result.packages })}\n`,
        { mode: 0o600 },
      );
      console.error(`Wrote refund packages for sweep to ${outPath}`);
    }
    emitJson(result);
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
      accountNumber: args["account-number"],
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

  if (command === "consolidate") {
    const seed = await loadSeed(args);
    const result = await consolidateLeavesFromSeed({
      seed,
      accountNumber: args["account-number"],
      network: optionalValue(args.network) ?? "MAINNET",
      multiplicity: optionalNumber(args.multiplicity, 0, "--multiplicity"),
      dryRun: args["dry-run"] === true,
      maxRounds: optionalNumber(args["max-rounds"], undefined, "--max-rounds"),
      onEvent: (message) => console.error(message),
    });
    emitJson(result);
    if (result.bundleRefreshRequired) {
      console.error(
        "Leaves changed: the saved recovery bundle is now stale. Run refresh-bundle " +
          "(make refresh-recovery-bundle) before relying on unilateral exit.",
      );
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
  if (keyArg) {
    console.error(
      "Warning: --private-key exposes the key in the process list and shell history; prefer --key-file or --seed-file",
    );
    return keyArg;
  }
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
  consolidate      Swap small leaves with the SSP into the fewest denominations so
                   fewer leaves are uneconomical to exit (refresh the bundle after)
  plan             Validate a saved recovery bundle and print a recovery plan
  cpfp-address     Derive a CPFP funding address from the seed and estimate the sats to send it
  watch-cpfp       Watch the CPFP funding address for an incoming UTXO and emit it as --cpfp-utxo
  auto-exit        Run the whole exit automatically: wait for funding, then package, sign,
                   submit, and wait for confirmations round by round until only timelocked
                   refunds remain; uneconomical leaves are skipped by default
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
  --account-number <n>     Spark account number; defaults to the SDK default for the
                           network (0 on regtest, 1 elsewhere)

Optional provenance metadata for refresh-bundle:
  --operator-set <label>   Operator-set label stored in the bundle
  --app-version <version>  App version label stored in the bundle

Inputs for consolidate:
  --seed-file <path>       File containing Spark seed or mnemonic; prompts when omitted
  --network <network>      MAINNET, REGTEST, TESTNET, SIGNET, or LOCAL (default MAINNET)
  --account-number <n>     Spark account number; defaults to the SDK default for the
                           network (0 on regtest, 1 elsewhere)
  --multiplicity <n>       0 (default) targets the fewest leaves - best for unilateral
                           exit; 1-5 keeps extra denominations for cheaper transfers
  --dry-run                Report the planned consolidation without swapping
  --max-rounds <n>         Optimization passes to drive before giving up, default 5
  Consolidation swaps leaves with the SSP (a cooperative operation, not an exit).
  It spends the current leaves, so refresh the recovery bundle afterwards.

Inputs for cpfp-address:
  --bundle <path>          Saved Spark recovery bundle JSON
  --seed-file <path>       File containing Spark seed or mnemonic; prompts when omitted
  --fee-rate <number>      Fee rate in sat/vbyte used to size the fee bumps
  --network <network>      Defaults to the bundle network
  --account-number <n>     Account number for the funding key derivation, default 0
  --buffer-sats <n>        Extra sats added on top of the estimated fees, default 1000
  --min-net-sats <n>       Extra sats a leaf must net to count as economical, default 0
  --include-uneconomical   Count uneconomical leaves in requiredSats too
  Outputs the funding address, script/publicKey, per-leaf economics, and requiredSats.

Inputs for auto-exit:
  --bundle <path>          Saved Spark recovery bundle JSON
  --seed-file <path>       Seed for the funding key (derivation, signing) and address watch
  --fee-rate <number>      Fee rate in sat/vbyte
  --network <network>      Defaults to the bundle network
  --account-number <n>     Account number for the funding key derivation, default 0
  --min-net-sats <n>       Extra sats a leaf must net to count as economical, default 0
  --include-uneconomical   Also exit leaves whose value does not cover their fees
  --fan-out                Split funding into one UTXO per leaf so leaves broadcast in
                           parallel; default is sequential over a single funding chain
  --buffer-sats <n>        Funding buffer, default 1000
  --poll-interval <sec>    Seconds between confirmation polls, default 30
  --esplora-url <url>      Custom Esplora API base URL (optional)
  --out <path>             Write sweep-compatible refund packages JSON here
  Runs until every economical leaf is broadcast or waiting on its refund timelock;
  safe to interrupt and re-run at any point (it resumes from chain state).

Inputs for watch-cpfp:
  --network <network>      MAINNET, REGTEST, TESTNET, SIGNET, or LOCAL
  --seed-file <path>       Seed used to derive the funding address (or pass --address/--script/--public-key)
  --bundle <path>          Bundle used to compute --min-sats; one of --min-sats or --bundle is required
  --fee-rate <number>      Fee rate for the min-sats estimate (with --bundle)
  --min-sats <n>           Minimum UTXO value to accept
  --min-confirmations <n>  Confirmations required before use, default 1 (0 accepts mempool)
  --poll-interval <sec>    Seconds between polls, default 30
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
