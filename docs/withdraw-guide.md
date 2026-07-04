# Guide: withdraw Spark funds unilaterally

## Goal

Recover a user's Spark balance when Spark operators are unavailable by using state saved before the outage.

For an operator checklist from seed and bundle through package broadcast and destination sweep, see [recovery-runbook.md](recovery-runbook.md).

The user-facing target can be simple:

1. Provide the Spark wallet seed or backup phrase.
2. Provide the latest encrypted Spark recovery bundle.
3. Provide an on-chain Bitcoin destination address.
4. Provide or fund L1 Bitcoin UTXOs for CPFP fee bumping.
5. Broadcast the unilateral-exit packages and sweep recoverable funds to the destination.

## Important constraint

A Spark seed alone is not enough for offline recovery.

The seed can derive user keys, but the current Spark leaves are normally discovered from Spark operators. If operators are already down and the app did not save the current leaves and ancestor chain, the recovery tool cannot know what to exit.

For this reason, a Spark wallet should save an encrypted recovery bundle while Spark operators are online.

## Minimum practical balance

The current CLI does not enforce a minimum recoverable Bitcoin balance. It validates that the bundle has at least one leaf, that the fee rate is positive, and that at least one CPFP UTXO is provided. It does not yet estimate package vsize, subtract L1 fees, or reject economically uneconomic recoveries.

### How Spark's published fees relate to this

Spark's [published fee schedule](https://docs.spark.money/learn/faq#what-are-the-fees-on-spark) lists a **cooperative** "Exit to L1" fee of `250 × sats_per_vbyte + 750` (about 1,000 sats at 1 sat/vbyte, 2,000 sats at 5 sat/vbyte). That fee is flat and does not scale with the amount withdrawn, so for small balances it is already a large percentage. Crucially, it applies only while Spark operators are online and process the exit for the user: it prices a single ~250-vbyte on-chain transaction plus a 750-sat service fee.

Unilateral exit — the path this tool implements — is the fallback when operators are unavailable, and it is materially more expensive than the cooperative fee. Instead of one operator-assisted transaction, the user broadcasts the full exit tree themselves: each node transaction in the leaf's ancestor chain, the refund transaction, a CPFP fee-bump child for each of those, and a final sweep. The practical floors below (~10,000 sats for one leaf at 1 sat/vbyte) are therefore roughly an order of magnitude above Spark's flat cooperative exit fee, and the "flat fee is a higher percentage for small balances" caveat applies even more strongly here.

The takeaway for planning: Spark's `250 × sats_per_vbyte + 750` is the best-case exit cost while operators are online; treat the floors in this section as the worst-case cost of exiting without them. If a balance is uneconomic to exit cooperatively, it is uneconomic to recover unilaterally.

Use this conservative planning floor until package and sweep sizing are measured from production-like Spark packages:

| Scenario | Practical floor at 1 sat/vbyte | Notes |
| --- | ---: | --- |
| 1 Bitcoin leaf | ~10,000 sats | Covers a simple unilateral-exit package, CPFP fee bump, final sweep fee, dust, and margin. |
| 2 Bitcoin leaves | ~20,000 sats total | Assumes roughly one package path per leaf; use a higher floor if the leaves have different ancestor chains. |

These are not protocol limits. They are operator guidance for whether recovery is worth attempting at low fee rates. The real threshold is:

```text
recoverable leaf sats > unilateral-exit package fees + CPFP fees + final sweep fee + dust threshold
```

At fee rates above 1 sat/vbyte, scale the practical floor roughly linearly with the fee rate until the tool has explicit fee estimation. For example, use about 50,000 sats for one leaf and 100,000 sats total for two leaves at 5 sat/vbyte. If the CPFP UTXO is external funding, the user still needs that UTXO available even when the recovered leaf balance is above the floor.

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

## Keeping the bundle fresh

Refresh the bundle while Spark operators are online, after wallet startup and after any event that can change leaves: deposit claim, incoming Spark transfer, outgoing Spark transfer, swap, receive, optimization, or token/output sync.

```sh
node src/cli.js refresh-bundle \
  --seed-file ../.spark-seed.txt \
  --network MAINNET \
  --out ../recovery-bundle.json \
  --operator-set spark-mainnet \
  --app-version example-app
```

Operational notes:

- Prefer `--seed-file` or `SPARK_SEED`; avoid passing real seeds via `--seed` in shared shells.
- `--operator-set` and `--app-version` are optional provenance metadata stored in the bundle.
- The command initializes the Spark wallet from the seed, forces a wallet sync when the SDK exposes that API, queries `getLeaves()`, serializes each `TreeNode`, and writes a bundle matching this repo's recovery schema.
- The command fails if no leaves are present. An empty bundle cannot recover funds offline.
- Mobile should encrypt the bundle before uploading it to Google Drive, iCloud, or a local user-selected file location.
- Refresh cadence should be event-driven plus periodic. Event-driven refresh captures state changes immediately; a periodic refresh handles missed app lifecycle events.

### Rust SDK exporter

Some Spark wallet implementations do not expose leaves through the upstream `@buildonspark/spark-sdk` wallet API. For those wallets, use the standalone Rust exporter instead of modifying an SDK:

```sh
npm run refresh-recovery-bundle -- \
  --seed-file ../.spark-seed.txt \
  --network mainnet \
  --out ../recovery-bundle.json \
  --account-number 1 \
  --operator-set spark-mainnet \
  --app-version example-app
```

The exporter lives in `tools/spark-recovery-bundle`, builds against the repo-local Rust SDK snapshot under `vendor/breez-spark-sdk`, and is run through the repo Nix flake. It authenticates to Spark operators from the seed, queries available leaves with `include_parents=true`, stores leaf `treeNodeHex` values plus bundled ancestor nodes, and writes the same `spark.unilateral-exit-bundle.v1` JSON schema. The recovery package builder can then satisfy parent lookups from the bundle while offline.

`--account-number`, `--operator-set`, and `--app-version` are optional. Use `--account-number` when the wallet used a non-default Spark account number; otherwise the exporter uses the vendored SDK default for the selected network.

### Make targets

The repo root `Makefile` wraps the common commands:

```sh
make refresh-recovery-bundle \
  SEED_FILE=../.spark-seed.txt \
  BUNDLE=../recovery-bundle.json \
  NETWORK=mainnet \
  ACCOUNT_NUMBER=1
```

```sh
make plan \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  CPFP_UTXO=<txid:vout:value:script:pubkey>
```

```sh
make package \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  CPFP_UTXO=<txid:vout:value:script:pubkey>
```

```sh
make sweep \
  PACKAGES=recovery-packages.json \
  SEED_FILE=../.spark-seed.txt \
  NETWORK=mainnet \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  ACCOUNT_NUMBER=1
```

For multiple fee inputs, pass repeated flags through `CPFP_ARGS`:

```sh
make package \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  CPFP_ARGS='--cpfp-utxo <utxo1> --cpfp-utxo <utxo2>'
```

## CPFP UTXO input

The CPFP UTXO is not a Spark leaf and it is not a Lightning payment. It is an external L1 Bitcoin output that funds the child transaction used to fee-bump the unilateral-exit package. The recovery operator must be able to sign for this output.

Provide it in this format:

```text
txid:vout:value:script:publicKey
```

Field meanings:

- `txid`: transaction id containing the output, as 32-byte hex.
- `vout`: output index in that transaction.
- `value`: output value in sats.
- `script`: output scriptPubKey hex.
- `publicKey`: public key for the signer that controls the output.

The UTXO must be unspent, confirmed or otherwise acceptable to the target mempool policy, on the same Bitcoin network as the recovery bundle, and large enough to pay the requested fee bump without becoming dust. Do not use a Spark deposit or Lightning invoice as this value; use a normal Bitcoin wallet UTXO whose private key or signing device is available during recovery.

### Export from Bitcoin Core

Bitcoin Core is the cleanest source when the fee wallet is loaded locally. The first four fields usually come from `listunspent`:

```sh
bitcoin-cli -rpcwallet=<fee-wallet> listunspent 1 9999999
```

```json
{
  "txid": "9f...32-byte-hex...",
  "vout": 0,
  "amount": 0.00050000,
  "scriptPubKey": "0014..."
}
```

Convert `amount` to sats, then get the public key for the output address:

```sh
bitcoin-cli -rpcwallet=<fee-wallet> getaddressinfo "<address-from-listunspent>"
```

For example, `0.00050000 BTC` becomes `50000`, so the CLI argument shape is:

```text
9f...:0:50000:0014...:02...
```

Use only outputs where `spendable` is true and `safe` is true unless you have reviewed the policy tradeoff. For descriptor wallets, `getaddressinfo` may show descriptor data instead of a direct `pubkey`; derive or inspect the concrete child public key for the selected address before building the CPFP input.

### Export from Electrum

Electrum can provide the UTXO and public key from the wallet, but the output script is often easiest to read from the funding transaction:

```sh
electrum listunspent
electrum getpubkeys <address>
```

Use the selected UTXO's `prevout_hash` or `tx_hash` as `txid`, its `prevout_n` as `vout`, and convert the value to sats if Electrum reports it in BTC. Then fetch the exact output script from an Esplora-compatible API or your own node:

```sh
curl -s https://mempool.space/api/tx/<txid> \
  | jq -r '.vout[<vout>] | "\(.value):\(.scriptpubkey)"'
```

The returned `value` is sats and `scriptpubkey` is the `script` field for the CPFP input. Append one public key returned by `electrum getpubkeys <address>` for a single-key output. Do not use this current CPFP input format for multisig unless the recovery tool explicitly supports signing that script type.

### Export from Sparrow

Sparrow is useful for coin selection and PSBT signing. In the `UTXOs` view, choose a confirmed spendable output and record:

- outpoint as `txid:vout`;
- value in sats;
- receive or change address for that coin.

Get the `script` from the funding transaction details in Sparrow, or from an Esplora-compatible API:

```sh
curl -s https://mempool.space/api/tx/<txid> \
  | jq -r '.vout[<vout>] | "\(.value):\(.scriptpubkey)"'
```

For `publicKey`, use Sparrow's address or key details for the selected receive/change address. If Sparrow only shows the derivation path and xpub, derive the concrete child public key for that path or use another wallet/node to inspect it. After the package command emits the CPFP PSBT, Sparrow can sign it as long as the selected UTXO belongs to that Sparrow wallet or connected signer.

## High-level CLI flow

1. Decrypt and validate the bundle.
2. Verify the bundle matches the restored seed-derived wallet identity.
3. Validate the destination address for the configured Bitcoin network.
4. Collect CPFP fee UTXOs.
5. Construct unilateral-exit packages from saved `TreeNode` data.
6. Broadcast parent transactions and signed CPFP children in root-to-leaf order.
7. Wait for required confirmations/timelocks.
8. Construct, broadcast, and confirm sweep transactions to the user's destination address.

## Current prototype commands

Bundle refresh:

```sh
node src/cli.js refresh-bundle \
  --seed-file <spark-seed-file> \
  --network MAINNET \
  --out recovery-bundle.json
```

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

Sweep construction after refund transactions are confirmed and spendable:

```sh
node src/cli.js sweep \
  --packages recovery-packages.json \
  --seed-file <spark-seed-file> \
  --network MAINNET \
  --destination <bitcoin-address> \
  --fee-rate 10 \
  --account-number <spark-account-number>
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

Upstream Spark has local/integration unilateral-exit tests and Spark CLI support.

The current local end-to-end test:

1. Create a Spark wallet on test/local network.
2. Fund it through a test faucet.
3. Export the funded wallet's live leaves into a recovery bundle.
4. Construct and broadcast unilateral-exit packages from the saved bundle.
5. Confirm the package reaches local bitcoind policy through `submitpackage`.
6. Construct, broadcast, and confirm the final sweep to a fresh destination address.

This is now represented by the `Spark Local E2E` GitHub Actions workflow and the `test/e2e/local-spark-unilateral-exit.test.js` test. The workflow is intentionally separate from normal CI because it needs Docker and builds/runs the upstream Spark local stack.

Expect a long wait between package phases. Spark refund transactions use a
block-based CSV relative timelock. Fresh leaves currently use 2,000 blocks on
the CPFP refund path, which is about 13.9 days at Bitcoin's 10-minute target
block interval. Renewed leaves can be shorter in 100-block steps, so operators
should decode the generated refund transaction input sequence for exact timing.
The local E2E mines 2,050 regtest blocks as a buffer before the next phase.
