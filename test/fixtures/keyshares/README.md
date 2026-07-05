# Pregenerated operator signing keyshares

These `sparkoperator_{0,1,2}.copy` files are a consistent FROST signing-keyshare
set for the local Spark stack, captured from a warm stack after DKG had filled
the pool. They let the E2E test run on a **cold** stack immediately: without
them, freshly started operators have zero available keyshares and
`generate_deposit_address` fails with
`not enough signing keyshares available (needed 1, got 0)` until DKG catches up
(slow enough that CI timed out).

`scripts/run-e2e.sh` loads them into each operator's database after the stack is
up (see `seed_keyshares`).

## Why they are portable

Keyshares are the FROST secret shares for the group signing keys. They are valid
for any stack whose operators use the same identity keys — and those keys are
committed in the upstream Spark repo (`docker/keys/operator_*.key`). Each file
holds the same key IDs; only `secret_share` differs per operator.

## Format

Postgres `COPY ... TO STDOUT` text format (tab-separated, `\\x…` hex bytea) for
the `signing_keyshares` table, columns:

```
id, create_time, update_time, status, secret_share, public_shares, public_key, min_signers, coordinator_index
```

All rows have `status = AVAILABLE`.

## Regenerating

Bring up the stack, wait for DKG to fill the pool, then dump 256 shared rows per
operator (adjust the container name for your compose project):

```sh
for i in 0 1 2; do
  docker exec <project>-postgres-1 psql -U postgres -d "sparkoperator_$i" -tAc \
    "COPY (SELECT id, create_time, update_time, status, secret_share, public_shares, public_key, min_signers, coordinator_index
           FROM signing_keyshares WHERE status='AVAILABLE' ORDER BY id LIMIT 256) TO STDOUT" \
    > "test/fixtures/keyshares/sparkoperator_$i.copy"
done
```
