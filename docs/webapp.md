# Spark unilateral-exit monitor (webapp)

A dependency-free webapp that watches the Bitcoin chain for Spark unilateral-exit
transactions. It answers: "is someone (an operator, or a wallet driving the
spark-unilateral-exit tool) exiting Spark positions on-chain right now?"

## Run it

```sh
npm run monitor                      # mempool.space mainnet (esplora)
npm run monitor -- --network signet # mempool.space signet
npm run monitor -- --source rpc \
  --rpc-url http://192.168.x.x:8332 --rpc-user USER --rpc-password PASS
```

Then open http://localhost:4480. Use `--port` to change.

- **esplora source** (default): single-tx classification, family walks
  (outspends), address watching, and confirmed-height lookups via
  mempool.space or any electrs/esplora instance (`--esplora-url`). It cannot
  enumerate full block txid lists, so block scans are unavailable.
- **rpc source**: a bitcoind on the LAN with `txindex=1` (server=1, RPC
  reachable). Enables full block scans: every TRUC/P2A/CSV exit shape in a
  block range is classified. No address index, so address watching stays on
  esplora.

Both sources implement the same interface (`src/webapp/chain-source.ts`); a
hybrid (RPC for blocks, esplora for outspends) is a natural follow-up.

## What it detects

Validated against real unilateral exits driven on the local Spark regtest
stack (`scripts/capture-regtest-exit.ts`, gitignored fixtures under
`test/fixtures/webapp/`):

| stage               | standalone shape                                                                 | with family context                  |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| node-tx / direct-tx | TRUC v3 + 0-value P2A anchor, input not CSV-locked (medium)                        | child of static-deposit (high)       |
| refund-tx           | TRUC v3 + P2A anchor + CSV relative lock (~2000-2048 blocks, read per tx) (medium) | child of node-tx (high)              |
| direct-refund-tx    | TRUC + CSV, 1-in/1-out P2TR, no anchor (self-fee) (medium)                         | child of node-tx user output (high)  |
| cpfp-bump-child     | TRUC, >=2 inputs (anchor + funding), no anchor output (medium)                     | spends a P2A anchor (high)           |
| sweep-tx            | -                                                                                | 1-in/1-out spend of a refund (high)  |
| static-deposit      | -                                                                                | family seed only                     |

Ordinary wallet transactions classify `unknown`; a watchlist (txids or output
scripts, e.g. from a recovery bundle) links them into a family and upgrades
confidence.

## API

```
GET  /api/health              tip + source status
GET  /api/config              active source
GET  /api/tx/:txid            classify one tx (standalone)
GET  /api/follow/:txid[?stage=seed-stage]   walk the exit family forward (esplora)
GET  /api/block/:height       scan one block (rpc source)
GET  /api/scan?from=&span=    scan a height range (rpc source, span<=50)
POST /api/watch               {"txids":[...],"scripts":[...]} watch mode
GET  /api/watch               list watch targets
DELETE /api/watch             clear
```

## Regtest ground-truth capture

```sh
# with the local spark-desktop-pilot stack up
SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION=true \
  npm run capture-regtest-exit
```

Drives a full unilateral exit on regtest (deposit -> node tx -> refund) and
records every raw tx with stage labels into `test/fixtures/webapp/exit-capture.json`.
The detector test suite (`test/webapp/exit-detector.test.ts`) validates
classifications against it and self-skips when the capture is absent. The
capture reveals wallet graph metadata, so it stays gitignored.
