# Breez SDK unilateral exit compared with this repository

**Status:** Decision and security assessment

**Reviewed:** 2026-08-17

**Scope:** Breez SDK Spark `0.22.0`, Breez SDK `main` at `9141b91c`, this
repository's `main` at `1a33a03`, Blink Mobile `main`, and Blink Mobile SDK
upgrade [#4155](https://github.com/blinkbitcoin/blink-mobile/pull/4155) at
`36f90b6`

## Decision

Use the Breez SDK unilateral-exit API as the preferred production transaction
builder in Blink Mobile once Blink upgrades to a release that contains it.
Keep this repository as an offline recovery toolkit, reference implementation,
and end-to-end test bed.

The implementations overlap in exit construction, fee planning, CPFP signing,
and transaction ordering, but they do not currently solve the same failure
case:

- Breez SDK protects against operators that will not cooperate with a normal
  withdrawal but are still reachable. It must query the operators while
  quoting and building the exit.
- This repository can construct an exit after the operators become
  unreachable, provided the wallet saved a complete, sufficiently fresh
  recovery bundle while they were online.

Therefore the Breez API does not make the recovery-bundle work obsolete. It
does make it unnecessary to duplicate the normal online quote/build API in a
mobile application.

## Effect of the Blink Mobile `0.22.0` upgrade

Blink Mobile [#4155](https://github.com/blinkbitcoin/blink-mobile/pull/4155)
upgrades the React Native package from `0.15.0` to `0.22.0`. Once it lands,
`prepareUnilateralExit` and `unilateralExit` will be available through the
existing connected SDK instance. The upgrade deliberately does not call those
methods or add an exit flow. Landing it changes API availability, not recovery
behavior.

The SDK can take over the transaction-construction core of an **online** exit:

| Process stage | Breez SDK `0.22.0` can own | Blink or this repository must still own |
|---|---|---|
| Detect the need to exit | No | Outage/cooperation policy, feature gate, user consent, and BTC-only warning |
| Preserve outage recovery state | No | Authenticated bundle export while operators are online; encryption, atomic storage, cloud backup, freshness, import, and seed-bound verification |
| Choose leaves and quote economics | `Auto`/`Specific` selection, recoverable value, exact fees, fan-out cost, and single-UTXO/per-branch funding requirements | Fee-rate source, profitability policy, abandoned-leaf display, and user approval |
| Validate destination and funding shape | Network/address, native-SegWit, fee sufficiency, and dust validation | Trusted destination entry/confirmation, dedicated-key custody, UTXO discovery/funding, and fee caps |
| Build and sign the exit | Fetch pre-signed state; build fan-out, node, CPFP child, refund, and eligible sweep transactions; built-in P2WPKH/P2TR signer or custom callback | Protect the funding key, approve any custom-signing boundary, and persist the result before broadcast |
| Order the transactions | Return topological order, `depends_on`, CSV timelocks, kind, and confirmation status | Schedule work across app restarts and enforce one-parent-one-child package relay |
| Broadcast | No | Submit zero-fee parent and CPFP child together, send fan-out/sweep alone, and parse package-policy verdicts even when HTTP status is 200 |
| Monitor and resume | Re-read chain state and rebuild the same `Specific` leaves; rebuild unconfirmed steps at a higher fee | Persist original leaf IDs and signed sets, poll confirmations, re-invoke the SDK, supply replacement/confirmed change UTXOs, and surface partial progress |
| Build the final sweep | Yes, on a later `unilateralExit` call after refund outputs are confirmed | Detect that another build is required, call it, persist/broadcast the sweep, and confirm destination outputs before success |
| Recover with all operators unreachable | No | Build from the saved bundle without operator access, using this repository or an extracted offline library |

This means Blink should not port `spark-unilateral-exit`'s online package
builder into the app after #4155. It should wrap the two Breez calls behind a
narrow adapter and keep the orchestration and offline-bundle paths separate.
Blink Mobile [#4108](https://github.com/blinkbitcoin/blink-mobile/pull/4108)
does not duplicate the SDK builder: it classifies an operator outage, finds and
verifies a seed-encrypted bundle, and then stops at a support-assisted handoff.
Those steps remain necessary because Breez cannot quote or build while the
operators are unreachable.

## Capability comparison

| Capability | Breez SDK Spark `0.22.0` | `spark-unilateral-exit` |
|---|---|---|
| Select economical leaves | `Auto` or explicit `Specific` selection | Per-leaf planning and optional exclusion of uneconomical leaves |
| Quote recoverable value and fees | Exact quote, including single-UTXO fan-out or per-branch funding | Recovery plan with per-leaf economics and CPFP requirements |
| Build exit transactions | Native SDK API returns signed fan-out, node, and refund transactions; it adds a sweep once refund outputs are on-chain | Builds packages through the upstream BuildOnSpark SDK |
| Sign CPFP funding inputs | Built-in P2WPKH/P2TR signer or custom signer callback | Seed-derived, key-file, or raw-key signer; manual PSBT flow is also documented |
| Transaction dependencies | Returns `depends_on`, CSV timelocks, and confirmation status | Orchestrates root-to-leaf package order, confirmations, refunds, and sweeps |
| Broadcast and monitor | Not included; the caller must persist, broadcast, wait, and resume | Included through Esplora/Bitcoin package relay and the `make recover` loop |
| Resume an interrupted exit | Re-quote the same `Specific` leaves and rebuild from operator/chain state; confirmed steps are not rebuilt | Persisted bundle and package artifacts plus chain reconciliation |
| Operators unreachable | **Not supported** | **Supported when a valid recovery bundle was saved first** |
| Bundle export for future outages | Not supported | Direct authenticated operator export of leaves and ancestors |
| BTC leaves | Supported | Supported |
| USDB/Dollar recovery | Not covered by this Bitcoin exit path | Not covered by this Bitcoin exit path |
| Mainnet operational evidence | SDK tests and documented API behavior | A documented 100,000-sat, 22-leaf mainnet recovery and its actual economics |

The Breez behavior is documented in its
[unilateral-exit guide](https://github.com/breez/spark-sdk/blob/0.22.0/docs/breez-sdk/src/guide/unilateral_exit.md)
and was introduced by
[breez/spark-sdk#992](https://github.com/breez/spark-sdk/pull/992). Version
[`0.22.0`](https://github.com/breez/spark-sdk/releases/tag/0.22.0) was published
on 2026-08-13.

## What remains useful in this repository

### Offline operator-outage recovery

A seed restores keys, but it does not discover the wallet's current leaves and
ancestor transactions after the operators disappear. The bundle exporter saves
that state while operators are reachable, validates that ancestor chains are
complete, and lets the package builder later operate against Bitcoin without
Spark operator access. This is the largest capability not supplied by Breez
SDK `0.22.0`.

The bundle must be encrypted, bound to the correct network/account/wallet, and
refreshed after every event that can change the leaf set. A stale bundle may
recover less than the user's current balance. See the
[mobile integration plan](mobile-integration-plan.md) and
[recovery runbook](recovery-runbook.md).

### End-to-end recovery orchestration

The Breez API stops after returning signed transactions. A production caller
still has to:

1. Persist the signed transaction set and selected leaf IDs before broadcasting.
2. Submit each zero-fee parent with its CPFP child as one package.
3. Parse the node's package verdict, including policy errors returned in an HTTP
   200 body.
4. Respect TRUC one-parent-one-child relay policy, transaction dependencies,
   confirmations, and refund CSV timelocks.
5. Resume after process restarts and confirm the final destination outputs
   before declaring success.

This repository implements and tests that operational lifecycle. It can remain
an external recovery CLI even if Blink's normal in-app transaction construction
uses Breez.

### Economic and protocol regression testing

The [mainnet case study](mainnet-exit-case-study.md) showed why per-leaf
economics matter: a 100,000-sat wallet spread across 22 leaves required 253
packages. At 1 sat/vB, only four leaves containing 90,112 sats were economical;
89,668 sats reached the destination, while 9,888 sats remained as uneconomical
dust and fees consumed the rest. This repository is useful for retaining those
vectors and exercising package relay, timelocks, legacy ancestors, and recovery
resumption independently of a mobile release.

### Independent fallback

An external, reproducible recovery tool is useful when the mobile application,
its embedded SDK version, or its release infrastructure is unavailable. It
also gives SDK changes an independent compatibility and end-to-end test target.

## Security and correctness findings

### 1. CPFP PSBT signing is hardened on this repository's `main`

**Status:** Fixed on `main` by
[blinkbitcoin/spark-unilateral-exit#25](https://github.com/blinkbitcoin/spark-unilateral-exit/pull/25).

The earlier signer trusted each package-supplied PSBT and signed every
non-anchor input. A modified package could therefore spend the dedicated CPFP
funding UTXO into attacker-chosen outputs. The Spark recovery key is separate,
so this did not directly expose the leaf refund, but it could steal the fee
funds and prevent recovery.

[`src/sign.ts`](../src/sign.ts) now validates before reading the key for a
signature. It requires exactly one ephemeral anchor in the parent and child,
binds the child anchor to that parent, verifies every non-anchor input is a
positive witness UTXO owned by the supplied CPFP key, requires exactly one
positive change output back to that key, and rejects a non-positive fee. It
prints the parent, funding, change, and fee summary for every package and
requires explicit interactive approval or `--yes` for trusted automation.

The signer does not impose a numeric maximum fee. The approval summary is the
operator policy boundary; a mobile or unattended integration must also apply
its own fee cap before approving automatically.

### 2. Trusted sweep destination handling is fixed

**Status:** Fixed on `main` by
[blinkbitcoin/spark-unilateral-exit#20](https://github.com/blinkbitcoin/spark-unilateral-exit/pull/20).

The sweep command now requires an explicit destination from a trusted operator
or wallet UI and never falls back to the destination stored in the package
JSON. This prevents a stale or modified recovery artifact from redirecting the
recovered BTC. Any mobile integration should preserve this rule and require the
user to confirm the final address.

### 3. Package-relay response handling is fixed

**Status:** Fixed on `main` by
[blinkbitcoin/spark-unilateral-exit#17](https://github.com/blinkbitcoin/spark-unilateral-exit/pull/17).

Bitcoin Core-compatible package endpoints can return HTTP 200 while reporting
policy rejection in `package_msg` and per-transaction results. The client now
parses that body and surfaces rejection instead of recording a phantom
submission. Blink's broadcaster needs equivalent behavior.

### 4. Pending and alternate refund omissions are mitigated here

**Status:** Mitigated on this repository's `main`; upstream
[buildonspark/spark#146](https://github.com/buildonspark/spark/issues/146)
remains open as of 2026-08-17.

The upstream `constructUnilateralExitFeeBumpPackages` helper can omit a pending
refund after its node transaction confirms, producing a silently incomplete
exit. This repository reattaches/tracks pending refunds, broadcasts them after
their timelocks mature, and fails when required CPFP funding is exhausted
instead of treating an empty package result as completion. Keep the wrapper and
its regression tests until the upstream issue is fixed and the adopted SDK
version is verified.

In addition,
[blinkbitcoin/spark-unilateral-exit#24](https://github.com/blinkbitcoin/spark-unilateral-exit/pull/24)
checks the normal refund, `directFromCpfpRefundTx`, and `directRefundTx` before
retrying the package path. It preserves the exact confirmed terminal refund so
an empty SDK package result cannot strand a sweep after the operator's direct
path won the race.

### 5. Operator direct-path race is only partly resolved

**Status:** Confirmed terminal refunds are reconciled by #24. Detecting and
pivoting while the direct path is still in progress remains open, conflicting,
and changes requested in
[blinkbitcoin/spark-unilateral-exit#18](https://github.com/blinkbitcoin/spark-unilateral-exit/pull/18).

An operator chainwatcher may broadcast the alternative direct exit while this
tool is following the CPFP branch. The two paths conflict, so the CPFP branch
then fails with spent-input errors. Current `main` recognizes all known refund
variants once one is confirmed, but it can still keep retrying the dead CPFP
branch while only the direct transaction is visible or when the relevant chain
lookup fails. This race was observed during a mainnet recovery.

The proposed fix needs to distinguish a known direct-path spend from a merely
unconfirmed dependency and from an unknown spend. It should propagate chain
service errors and have boundary tests before merging.

### 6. Relevant Breez hardening is included in `0.22.0`

**Status:** Fixed in the reviewed release; retain regression coverage during
the Blink upgrade.

The release includes validation that is directly relevant to safe unilateral
exit construction:

- [all CPFP inputs must be finalized](https://github.com/breez/spark-sdk/commit/5cdcb1e1)
  before the SDK extracts the signed transaction,
- CPFP funding, native-SegWit scripts, network/address compatibility, fee
  sufficiency, and dust constraints are checked during quote/build, and
- [timelock and refund sequences are validated](https://github.com/breez/spark-sdk/commit/1e7f1879)
  before wallet state is trusted.

The same release also contains SDK-wide
[deposit-address binding](https://github.com/breez/spark-sdk/commit/748f1819)
and [wire timestamp validation](https://github.com/breez/spark-sdk/commit/0623571b).
This review found no additional known unfixed
unilateral-exit vulnerability in Breez `0.22.0`, but it is an integration
assessment rather than a complete cryptographic or protocol audit. The custom
signer and caller-owned orchestration boundaries below remain important.

### 7. Breez may require a later build call for the final sweep

**Status:** Expected API behavior that Blink's orchestration must handle.

If no refund output is on-chain yet, Breez omits the sweep from the returned
transaction set. After the refund transactions confirm, the caller must invoke
the API again so it can discover those outputs and build the final sweep. Blink
must not interpret the absence of a sweep in an initial response as completion
or as proof that no sweep will be required.

### 8. Breez signer and caller boundaries require defense in depth

Breez constructs the PSBT inside its Rust implementation, supports native
SegWit funding only, and checks that every input returned by the signer is
finalized. Its built-in signer handles a dedicated single P2WPKH or P2TR key.
That is the preferred Blink path.

A custom signer callback should independently verify the expected inputs,
outputs, anchor, fee, network, and destination before signing. Finalization
alone does not prove that an external signer returned the same unsigned
transaction. Use a dedicated CPFP key so a signer-boundary failure cannot spend
general wallet funds, and keep that key in the platform's secure key store.

### 9. Availability is not yet operator-independent in Breez

The phrase "unilateral exit" can otherwise imply a stronger guarantee than the
current Breez API provides. Both `prepareUnilateralExit` and `unilateralExit`
fetch pre-signed state from reachable operators. Blink must not describe the
feature as recovery from a complete Spark outage unless it also implements and
tests the recovery-bundle path.

### 10. Landing the SDK upgrade does not land recovery integration

The README and [mobile integration plan](mobile-integration-plan.md) say the
bundle exporter/client ships in Blink Mobile. At this review point, Blink Mobile
`main` still pins `@breeztech/breez-sdk-spark-react-native` `0.15.0` in
[`package.json`](https://github.com/blinkbitcoin/blink-mobile/blob/main/package.json).

The open, approved #4155 pins to `0.22.0` and adapts existing call sites, but
explicitly leaves unilateral exit unwired. The recovery-bundle stack
([#4016](https://github.com/blinkbitcoin/blink-mobile/pull/4016),
[#4017](https://github.com/blinkbitcoin/blink-mobile/pull/4017), and
[#3911](https://github.com/blinkbitcoin/blink-mobile/pull/3911)) is also open,
and draft #4108 verifies/imports a bundle during an outage but does not build or
broadcast an exit. Treat the integration-plan statements as target architecture,
not deployed behavior, until those application changes land.

## Blink Mobile adoption gates

Blink should use the Breez API behind a feature flag after upgrading the SDK,
subject to these gates:

- Target at least Breez SDK `0.22.0`; it remains the latest release as of
  2026-08-17. Prefer the next release containing the
  post-`0.22.0` fixed-amount Bolt11 mismatch and millisatoshi-rounding fixes
  ([breez/spark-sdk#1057](https://github.com/breez/spark-sdk/pull/1057) and
  [breez/spark-sdk#1056](https://github.com/breez/spark-sdk/pull/1056)), or add
  equivalent app-side guards and tests during the version transition. These
  are general payment correctness fixes, not unilateral-exit defects.
- Keep the rollout disabled by default with a kill switch until mainnet-like
  package relay, restart, and timelock tests pass.
- Show `recoverable_value_sat`, total fees, abandoned leaves, and destination;
  require recoverable value to exceed fees and require explicit confirmation.
- Use a dedicated native-SegWit CPFP funding key stored through the existing
  secure key boundary. Never put the seed or private key in logs, analytics,
  AsyncStorage, command-line arguments, or recovery artifacts.
- Persist the selected leaf IDs and each returned signed transaction set before
  its first broadcast. Derive progress from chain state after every restart,
  and rebuild after refunds confirm to obtain the final sweep when necessary.
- Keep the offline bundle adapter separate from the connected-SDK adapter. A
  failed SDK connection is the exact case where the bundle path must remain
  usable, so the offline path must not require a Breez connection or operator
  call to proceed.
- Submit zero-fee parents and CPFP children as packages, inspect the response
  body, and do not mark success until final destination outputs confirm.
- Enforce dependency confirmations, TRUC 1P1C ordering, CSV maturity, fee caps,
  dust limits, address/network validation, and explicit BTC-only scope.
- If recovery during an operator outage is a product requirement, add
  authenticated, encrypted, atomic recovery-bundle refresh and backup after
  every leaf-changing event. Breez `0.22.0` alone does not meet that
  requirement.

## Recommended long-term ownership

- **Breez SDK:** production quote and transaction construction API, funding
  validation, signer integration, and transaction metadata.
- **Blink Mobile:** user confirmation, secure key custody, feature gating,
  encrypted recovery-state storage, resumable progress, and safe telemetry.
- **This repository:** bundle exporter/format, offline recovery CLI,
  operator-independent fallback, mainnet economics, edge-case regressions, and
  end-to-end package-relay testing.

Do not embed the entire CLI in Blink Mobile. Extract or upstream the narrow
bundle and orchestration interfaces Blink needs, while keeping this repository
usable as an external recovery tool. Its unique role can shrink to a reference
and test suite only after Breez can export/import current leaf state, build with
operators offline, and safely orchestrate broadcast/resume across the same
failure cases.
