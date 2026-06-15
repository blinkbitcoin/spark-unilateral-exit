# Guide: withdraw Spark funds unilaterally

## Goal

Recover a user's Spark balance when Spark operators are unavailable by using state saved before the outage.

The user-facing target can be simple:

1. Provide the Spark wallet seed or backup phrase.
2. Provide the latest encrypted Spark recovery bundle.
3. Provide an on-chain Bitcoin destination address.
4. Provide or fund L1 Bitcoin UTXOs for CPFP fee bumping.
5. Broadcast the unilateral-exit packages and sweep recoverable funds to the destination.

## Important constraint

A Spark seed alone is not enough for offline recovery.

The seed can derive user keys, but the current Spark leaves are normally discovered from Spark operators. If operators are already down and the app did not save the current leaves and ancestor chain, the recovery tool cannot know what to exit.

For this reason, Blink mobile should save an encrypted recovery bundle while Spark operators are online.

## Recovery bundle contents

The bundle should contain:

- Spark network and operator-set metadata.
- Bundle schema version and creation timestamp.
- Wallet identity/verifying metadata needed to confirm the bundle belongs to the seed.
- Current owned leaf `TreeNode` protobuf hex strings.
- Full ancestor chain for each recoverable leaf up to the root.
- Raw node and refund transactions embedded in those `TreeNode`s.
- Balance metadata as seen when the bundle was saved.
- Asset metadata for Bitcoin and USDB/Dollar balance state.

The bundle is sensitive even without private keys because it reveals wallet graph metadata. Mobile must encrypt it client-side before writing it to Files, Google Drive, iCloud, or any backend storage.

## High-level CLI flow

1. Decrypt and validate the bundle.
2. Verify the bundle matches the restored seed-derived wallet identity.
3. Validate the destination address for the configured Bitcoin network.
4. Collect CPFP fee UTXOs.
5. Construct unilateral-exit packages from saved `TreeNode` data.
6. Broadcast parent transactions and signed CPFP children in root-to-leaf order.
7. Wait for required confirmations/timelocks.
8. Sweep final spendable outputs to the user's destination address.

## Current prototype command

Dry run:

```sh
node src/cli.js plan \
  --bundle examples/recovery-bundle.example.json \
  --destination <bitcoin-address> \
  --fee-rate 10 \
  --cpfp-utxo <txid:vout:value:script:pubkey>
```

Package construction:

```sh
node src/cli.js package \
  --bundle examples/recovery-bundle.example.json \
  --destination <bitcoin-address> \
  --fee-rate 10 \
  --cpfp-utxo <txid:vout:value:script:pubkey>
```

## Seed-only mode

Seed-only mode can work only while Spark operators are online, because the tool can initialize a wallet and query live leaves. That is useful for generating a fresh bundle or rehearsing recovery.

If Spark operators are offline, seed-only mode must fail closed with a clear error:

> Seed-only recovery cannot discover Spark leaves while operators are offline. Provide the latest saved recovery bundle.

## USDB / Dollar balance

The Bitcoin unilateral-exit path recovers Bitcoin leaves. USDB/Dollar balance support needs explicit validation before being presented as recoverable by the same command.

Open questions:

- Is USDB represented as Spark token outputs, a stable-balance abstraction, or another asset layer in the target integration?
- Can the asset state be exited unilaterally to Bitcoin, or must the user first convert/withdraw while Spark services are online?
- What bundle data is required to prove, reconstruct, and redeem USDB/Dollar state without operators?
- Does recovery preserve USD denomination, or only recover underlying Bitcoin collateral after a protocol-specific path?

Until those questions are answered, the CLI must show USDB/Dollar balance as "detected but not covered by Bitcoin unilateral exit" unless the bundle contains a supported asset recovery plan.

## Spark test network and faucet

Upstream Spark has local/integration unilateral-exit tests and Spark CLI support. The next step is to wire this repo to Spark's local test environment or public test network if one is available.

Target end-to-end test:

1. Create a Spark wallet on test/local network.
2. Fund it through a test faucet.
3. Save a recovery bundle with leaves and ancestors.
4. Simulate operator unavailability by using only the bundle.
5. Construct and broadcast unilateral-exit packages.
6. Confirm timelocks.
7. Sweep recovered funds to a destination address.

This is now represented by the `Spark Local E2E` GitHub Actions workflow and the `test/e2e/local-spark-unilateral-exit.test.js` test. The workflow is intentionally separate from normal CI because it needs Docker and builds/runs the upstream Spark local stack.
