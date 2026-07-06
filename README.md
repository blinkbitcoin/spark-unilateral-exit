# spark-unilateral-exit

Spark unilateral-exit recovery research, tooling, and tests.

This repo uses a bundle-first recovery model:

- A Spark wallet or app keeps an encrypted Spark recovery bundle fresh while Spark operators are online.
- The CLI consumes that bundle plus CPFP fee inputs and a destination Bitcoin address.
- Seed-only recovery is not sufficient once Spark operators are offline, because current leaves cannot be discovered from the seed alone.

See [docs/withdraw-guide.md](docs/withdraw-guide.md) for the recovery guide and [docs/recovery-runbook.md](docs/recovery-runbook.md) for the operator runbook.

## Current CLI

The CLI (`node src/cli.js <command>`, run `help` for full flags) exposes:

| Command | Purpose |
|---------|---------|
| `refresh-bundle` | Query live Spark leaves from a seed and write a bundle |
| `plan` | Validate a saved bundle and print a recovery plan |
| `cpfp-address` | Derive a CPFP funding address from the seed and estimate the sats to send it |
| `watch-cpfp` | Watch the funding address for an incoming UTXO and emit it as `--cpfp-utxo` |
| `package` | Construct unilateral-exit packages via the upstream Spark SDK |
| `sign-packages` | Sign the CPFP fee-bump PSBTs (key from seed, key-file, or hex) |
| `broadcast` | Submit signed packages via Esplora |
| `tx-status` | Check confirmation status of a transaction via Esplora |
| `sweep` | Spend confirmed refund outputs to a destination address |
| `broadcast-sweep` | Broadcast signed sweep transactions via Esplora |

`watch-cpfp`, `broadcast`, `broadcast-sweep`, and `tx-status` use Esplora and support only MAINNET/TESTNET/SIGNET by default; on REGTEST/LOCAL pass `--esplora-url` or use `bitcoin-cli`.

Install dependencies:

```sh
nix develop
npm install
```

Refresh the recovery bundle while Spark operators are online:

```sh
node src/cli.js refresh-bundle \
  --seed-file /path/to/spark-seed.txt \
  --network MAINNET \
  --out recovery-bundle.json \
  --operator-set spark-mainnet \
  --app-version example-app
```

The seed file may contain a Spark mnemonic or seed string accepted by the upstream SDK. When `--seed-file`, `--seed`, and `SPARK_SEED` are omitted, the CLI prompts for the seed with terminal echo disabled so typed or pasted wallet material is not displayed. Prefer `--seed-file` or the hidden prompt over `--seed` so shell history does not capture wallet material. `--operator-set` and `--app-version` are optional provenance metadata stored in the bundle. Store the resulting JSON encrypted in the mobile backup target; it contains the current Spark leaves needed for later offline recovery.

For wallets that need direct leaf export, use the standalone recovery-bundle exporter. It builds against the repo-local SDK snapshot under `vendor/breez-spark-sdk`. The npm script runs through the Nix flake so Rust, Node, and protobuf dependencies come from the repo shell:

```sh
npm run refresh-recovery-bundle -- \
  --seed-file ../.spark-seed.txt \
  --network mainnet \
  --out ../recovery-bundle.json \
  --account-number 1 \
  --operator-set spark-mainnet \
  --app-version example-app
```

The standalone exporter queries Spark operators with `include_parents=true` and writes both leaf nodes and ancestor nodes into the same bundle schema. The package builder uses those bundled ancestors as an offline `query_nodes` source when constructing unilateral-exit packages. `--account-number`, `--operator-set`, and `--app-version` are optional; use `--account-number` when the wallet used a non-default Spark account.

The same flows are available as Make targets:

```sh
make refresh-recovery-bundle \
  SEED_FILE=../.spark-seed.txt \
  BUNDLE=../recovery-bundle.json \
  NETWORK=mainnet \
  ACCOUNT_NUMBER=1

make plan \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=bc1qexampledestination000000000000000000000000 \
  FEE_RATE=1 \
  CPFP_UTXO=txid:0:50000:0014example:02examplepubkey

make package \
  BUNDLE=../recovery-bundle.json \
  DESTINATION=bc1qexampledestination000000000000000000000000 \
  FEE_RATE=1 \
  CPFP_UTXO=txid:0:50000:0014example:02examplepubkey

make sweep \
  PACKAGES=recovery-packages.json \
  SEED_FILE=../.spark-seed.txt \
  NETWORK=mainnet \
  DESTINATION=bc1qexampledestination000000000000000000000000 \
  FEE_RATE=1 \
  ACCOUNT_NUMBER=1
```

Derive a CPFP funding address from the seed and estimate the sats to send it, then watch for the funds and capture the ready-to-use `--cpfp-utxo` value:

```sh
node src/cli.js cpfp-address \
  --bundle recovery-bundle.json \
  --seed-file /path/to/spark-seed.txt \
  --network MAINNET \
  --fee-rate 10

# send at least the printed requiredSats to the printed cpfpAddress, then:

node src/cli.js watch-cpfp \
  --bundle recovery-bundle.json \
  --seed-file /path/to/spark-seed.txt \
  --network MAINNET \
  --fee-rate 10
```

`cpfp-address` derives a dedicated P2WPKH funding key from the seed (BIP32 purpose `8797556'`, one above the Spark wallet purpose) and prints `cpfpAddress`, `script`, `publicKey`, and `requiredSats` (summed fee-bump fees plus `--buffer-sats`, default 1000). `watch-cpfp` polls until a UTXO of at least `requiredSats` (from `--bundle` + `--fee-rate`, or `--min-sats`) reaches that address and emits the `cpfpUtxo` string for `package --cpfp-utxo`. It requires `--min-sats` or `--bundle` so it never accepts an underfunded UTXO. This seed-derived path replaces manually exporting a fee UTXO from Bitcoin Core/Electrum/Sparrow (still documented in the withdraw guide), and the same seed signs the CPFP PSBTs via `sign-packages --seed-file`. If you pass `--account-number`, use the same value for `cpfp-address`, `watch-cpfp`, and `sign-packages` (it defaults to 0): each account derives a different key, so a mismatched `watch-cpfp` polls an address that never receives the funds.

Create a dry-run recovery plan from a saved bundle:

```sh
node src/cli.js plan \
  --bundle examples/recovery-bundle.example.json \
  --destination bc1qexampledestination000000000000000000000000 \
  --fee-rate 10 \
  --cpfp-utxo txid:0:50000:0014example:02examplepubkey
```

Generate transaction packages with the upstream Spark SDK:

```sh
node src/cli.js package \
  --bundle examples/recovery-bundle.example.json \
  --destination bc1qexampledestination000000000000000000000000 \
  --fee-rate 10 \
  --cpfp-utxo txid:0:50000:0014example:02examplepubkey
```

The `package` command creates unilateral-exit transaction packages from the saved `TreeNode` protobuf hex strings. After each refund transaction is broadcast and spendable, use `sweep` to spend the refund output to `--destination`.

The CPFP UTXO is an external on-chain Bitcoin output used to pay fees for the unilateral-exit package. It must be unspent, on the same Bitcoin network as the bundle, and controlled by a key you can use to sign the fee-bump transaction. The format is `txid:vout:value:script:publicKey`, where `value` is sats, `script` is the output scriptPubKey hex, and `publicKey` is the compressed or x-only public key for the spending key. See [docs/withdraw-guide.md#cpfp-utxo-input](docs/withdraw-guide.md#cpfp-utxo-input) for Bitcoin Core, Electrum, and Sparrow export steps.

Sweep construction derives the Spark refund key from the seed, verifies it matches the refund transaction output, and emits signed Bitcoin transaction hex. Broadcast the sweep transaction only after the refund transaction confirms and any required timelock has elapsed.

## Minimum Practical Balance

The CLI does not currently enforce a minimum recoverable balance. As conservative operator guidance at 1 sat/vbyte, treat about 10,000 sats for one Bitcoin leaf or about 20,000 sats total for two Bitcoin leaves as the practical floor. This is not a protocol limit; it is a planning threshold for package fees, CPFP fees, final sweep fees, dust, and margin.

These floors are roughly an order of magnitude above Spark's published [cooperative "Exit to L1" fee](https://docs.spark.money/learn/faq#what-are-the-fees-on-spark) of `250 × sats_per_vbyte + 750` (about 1,000 sats at 1 sat/vbyte). That cooperative fee is flat and applies only while Spark operators are online; unilateral exit is the offline fallback and costs more because the user broadcasts the full exit tree plus CPFP bumps and a final sweep rather than one operator-assisted transaction. See [docs/withdraw-guide.md](docs/withdraw-guide.md#minimum-practical-balance) for details.

## Test

```sh
npm test
```

## GitHub Actions

This repo has two workflows:

- `CI`: runs on push/PR, installs dependencies, runs `npm audit`, unit coverage, and a CLI smoke test.
- `Spark Local E2E`: runs nightly and via `workflow_dispatch`. It checks out upstream `buildonspark/spark`, starts the local docker-compose Spark/bitcoind stack, then runs `npm run test:e2e`. The E2E proves live leaf export into the bundle schema against the local Spark stack, constructs and submits the unilateral-exit package, then signs, broadcasts, and confirms the destination sweep.

The local E2E can also be run manually when Docker and the Spark local stack are available:

```sh
RUN_SPARK_E2E=1 npm run test:e2e
```
