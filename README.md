# spark-unilateral-exit

Spark unilateral-exit recovery research, tooling, and tests.

This repo uses a bundle-first recovery model:

- A Spark wallet or app keeps an encrypted Spark recovery bundle fresh while Spark operators are online.
- The CLI consumes that bundle plus CPFP fee inputs and a destination Bitcoin address.
- Seed-only recovery is not sufficient once Spark operators are offline, because current leaves cannot be discovered from the seed alone.

See [docs/withdraw-guide.md](docs/withdraw-guide.md) for the recovery guide.

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

The `package` command is intentionally still low-level. It creates unilateral-exit transaction packages from the saved `TreeNode` protobuf hex strings. Sweeping final refund outputs to `--destination` needs a follow-up implementation once refund-output derivation and timelock handling are validated against Spark test infrastructure.

## Minimum Practical Balance

The CLI does not currently enforce a minimum recoverable balance. As conservative operator guidance at 1 sat/vbyte, treat about 10,000 sats for one Bitcoin leaf or about 20,000 sats total for two Bitcoin leaves as the practical floor. This is not a protocol limit; it is a planning threshold for package fees, CPFP fees, final sweep fees, dust, and margin. See [docs/withdraw-guide.md](docs/withdraw-guide.md#minimum-practical-balance) for details.

## Test

```sh
npm test
```

## GitHub Actions

This repo has two workflows:

- `CI`: runs on push/PR, installs dependencies, runs `npm audit`, unit coverage, and a CLI smoke test.
- `Spark Local E2E`: runs nightly and via `workflow_dispatch`. It checks out upstream `buildonspark/spark`, starts the local docker-compose Spark/bitcoind stack, then runs `npm run test:e2e`. The E2E proves live leaf export into the bundle schema against the local Spark stack before constructing and submitting the unilateral-exit package.

The local E2E can also be run manually when Docker and the Spark local stack are available:

```sh
RUN_SPARK_E2E=1 npm run test:e2e
```
