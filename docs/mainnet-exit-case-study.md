# Case study: a real Spark unilateral exit on Bitcoin mainnet

This is a write-up of an actual unilateral exit performed with this repo on
2026-07-08, recovering a real mainnet Spark wallet without relying on Spark
operators for the exit itself. Everything below — transaction IDs, amounts,
failures — happened on Bitcoin mainnet and is publicly verifiable on chain.
It doubles as an honest account of what unilateral exit costs today, because
the numbers surprised us.

## The wallet

A mobile Spark wallet holding **100,000 sats spread across 22 leaves**. Spark
wallets accumulate leaves through normal use (payments split and re-split the
tree), and each leaf carries its own exit chain: the on-chain transactions
that must confirm, level by level, to force the leaf onto Bitcoin without
operator cooperation. For this wallet that meant **253 transaction packages**
across the 22 chains — for 100k sats.

## Step 1: keep a recovery bundle fresh

Seed-only recovery is not possible once Spark operators are offline: current
leaves cannot be discovered from the seed alone. The exit needs a **recovery
bundle** — a JSON snapshot of the wallet's leaves and their ancestor
transactions — refreshed while operators are still online:

```sh
make refresh-recovery-bundle SEED_FILE=../.spark-seed.txt BUNDLE=../recovery-bundle.json
```

First real-world lesson: our first bundle was silently incomplete. The
operators' bulk `query_nodes(include_parents=true)` API **omits the tree-root
node for legacy mainnet trees**, so every one of the 22 exit chains had a gap
at the top, and offline package construction failed with
`Exit chain is incomplete`. Re-fetching missing ancestors by node ID (which
bypasses the root skip) fixed it — the exporter now does this automatically
and refuses to write a bundle with open chains. **Validate your bundle's
ancestor chains before you need them**; an incomplete bundle discovered during
an outage is unrecoverable.

## Step 2: fee funding from the same seed

Exit transactions are pre-signed with zero fee and pay fees through CPFP
ephemeral anchors, so the exit needs an independent L1 UTXO to fund fee bumps.
The CLI derives a dedicated funding address from the wallet seed itself
(path `m/8797556'/<account>/0`, only the purpose hardened so a watch-only
wallet can monitor it):

```sh
make cpfp-address SEED_FILE=../.spark-seed.txt BUNDLE=../recovery-bundle.json FEE_RATE=1
```

At 1 sat/vB this asked for **78,573 sats to exit all 22 leaves** — nearly 79%
of the wallet balance in fees. We funded it
([`3ab20a4c…7262`](https://mempool.space/tx/3ab20a4c40d75f524b6c7b9e5837bc0bdef6aa350e79d932aa134134f0957262))
before doing the arithmetic per leaf. More on that below.

## Step 3: the naive broadcast, and why it failed

The first attempt packaged, signed, and submitted all 253 packages
back-to-back through Esplora's `POST /txs/package`. The first package
confirmed
(parent [`16895bc8…9619`](https://mempool.space/tx/16895bc821c505c26f1dedb0216423b371f7deb930b0bd157a37c498e49e9619),
CPFP child [`384cdc6d…3b37`](https://mempool.space/tx/384cdc6d74303dd0cf0fd683676561c94d07bcb2079dd8f9fc22a88c1a023b37)).
The other 252 were rejected:

```json
"error": "TRUC-violation, tx 16895bc8… would exceed descendant count limit"
"error": "bad-txns-inputs-missingorspent"
```

Spark exit transactions are **v3 (TRUC)**. Mempool policy caps a v3 cluster at
one unconfirmed parent plus one child — that is what makes the pre-signed
zero-fee exit transactions safely fee-bumpable, and it also means **each level
of an exit chain must confirm before the next level can enter the mempool**.
A 15-package chain takes at least 15 blocks, no matter how it is submitted.
Any tooling that fires packages back-to-back will strand everything after the
first package per chain.

## Step 4: exit only what is worth exiting

Before automating the loop, we priced each leaf: CPFP fees for its chain plus
the final ~111 vB sweep, against the leaf's value. The result for this real
wallet at 1 sat/vB:

| | leaves | value | exit cost |
|---|---|---|---|
| **Economical** | 4 | 90,112 sats | 8,388 sats |
| **Uneconomical (dust)** | 18 | 9,888 sats | ~69,000 sats |

Four leaves (32,768 + 32,768 + 16,384 + 8,192 sats) held 90% of the balance.
The other 18 — dust from routine wallet activity, some as small as 1 sat —
would each have cost 2,100–4,600 sats to exit: exiting everything would have
spent ~77.5k sats in fees to recover 100k. The tooling now computes this per
leaf and skips uneconomical leaves by default (`INCLUDE_UNECONOMICAL=1`
overrides; the economics math is regression-tested against this very bundle,
adapted to regtest, in
[`test/e2e/real-bundle-economics.test.ts`](../test/e2e/real-bundle-economics.test.ts)).

### So what lands at the destination?

Following every sat of the 100,000-sat wallet through the economical exit at
1 sat/vB. Two pots of money are in play: the wallet balance itself, and the
9,388 sats of separate fee funding sent to the CPFP address.

**The wallet's 100,000 sats:**

| | sats |
|---|---|
| 4 economical leaves, exit chains + refunds confirmed | 90,112 |
| − sweep fees (4 × ~111 vB × 1 sat/vB) | −444 |
| **arrives at the destination address** | **89,668** |
| dust in 18 uneconomical leaves, left behind in Spark | 9,888 |

Spark exit and refund transactions are pre-signed with **zero fee** (fees ride
the CPFP anchors), so each refund output carries the full leaf value; the only
deduction from the wallet balance itself is the final sweep fee.

**The 9,388 sats of fee funding:**

| | sats |
|---|---|
| CPFP fee bumps across the 4 exit chains | 8,388 |
| safety buffer, returns as change at the funding address | ~1,000 |

Bottom line: **89,668 of 100,000 sats (~90%) reach the destination.** The
all-in cost of the exit is ~18,700 sats — 9,888 abandoned as dust, 8,388 in
CPFP fees, 444 in sweep fees — plus the on-chain fee for the transaction that
funded the CPFP address in the first place. At higher fee rates every term
scales up and more leaves fall below the economic threshold; at 10 sat/vB this
wallet would abandon two more leaves and pay ten times the fees on the rest.

## Step 5: the automated confirm-and-continue loop

The rewritten flow is a single command:

```sh
make recover SEED_FILE=../.spark-seed.txt BUNDLE=../recovery-bundle.json NETWORK=mainnet FEE_RATE=1
```

Each round it rebuilds packages from live chain state, signs the CPFP bump
with the seed, submits **one package per leaf chain**, waits for confirmation,
and repeats. Already-confirmed transactions are skipped on reconstruction, so
the loop is stateless: rate limits, crashes, and reboots cost nothing — re-run
and it resumes. Esplora hiccups are retried with exponential backoff instead
of aborting a wait that spans hours.

Two structural details matter:

- **Refund transactions are deferred, not broadcast.** The last transaction of
  each chain (the refund that actually hands the leaf to the user's key)
  carries a CSV timelock — ~2,000 blocks (~2 weeks) for fresh leaves; this
  wallet's renewed leaves carried 1,400 blocks. The loop decodes each refund's
  lock, reports its maturity height, and stops when only timelocked refunds
  remain. Because refunds are never broadcast early, the fee-funding change is
  never captured by a timelocked transaction, and leaves drain sequentially
  over a single funding UTXO without deadlock.
- **Parallelism is optional.** `FAN_OUT=1` first splits the funding into one
  UTXO per leaf, after which every leaf chain advances each block instead of
  taking turns — the SDK's UTXO handling was designed for exactly this shape.

### What fan-out would have changed here

We ran this recovery sequentially (the default). With `FAN_OUT=1` the loop
would first have broadcast **one extra transaction with 4 outputs** — the
single 9,388-sat funding UTXO split into one UTXO per economical leaf, each
sized to that leaf's remaining CPFP fees plus a 1,000-sat buffer, the last
output absorbing the remainder. A 1-input/4-output P2WPKH transaction is
~203 vB, so ~203 sats at 1 sat/vB.

From then on **4 tracks run in parallel** — one per leaf. Each leaf chain is
its own TRUC cluster, so all four packages of a round are independent and can
confirm in the same block. Each of this wallet's four leaves had a ~6-package
chain before its refund:

| | blocks until timelock wait | at ~10 min/block |
|---|---|---|
| Sequential (default) | 4 leaves × ~6 packages ≈ **24 blocks** | ~4 hours |
| `FAN_OUT=1` | 1 (fan-out) + ~6 (deepest chain) ≈ **7 blocks** | ~70 minutes |

Roughly a **3.5× wall-clock gain for ~203 sats**, and the same shape repeats
after refund maturity: the four refund packages broadcast in one block with
per-leaf UTXOs instead of four consecutive blocks. The gain scales with leaf
count (sum of chain depths versus deepest single chain), so a wallet with
dozens of economical leaves should always fan out; for a handful of leaves,
sequential is simpler and was fast enough here.

## Step 6: timelocks, then sweep

After the loop finishes, each economical leaf's refund waits out its CSV
timelock. Re-running the same `make recover` after maturity broadcasts the
refunds; once they confirm, `make sweep` builds and signs one-input Taproot
key-path spends from the refund outputs to any destination address, and
`broadcast-sweep` pushes them as ordinary transactions. At the time of
writing, this wallet's four economical exits are through their chains and
waiting on refund maturity.

## Takeaways

1. **A unilateral exit is a fire escape, not a door.** 253 packages, one
   block per package per chain, two weeks of timelock, and fees that would
   have consumed 79% of the balance if applied indiscriminately — for a
   100k-sat wallet. With economic triage, ~90% of the balance reached the
   destination. Self-custody on Spark is real, but the exit path is expensive
   and slow by construction; size expectations accordingly.
2. **Dust leaves are a liability.** 18 of 22 leaves were not worth exiting at
   even 1 sat/vB. Wallets should consolidate leaves while operators are
   cooperative, and exit tooling must triage by economics rather than exit
   everything blindly.
3. **Bundle freshness and completeness are the whole game.** Without a
   complete, recent recovery bundle there is nothing to exit. Refresh it on
   every balance change and verify its chains are closed.
4. **Respect TRUC.** One unconfirmed parent+child pair per chain. Exit
   tooling must confirm-and-continue, tolerate `TRUC-violation` and
   `missing-inputs` as normal sequencing signals, and never treat a package
   batch as fire-and-forget.
5. **Everything derives from the seed.** Bundle refresh, fee funding,
   CPFP signing, and the final sweep all used the wallet's existing seed — no
   separate keys to back up, and the funding address is watch-only monitorable
   from an xpub.
