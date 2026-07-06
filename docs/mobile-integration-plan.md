# App Integration Plan

**Status:** Proposed integration boundary
**Updated:** 2026-06-22

## Decision

Wallet apps should keep unilateral-exit protocol logic outside UI code. The app
boundary should orchestrate recovery state, encrypted backup storage, user
confirmation, and broadcast progress. Spark leaf export, ancestor export,
transaction/package construction, timelock interpretation, fee-bump package
generation, signing, and broadcast ordering should stay in SDK or recovery
tooling code with focused tests.

The preferred production boundary is:

```text
Wallet app UI and orchestration
  -> Spark SDK or narrow recovery adapter
    -> SDK/tooling-owned Spark exit and recovery-bundle logic
      -> Chain data and transaction/package broadcast service
```

This repo is the reference for the bundle-first recovery model, package
planning, offline package construction, test vectors, and operator/user
recovery procedures. Apps should consume that model through a narrow adapter and
save a fresh encrypted recovery bundle while Spark operators are online.

## Core Model

Apps must not rely on seed-only unilateral recovery. A Spark seed can derive
user keys, but current leaves and ancestor data normally come from Spark
operators. If operators are already unavailable and the app did not save a
fresh recovery bundle, the recovery path may not know what to exit.

The integration target is therefore:

1. Keep an encrypted recovery bundle fresh during normal app operation.
2. Store only non-secret recovery metadata in app state.
3. Use the bundle, a destination Bitcoin address, fee rate, and CPFP fee inputs
   to plan/package unilateral exits.
4. Broadcast packages in root-to-leaf order through a chain service.
5. Resume progress after app restart without exposing seed material or private
   keys outside the existing wallet/SDK boundary.

## App Boundary

Navigation, screens, persistent UI state, feature flags, analytics, i18n, and
release gates are app concerns. Transaction/package construction, Spark leaf and
ancestor handling, timelock checks, CPFP planning, signing, and broadcast order
should be supplied by SDK/tooling code.

Use app code for:

- screen state,
- calls into SDK/tooling adapters,
- user confirmations,
- error mapping,
- i18n,
- telemetry with safe metadata,
- feature gating, and
- progress display.

Do not use app-local UI code for:

- reconstructing Spark transaction chains,
- interpreting refund timelocks,
- signing exit or CPFP transactions,
- deciding package broadcast order, or
- rewriting bundle protobuf data.

## Adapter Shape

Expose a narrow adapter to the app, regardless of whether the implementation is
provided directly by an SDK, this repo's tooling, or a future upstream recovery
API.

Suggested app-facing states:

- `notReady`
- `bundleStale`
- `noRecoverableLeaves`
- `waitingForTimelock`
- `needsFeeInput`
- `readyToPlan`
- `planned`
- `packaging`
- `readyToBroadcast`
- `broadcasting`
- `complete`
- `failed`

The adapter should return typed, user-safe failure classes:

- `bundle-invalid`
- `bundle-stale`
- `bundle-seed-mismatch`
- `timelock-not-expired`
- `fee-input-missing`
- `fee-input-insufficient`
- `package-construction-failed`
- `broadcast-rejected`
- `chain-service-unavailable`
- `sdk-internal-error`

## Bundle Refresh

Apps should refresh the encrypted recovery bundle when any event can change the
user's Spark leaves or ancestors:

- wallet startup after SDK sync,
- deposit claim,
- incoming Spark transfer,
- outgoing Spark transfer,
- swap or withdrawal,
- receive flow completion,
- leaf optimization,
- token/output sync if token support is added, and
- periodic app lifecycle refresh as a fallback.

The bundle should be encrypted before writing to local user-visible storage,
cloud backup targets, or any backend storage. Treat it as sensitive metadata
even though it should not contain private keys.

## CPFP Fee Funding Strategy

The unilateral exit flow requires a Bitcoin UTXO to pay fees via CPFP (child
pays for parent). The SDK chains this UTXO automatically — one initial UTXO
feeds all packages via change outputs, so the user does not need to provide a
separate UTXO per leaf.

### Recommended: Seed-derived CPFP funding key

The CPFP funding key is derived deterministically from the wallet seed at BIP32
purpose `8797556'` (one above the Spark wallet purpose `8797555'`), producing a
dedicated P2WPKH funding address. Deriving from the seed — rather than generating
and separately storing a keypair — means there is no extra key to back up: the
same seed that owns the wallet reproduces the funding key on demand. It never
collides with Spark's own keys or a standard BIP44/49/84/86 wallet on the seed.
The `cpfp-address`, `watch-cpfp`, and `sign-packages` commands all use this
derivation (see `deriveCpfpFundingKey` in `src/cpfp-funding.js`).

Recovery flow:

1. App detects recovery is needed (operators unreachable, user-triggered).
2. App derives the funding address and required amount (`cpfp-address`) and
   prompts the user to fund it with a small on-chain amount (e.g. send from an
   exchange, another wallet, or Blink's own on-chain balance if available).
3. App watches the funding address (`watch-cpfp`) and, once a sufficiently
   funded UTXO confirms, constructs all exit packages using the recovery bundle
   and that UTXO.
4. App signs all CPFP PSBTs in-process using `signPackages()` from
   `src/sign.js`, re-deriving the funding key from the seed — no external
   wallet, key file, or Bitcoin Core node needed.
5. App broadcasts signed packages sequentially via Esplora
   (`POST /txs/package`).
6. App polls for confirmations and timelock maturity.
7. App constructs and broadcasts sweep transactions to the destination.

The CPFP key holds only fee funds (not recovered funds), so the risk profile
is low. The signing code is ~30 lines using `@scure/btc-signer` which the
Spark SDK already depends on.

### Alternative: Backend fee-sponsor service

Blink runs a service with a hot wallet that signs CPFP PSBTs on behalf of
users. The app sends unsigned packages, the backend signs and returns them.

Pro: user does not need any on-chain Bitcoin to start recovery.
Con: adds a backend dependency to a recovery flow designed for operator
outage scenarios. If Blink's backend is also unavailable, this path fails.

### Alternative: Pre-funded custodial CPFP pool

Blink pre-funds a pool of UTXOs for emergency exits. When a user triggers
recovery, the backend allocates a UTXO and handles signing/broadcasting.

Pro: fully turnkey for the user.
Con: same centralization concern as the backend sponsor.

### Recommendation

Use the app-managed CPFP hot key for the primary flow. It works without any
backend, aligns with the self-sovereign recovery model, and the implementation
is straightforward (the E2E test demonstrates the complete flow). Consider the
backend fee-sponsor as an optional convenience layer for users who cannot
source an on-chain UTXO independently.

## Release Gate

Before enabling in-app broadcast, define and test the chain-service boundary for
fee-rate lookup, CPFP UTXO discovery or validation, package broadcast, policy
errors, confirmation polling, reorg handling, and retry/idempotency behavior.

If those pieces are not ready, phase one should support bundle refresh and
support-assisted/export recovery only, not in-app broadcast.

## Current Validation Status

This is a planning document. Current repo validation remains the CLI/unit/E2E
coverage described in `README.md` and `docs/withdraw-guide.md`.
