# Spark recovery runbook

This runbook covers the operator workflow from a Spark seed and saved recovery
bundle to Bitcoin transactions on chain.

Current status: this repo can refresh a recovery bundle, plan a recovery,
construct Spark unilateral-exit packages, produce CPFP PSBTs, and construct
signed sweep transactions from confirmed refund outputs to `DESTINATION`.

## Tooling choice

Use Bitcoin Core v29 or newer, or another node/RPC service that supports package
broadcast equivalent to `submitpackage`, for the broadcast step. Bitcoin Core
documents `submitpackage` as the RPC that submits a package of raw transactions
to the local node; the package is validated against consensus and mempool
policy, and the interface is still experimental:
https://bitcoincore.org/en/doc/29.0.0/rpc/rawtransactions/submitpackage/

Sparrow Wallet or Electrum can be useful for the CPFP signing step if the CPFP
UTXO key is in that wallet or hardware signer. They are not enough for the
current broadcast step unless they expose package relay or are paired with a
Bitcoin Core node where you can call `submitpackage`. Electrum documents normal
single-transaction signing and broadcast flows, but the Spark exit flow may need
the parent transaction and fee-bump child submitted as one package:
https://electrum.readthedocs.io/en/latest/coldstorage.html

## 0. Prerequisites

Install the repo dependencies:

```sh
nix develop
npm install
```

Have these inputs ready:

- Spark seed or mnemonic, preferably in a local file with mode `0600`.
- Latest encrypted Spark recovery bundle, or live Spark operators so the bundle
  can be refreshed.
- Destination Bitcoin address for the eventual final sweep.
- CPFP Bitcoin UTXO controlled by a signing wallet or hardware signer.
- Bitcoin Core RPC access for package broadcast.

The CPFP UTXO must be a normal L1 Bitcoin output, not a Spark leaf and not a
Lightning payment. It must be unspent, on the same Bitcoin network, and
controlled by a key that can sign the generated CPFP PSBT.

## Simple flow: automated exit with `make recover`

When the Spark seed is available, `make recover` drives the whole exit:

```sh
make recover \
  SEED_FILE=../.spark-seed.txt \
  BUNDLE=../recovery-bundle.json \
  NETWORK=mainnet \
  FEE_RATE=1
```

Before touching the chain it prepares the wallet on a best-effort basis while
Spark operators are still reachable: it consolidates the leaves into the
exit-optimal (fewest-leaves) denominations so the maximum value is economical
to exit, and refreshes the recovery bundle so the exit runs against the
current leaves (the previous bundle file is kept as a timestamped backup).
Both steps are opportunistic: when the operators or the SSP are offline the
flow notes what was skipped and proceeds with the saved bundle, which is the
normal unilateral-exit situation. Pass `NO_CONSOLIDATE=1` to refresh without
swapping leaves, or `NO_REFRESH=1` to skip both and use the saved bundle
as-is. When a `recovery-packages.json` from a previous run exists, the
prepare phase is skipped automatically so a resumed recovery never swaps
leaves whose exits are already in flight.

It then derives the CPFP funding address from the seed, waits for funding to
confirm there if none exists yet, then loops package → autosign → submit →
wait-for-confirmation, one package per leaf chain at a time, until every leaf
is either fully broadcast or waiting on its refund timelock. Spark's v3 (TRUC)
transactions only allow one unconfirmed parent+child pair per chain, so each
package must confirm before the next one in that chain can enter the mempool —
the loop handles that automatically. Expect roughly one block (~10 minutes)
per remaining package.

Key properties:

- **Uneconomical leaves are skipped by default.** A leaf is only exited when
  its value covers its CPFP fee-bump costs plus the final sweep fee. The
  summary reports each leaf's `valueSats`, `feeSats`, and `netSats`. Pass
  `INCLUDE_UNECONOMICAL=1` to exit everything anyway, or `MIN_NET_SATS=<n>` to
  demand a larger margin.
- **Timelocked refunds are deferred, not broadcast.** Each leaf's refund
  transaction has a CSV timelock (about 2,000 blocks for fresh leaves). The
  loop reports the maturity height per leaf and exits when only timelocked
  refunds remain; re-run the same command after maturity and it broadcasts
  them. Because refunds are deferred, the funding change is never locked and
  leaves proceed sequentially over a single funding UTXO.
- **`FAN_OUT=1` broadcasts leaves in parallel.** It first splits the funding
  into one UTXO per economical leaf (one extra transaction), after which each
  leaf chain advances every block instead of taking turns.
- **Safe to interrupt and re-run at any time.** Every round rebuilds packages
  from live chain state, so confirmed transactions are never resubmitted and a
  crash, rate-limit, or reboot costs nothing.

The refund transactions are written to `recovery-packages.json` (mode `0600`)
for step 8's `make sweep` once refunds confirm. All Esplora traffic defaults
to Blockstream's public instance (`https://blockstream.info/api`); set
`ESPLORA_URL=<url>` to use a self-hosted one (required on regtest).

If the recovery turns out to be unnecessary (operators come back, false
alarm) and the wallet returns to day-to-day use, swap the leaves back to the
transfer-optimal shape with `make consolidate MULTIPLICITY=1` and refresh the
bundle again; the exit-optimal denominations make ordinary payments depend
on an SSP swap first. See the consolidation trade-off section in the README.

The manual step-by-step equivalent (`cpfp-address` → `watch-cpfp` → `package`
→ `sign-packages` → `broadcast`) remains available for hardware-signer and
Bitcoin Core flows; sections 1–8 below document each stage in detail. Note
that the manual `broadcast` submits packages back-to-back without waiting for
confirmations, so on mainnet only the first package per chain is accepted per
block — prefer `make recover` unless you are driving the loop yourself.

## 1. Refresh the recovery bundle while operators are online

Run this before an outage, and again after every event that can change Spark
leaves. If a unilateral exit looks likely, consider consolidating the leaves
first (`make consolidate SEED_FILE=... NETWORK=mainnet`, or rely on
`make recover` doing it automatically): fewer, larger leaves make more of the
balance economical to exit. Consolidation spends the current leaves, so
always refresh the bundle after it.

```sh
make refresh-recovery-bundle \
  SEED_FILE=../.spark-seed.txt \
  BUNDLE=../recovery-bundle.json \
  NETWORK=mainnet \
  ACCOUNT_NUMBER=1 \
  OPERATOR_SET=spark-mainnet \
  APP_VERSION=example-app
```

If `SEED_FILE` is omitted, the Rust exporter prompts for the Spark seed with
terminal echo disabled.

Confirm the bundle has recoverable leaves:

```sh
jq '{schema, network, createdAt, leafCount: (.leaves | length), nodeCount: (.nodes | length), btcSats: .balances.btcSats}' ../recovery-bundle.json
```

Expected: `leafCount` is greater than zero. If it is zero, this bundle cannot
recover Bitcoin leaves offline.

Store the bundle encrypted. It does not contain private keys, but it does reveal
wallet graph metadata and it is required for offline recovery.

## 2. Prepare the CPFP UTXO

The `package` command needs an external L1 Bitcoin UTXO to fund the fee bumps, in
this shape:

```text
txid:vout:value:script:publicKey
```

Field meanings:

- `txid`: transaction id containing the fee UTXO.
- `vout`: output index.
- `value`: output value in sats.
- `script`: output scriptPubKey hex.
- `publicKey`: public key for the signer controlling that output.

### Recommended: seed-derived funding

When the recovery seed is available, let the CLI derive a dedicated funding
address (path `m/8797556'/<account>/0` — only the purpose is hardened, so a
watch-only wallet like Sparrow can track it from the `m/8797556'` xpub;
isolated from Spark's own keys), tell you the
amount to send, and assemble the string for you. This is the primary path for
mobile/programmatic recovery and avoids manual `listunspent` export.

```sh
node src/cli.ts cpfp-address \
  --bundle ../recovery-bundle.json \
  --seed-file ../.spark-seed.txt \
  --network MAINNET \
  --fee-rate 1
```

Send at least the printed `requiredSats` to the printed `cpfpAddress`, then:

```sh
node src/cli.ts watch-cpfp \
  --bundle ../recovery-bundle.json \
  --seed-file ../.spark-seed.txt \
  --network MAINNET \
  --fee-rate 1
```

`watch-cpfp` polls Esplora (every 30 seconds by default, `--poll-interval` to
change) until a UTXO of at least `requiredSats` (auto-computed from `--bundle`
+ `--fee-rate`, or set `--min-sats`) confirms at the funding address, then
prints a `cpfpUtxo` field to use as `CPFP_UTXO`/`--cpfp-utxo` below. It never
gives up on its own unless `--timeout` is set; transient Esplora errors such as
timeouts or rate limiting are retried with exponential backoff (up to 8x the
poll interval). It requires `--min-sats` or `--bundle` so it never accepts an underfunded
UTXO. While waiting it announces incoming transactions it sees at the address,
including unconfirmed ones and ones below the required amount. Passing
`--min-confirmations 0` accepts a 0-conf funding UTXO, but is not recommended:
the CPFP fee-bump child is a v3 (TRUC) transaction that mempool policy limits
to one unconfirmed parent (the exit transaction), so packages built on
unconfirmed funding are rejected until the funding transaction confirms.
On REGTEST/LOCAL, pass `--esplora-url` (Esplora has no default there).
Because the key is seed-derived, step 5 Option A can sign with `--seed-file`.

### Alternative: external fee wallet

With Bitcoin Core, get candidate UTXOs from a separate fee wallet:

```sh
bitcoin-cli -rpcwallet=<fee-wallet> listunspent 1 9999999
```

For a selected output, convert BTC to sats and append the matching public key.
Example:

```text
9f...:0:50000:0014...:02...
```

For wallet-specific export steps from Bitcoin Core, Electrum, and Sparrow, see
[withdraw-guide.md#cpfp-utxo-input](withdraw-guide.md#cpfp-utxo-input).

Make sure the same wallet or hardware signer can sign a PSBT spending this UTXO.

## 3. Plan the recovery

Run the dry plan first:

```sh
make plan \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  CPFP_UTXO=<txid:vout:value:script:pubkey>
```

Check:

- `network` matches the intended Bitcoin network.
- `leafCount` matches the number of expected Bitcoin leaves.
- `estimatedRecoverableBtcSats` is economically worth recovering.
- `cpfpUtxoCount` is nonzero.
- USDB, if present, is not treated as covered by Bitcoin unilateral exit.

At 1 sat/vbyte, use about 10,000 sats for one leaf and 20,000 sats total for two
leaves as the practical floor until package and sweep sizing are measured.

## 4. Construct unilateral-exit packages

Generate the package JSON:

```sh
make package \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  CPFP_UTXO=<txid:vout:value:script:pubkey> \
  > recovery-packages.json
```

The output shape is:

```json
{
  "destination": "<bitcoin-address>",
  "packages": [
    {
      "leafId": "<spark-leaf-id>",
      "txPackages": [
        {
          "tx": "<raw-parent-or-refund-tx-hex>",
          "feeBumpPsbt": "<unsigned-cpfp-psbt-hex>"
        }
      ]
    }
  ]
}
```

Process `packages[]` and each `txPackages[]` in order. Each `txPackages[]`
entry contains the parent transaction hex and the CPFP PSBT that must be signed.
The last `txPackages[]` entry for each leaf is the Spark refund transaction.

Spark refund transactions use a block-based CSV relative timelock on their
first input. Fresh leaves currently start at 2,000 blocks for the CPFP refund
path, which is about 13.9 days at Bitcoin's 10-minute target block interval.
The SDK direct-without-CPFP path adds a 50-block offset, but this tool's package
broadcast flow uses the CPFP path. Renewed leaves can have shorter timelocks in
100-block steps, so decode the generated refund transaction's input sequence if
you need the exact wait for a specific package. The local E2E mines 2,050 blocks
as a conservative regtest buffer.

## 5. Sign each CPFP PSBT

### Option A: Automated signing with the CLI (recommended for mobile/programmatic use)

If the funding address came from the seed-derived path in step 2, sign with the
same seed — no separate key file needed:

```sh
node src/cli.ts sign-packages \
  --packages recovery-packages.json \
  --seed-file ../.spark-seed.txt \
  --network MAINNET \
  --out recovery-packages-signed.json
```

Or equivalently `make sign-packages PACKAGES=recovery-packages.json
SEED_FILE=../.spark-seed.txt`.

`sign-packages` re-derives the CPFP key (`--account-number` defaults to 0, match
whatever you passed to `cpfp-address`). Alternatively, if the CPFP private key is
available as hex (e.g. an app-managed key), pass it directly:

```sh
node src/cli.ts sign-packages \
  --packages recovery-packages.json \
  --key-file cpfp-key.hex \
  --out recovery-packages-signed.json
```

Prefer `--seed-file` or `--key-file` over `--private-key <hex>`, which exposes
the key in shell history and `ps`. If you do keep a `cpfp-key.hex`, write it with
`chmod 0600` and delete it after recovery. (The CLI already writes its own
outputs with mode `0600`.)

This signs every `feeBumpPsbt` in the package JSON and adds `signedChildTx` to
each entry. The output is ready for broadcast. The SDK chains the CPFP UTXO
automatically — one initial UTXO feeds all packages via change outputs.

### Option B: Manual signing with Bitcoin Core or hardware wallet

The generated `feeBumpPsbt` is hex-encoded. Bitcoin Core wallet RPC expects a
base64 PSBT, so convert before signing:

```sh
PSBT_HEX=<feeBumpPsbt-from-recovery-packages-json>
PSBT_B64=$(node -e "process.stdout.write(Buffer.from(process.argv[1], 'hex').toString('base64'))" "$PSBT_HEX")
```

If the fee wallet is in Bitcoin Core, unlock it if needed and sign:

```sh
bitcoin-cli -rpcwallet=<fee-wallet> walletprocesspsbt "$PSBT_B64" true "DEFAULT" true true
```

Bitcoin Core documents `walletprocesspsbt` as updating a PSBT with wallet input
information and signing inputs the wallet can sign:
https://bitcoincore.org/en/doc/29.0.0/rpc/wallet/walletprocesspsbt/

Expected result:

```json
{
  "complete": true,
  "hex": "<signed-cpfp-child-tx-hex>"
}
```

If signing in Sparrow, Electrum, or a hardware signer, import the PSBT, sign it,
finalize it, and export the final raw transaction hex. If the wallet only gives
you a signed PSBT, finalize/extract it with Bitcoin Core:

```sh
bitcoin-cli finalizepsbt "$SIGNED_PSBT_B64"
```

Bitcoin Core documents `finalizepsbt` as extracting the network transaction hex
when the PSBT is complete:
https://bitcoincore.org/en/doc/29.0.0/rpc/rawtransactions/finalizepsbt/

## 6. Broadcast each package

### Option A: Blockstream Esplora (no local node required)

Add the signed CPFP child hex to each `txPackages[]` entry as `signedChildTx`,
then broadcast all packages with the built-in CLI:

```sh
node src/cli.ts broadcast \
  --packages recovery-packages-signed.json \
  --network MAINNET
```

Or equivalently `make broadcast SIGNED_PACKAGES=recovery-packages-signed.json
NETWORK=mainnet`.

This submits each package to Blockstream's Esplora `POST /txs/package` endpoint
(the default when no URL is given). Use `--esplora-url <url>` (or
`ESPLORA_URL=<url>` with make) to point at a self-hosted Esplora instance
instead.

### Option B: Bitcoin Core RPC

For each `txPackages[]` entry, submit the Spark transaction and signed CPFP child
as a package:

```sh
bitcoin-cli submitpackage '["<tx>","<signed-cpfp-child-tx-hex>"]'
```

Expected success has `package_msg` or `package-msg` equal to `success`, or each
transaction result has no `error`.

### Notes

If the node rejects a package with missing-inputs and an earlier unconfirmed
Spark transaction is its parent, include the unconfirmed parent transaction hex
before the current transaction and signed child in topological order. Bitcoin
Core requires the child to be last in the submitted package.

Do not replace this step with ordinary single-transaction broadcast unless you
have verified the parent transaction is independently acceptable to mempool
policy. For Spark exits, the CPFP child is what pays the package fee.

## 7. Wait for confirmations and timelocks

Track each accepted transaction:

```sh
bitcoin-cli getrawmempool true
bitcoin-cli gettransaction <txid>
```

Wait for required confirmations and relative timelocks before attempting the
next package or final spend. The last package entry for each leaf is the refund
transaction; do not broadcast it until its input sequence has matured relative
to the transaction it spends. For current fresh leaves, expect a 2,000-block
wait, roughly two weeks on mainnet. Once the refund transaction itself is
confirmed, the `make sweep` transaction spends the refund output as a normal
Bitcoin transaction.

## 8. Sweep recovered funds to the destination

After the timelock-gated refund transaction has been broadcast and confirmed,
construct a signed sweep transaction:

```sh
make sweep \
  PACKAGES=recovery-packages.json \
  SEED_FILE=../.spark-seed.txt \
  NETWORK=mainnet \
  DESTINATION=<bitcoin-address> \
  FEE_RATE=1 \
  ACCOUNT_NUMBER=1 \
  > sweep-transactions.json
```

The command:

- reads the `package` output,
- uses the last transaction for each leaf as the refund transaction,
- derives Spark refund-key candidates from the seed,
- verifies a candidate matches refund transaction output 0,
- builds a one-input, one-output Taproot key-path spend to `DESTINATION`,
- signs the sweep transaction, and
- prints signed raw transaction hex.

Output shape:

```json
{
  "destination": "<bitcoin-address>",
  "feeRateSatPerVbyte": 1,
  "sweeps": [
    {
      "leafId": "<spark-leaf-id>",
      "refundTxid": "<refund-txid>",
      "refundVout": 0,
      "refundValueSats": "10000",
      "refundAddress": "<derived-refund-address>",
      "derivationPath": "m/8797555'/1'/1'/...",
      "sweepTxid": "<sweep-txid>",
      "sweepTx": "<signed-raw-sweep-transaction-hex>",
      "feeSats": "111",
      "vsize": 111
    }
  ]
}
```

Broadcast each `sweepTx` as a normal Bitcoin transaction. With the CLI:

```sh
node src/cli.ts broadcast-sweep \
  --sweeps sweep-transactions.json \
  --network MAINNET
```

Or with Bitcoin Core:

```sh
bitcoin-cli sendrawtransaction "<sweepTx>"
```

Check confirmation status:

```sh
node src/cli.ts tx-status --txid <txid> --network MAINNET
```

Confirm the destination output on chain before considering recovery complete.

After the sweep transaction is standard and no longer needs package relay, a
normal Bitcoin wallet or single-transaction broadcast service can broadcast it.
Bitcoin Core is still preferred for auditability.

## Source of the sweep derivation

The public Spark SDK unilateral-exit helper constructs node/refund transaction
packages and fee-bump PSBTs; it does not expose a high-level "sweep to arbitrary
destination" helper. The Breez SDK internal CLI contains the practical clue: for
each refund transaction, it independently derives candidate paths from the seed,
matches the refund output script, and prints a Taproot descriptor that can be
swept by a Bitcoin wallet. This repo automates the same idea directly and emits
the signed sweep transaction instead of a descriptor.
