# Follow-up: who participated after the unilateral exit began?

This follows the [July 2026 mainnet unilateral-exit case study](mainnet-exit-case-study.md).
The original write-up ended with four economical leaves through most of their
user-broadcast exit chains and waiting for their final refund timelocks. By
2026-08-01, all four had instead completed through the alternative
`directTx -> directRefundTx` branch already stored in each Spark `TreeNode`.

The short answer to “were Spark Operators involved?” is:

- **Yes, before the emergency:** Spark Operators participated in normal Spark
  state transitions, produced the threshold signatures embedded in the saved
  transactions, and served the leaf and ancestor data used to make the recovery
  bundle.
- **No fresh permission was needed for the unilateral exit:** the wallet already
  held signed transactions. The recovery operator could construct, fee-bump,
  sign the external CPFP inputs, and broadcast the user path without asking a
  Spark Operator to approve or sign anything new.
- **A watchtower acted later:** someone broadcast the pre-signed direct path for
  all four leaves. The path and timing are consistent with an automated Spark
  Operator watchtower, but the Bitcoin chain does not identify the broadcaster.
- **No Spark Operator is needed for the final sweep:** each confirmed direct
  refund pays a Taproot output controlled by the wallet seed. The user signs and
  broadcasts the final destination sweep.

This distinction is important: “unilateral” means that no other party's fresh
authorization is required. It does not mean that no other party may relay one
of the already-signed safety transactions.

## What happened on chain

Each affected leaf contained two relevant terminal routes:

```text
user-driven CPFP route:  ... -> nodeTx -> refundTx
watchtower direct route: ... -> directTx -> directRefundTx
```

The recovery tool had advanced the first route. Later, the second route won
the conflicting spend. Once a `directTx` confirmed, the corresponding `nodeTx`
could never confirm because both spent the same earlier output.

The four confirmed direct routes were:

| Leaf | Direct transaction | Direct refund | Leaf value -> refund output |
|---|---|---|---:|
| `019a2e54...` | [`3d9dfd72...57ff`](https://mempool.space/tx/3d9dfd72874e6c9cd221a56ed0881c1c072135040eaf45267941538022b857ff), block 958634 | [`24065da0...b99b`](https://mempool.space/tx/24065da0398d2159a2b78aaabf6febf582c796de48edab61529faed8838fb99b), block 959985 | 32,768 -> 30,858 sats |
| `019a2ea8...` | [`649156b3...0afc`](https://mempool.space/tx/649156b3d5ce76b07a47ebcbb36dfb9e313ba09b6b7207dcab830cb5799b0afc), block 958852 | [`f1a98bc2...7505`](https://mempool.space/tx/f1a98bc20d671e031a4a5279ca2fe73629e29eec9c147865724ba807b6087505), block 959503 | 32,768 -> 30,858 sats |
| `019a2f03...` | [`d38f06c5...c4c9`](https://mempool.space/tx/d38f06c56bcd45ce19e1d366c9d85131af64188f8b6cd9c20c9308b7e29ec4c9), block 958568 | [`d9848c16...a53f`](https://mempool.space/tx/d9848c16c77667081c8ab96316f1f16c9db0a868838ebd31c209165796b2a53f), block 960519 | 16,384 -> 14,474 sats |
| `019a2f61...` | [`8189b190...0ac5`](https://mempool.space/tx/8189b190ace768f2fc545e1140734374506a38afa87f28ae9c23d8d5985b0ac5), block 958481 | [`cf6d199d...3e9f`](https://mempool.space/tx/cf6d199dd1ec0e87c81b6dc730ced091cf4dd9b35a1a437a399c3477f74e3e9f), block 960432 | 8,192 -> 6,282 sats |

Every direct transaction and direct refund paid a **955-sat fee** from the
Spark leaf path: 8 transactions times 955 sats = **7,640 sats**. The four
confirmed refund outputs therefore total **82,472 sats**. At the 2026-08-14
follow-up snapshot, output 0 of every direct refund was still unspent and its
script matched the refund key derived from the wallet seed.

At approximately 111 vbytes per final sweep and 1 sat/vB, the expected total
at the destination is about **82,028 sats** after another approximately 444
sats of sweep fees. This supersedes the original case study's 89,668-sat
projection, which assumed the zero-fee `refundTx` route would win and its fees
would continue to ride external CPFP children. The direct route instead paid
1,910 sats from each leaf: 955 in `directTx` and 955 in `directRefundTx`.

## What “the operators were involved” means

### 1. Normal operation and transaction signing: yes

Spark transfers involve the Spark Operators. During deposit and transfer state
updates, the wallet and the operator set prepare signed recovery alternatives.
That is why the saved `TreeNode` contained `nodeTx`, `refundTx`, `directTx`,
`directRefundTx`, and `directFromCpfpRefundTx` before this recovery began.

Spark's documentation describes an exit transaction as a signed transaction
that lets the user withdraw without cooperation, and says unilateral exits use
transactions signed during deposit or the most recent transfer:

- [Core concepts: Exit Transaction](https://docs.spark.money/learn/core-concepts#exit-transaction)
- [Withdrawals to L1: Unilateral Exit](https://docs.spark.money/learn/withdrawals#unilateral-exit)

The operators' role in creating and signing the safety state happened before
the emergency. It is not a live veto over the later unilateral exit.

### 2. Recovery-bundle export: yes, while operators were reachable

The July bundle was exported by authenticating to the Spark coordinator and
querying operator `TreeNode` state, including ancestors. The seed alone cannot
discover the current leaf graph after operators disappear. Once the complete
bundle was saved, package construction no longer needed live operator data.

This is a data-availability dependency during preparedness, not an
authorization dependency during recovery. A stale or incomplete bundle can
still make the practical exit unavailable even though the Bitcoin signatures
exist.

### 3. The recovery operator's CPFP chain: no fresh Spark Operator action

The user-side tool reconstructed the saved branch, signed only the external
fee-bump inputs derived from the user's seed, submitted Bitcoin packages, and
waited for confirmations. Spark Operators did not supply new signature shares
or approve a destination address during those rounds.

### 4. The later direct route: a watchtower acted, identity unproven

Spark documents the safety problem where a prior owner broadcasts an old
branch, and states that Spark Operators retain signed transactions and can act
as watchtowers for the current owner. It also says that the same watchtower
function can be delegated to a third party because the watchtower does not need
to hold toxic key material:

- [Limitations / Attacks](https://docs.spark.money/learn/limitations)

The mainnet evidence is strongly consistent with that mechanism:

- all four competing `directTx` transactions confirmed;
- each later `directRefundTx` spent its matching direct output;
- the direct refunds confirmed at or immediately after their encoded relative
  timelocks; and
- the same route was selected independently for all four leaves.

That supports “an automated watchtower acted.” It does **not** prove which
Spark Operator, SSP, or delegated third party submitted the raw transactions.
Bitcoin records the transaction, not the peer or service that relayed it.
Calling these “operator-broadcast transactions” without that qualification
would overstate what the chain proves.

The watchtower also did not create a new spend at that moment. It relayed a
transaction whose required signatures were already present. Anyone holding the
same valid raw transaction could have broadcast it.

### 5. Final destination sweep: no

The direct refund output belongs to the user's refund key. The fixed flow
selects the exact confirmed direct refund, derives and verifies the matching
key from the seed, signs the sweep locally, and broadcasts it as an ordinary
Bitcoin transaction. No Spark API, operator signature, or SSP action is part
of that final spend.

## Why the first resume attempt looped

The saved `recovery-packages.json` held the expected `refundTx` for each
user-driven `nodeTx` route. It did not hold the winning `directRefundTx`.

For leaf `019a2e54...`, for example, the tool retried `nodeTx`
`bc09f5f1...ed43`. Its input had already been spent by confirmed `directTx`
`3d9dfd72...57ff`, so Bitcoin Core correctly returned
`bad-txns-inputs-missingorspent`. The CPFP child failed because its parent was
invalid. This was a permanent competing-branch outcome, not a dependency that
might confirm later.

The reconciliation code recognized the original `refundTx` and the
`directFromCpfpRefundTx` variant, but not `directRefundTx`. It therefore kept
trusting the SDK's losing `nodeTx` package. The follow-up fix now:

1. derives every terminal refund variant from the bundled `TreeNode`;
2. checks those variants before trusting an SDK package that may describe a
   losing branch;
3. preserves the exact broadcast refund transaction as sweep input;
4. rewrites the packages file with that winning variant, retaining a backup;
5. retries transient Esplora funding and tip reads; and
6. exposes construction and broadcast of the final sweeps through Make targets.

The operator-facing completion flow is now:

```sh
make recover \
  SEED_FILE=../.spark-seed.txt \
  BUNDLE=../recovery-bundle.json \
  PACKAGES=../recovery-packages.json \
  NETWORK=mainnet \
  FEE_RATE=1

make sweep \
  SEED_FILE=../.spark-seed.txt \
  PACKAGES=../recovery-packages.json \
  SWEEPS=../sweep-transactions.json \
  NETWORK=mainnet \
  ACCOUNT_NUMBER=1 \
  DESTINATION=<trusted-bitcoin-address> \
  FEE_RATE=1

make broadcast-sweep \
  SWEEPS=../sweep-transactions.json \
  NETWORK=mainnet
```

For this exact wallet, whose four direct refunds were verified on chain, the
first command only reconciles the winning variants into the packages file; the
last command broadcasts the destination sweeps. `make recover` is still a live
broadcasting command in other chain states. As always, verify the trusted
destination before constructing or broadcasting the sweeps.

## Revised takeaways

1. **Unilateral does not mean solitary.** The safety transactions were created
   with operator participation during normal operation, and a watchtower may
   later help by relaying them. The user still needs no fresh permission to
   enforce or sweep the exit.
2. **The chain proves the winning branch, not the broadcaster's identity.** Use
   “watchtower-consistent” unless separate authenticated service logs establish
   attribution.
3. **Recovery state is a set of alternatives, not one linear chain.** Tooling
   must reconcile every pre-signed terminal variant before interpreting
   `missingorspent` or deciding which transaction to sweep.
4. **Persist the transaction that actually won.** A saved intended refund is
   not sufficient after a conflicting direct refund confirms.
5. **Fee accounting depends on the winning branch.** Here the automated direct
   route recovered the leaves without external CPFP for its last two steps, but
   charged 7,640 sats from the leaf values and reduced the eventual destination
   amount by the same amount relative to the original projection.
