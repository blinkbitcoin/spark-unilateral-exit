# spark-unilateral-exit

Private Blink workspace for Spark unilateral-exit recovery research, tooling, and tests.

This repo starts with a bundle-first recovery model:

- Blink mobile keeps an encrypted Spark recovery bundle fresh while Spark operators are online.
- The CLI consumes that bundle plus CPFP fee inputs and a destination Bitcoin address.
- Seed-only recovery is not sufficient once Spark operators are offline, because current leaves cannot be discovered from the seed alone.

See [docs/withdraw-guide.md](docs/withdraw-guide.md) for the recovery guide.

## Current CLI

Install dependencies:

```sh
npm install
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

The `package` command is intentionally still low-level. It creates unilateral-exit transaction packages from the saved `TreeNode` protobuf hex strings. Sweeping final refund outputs to `--destination` needs a follow-up implementation once refund-output derivation and timelock handling are validated against Spark test infrastructure.

## Test

```sh
npm test
```

## GitHub Actions

This repo has two workflows:

- `CI`: runs on push/PR, installs dependencies, runs `npm audit`, unit coverage, and a CLI smoke test.
- `Spark Local E2E`: runs nightly and via `workflow_dispatch`. It checks out upstream `buildonspark/spark`, starts the local docker-compose Spark/bitcoind stack, then runs `npm run test:e2e`.

The local E2E can also be run manually when Docker and the Spark local stack are available:

```sh
RUN_SPARK_E2E=1 npm run test:e2e
```
