# spark-unilateral-exit

Spark unilateral-exit recovery research, tooling, and tests.

This repo uses a bundle-first recovery model:

- A Spark wallet or app keeps an encrypted Spark recovery bundle fresh while Spark operators are online.
- The CLI consumes that bundle plus CPFP fee inputs and a destination Bitcoin address.
- Seed-only recovery is not sufficient once Spark operators are offline, because current leaves cannot be discovered from the seed alone.

See [docs/withdraw-guide.md](docs/withdraw-guide.md) for the recovery guide and [docs/recovery-runbook.md](docs/recovery-runbook.md) for the operator runbook.

## Current CLI

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

The CLI does not currently enforce a minimum recoverable balance. As conservative operator guidance at 1 sat/vbyte, treat about 10,000 sats for one Bitcoin leaf or about 20,000 sats total for two Bitcoin leaves as the practical floor. This is not a protocol limit; it is a planning threshold for package fees, CPFP fees, final sweep fees, dust, and margin. See [docs/withdraw-guide.md](docs/withdraw-guide.md#minimum-practical-balance) for details.

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
