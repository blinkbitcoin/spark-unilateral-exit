NIX ?= nix develop --command
NODE ?= node

BUNDLE ?= ../recovery-bundle.json
PACKAGES ?= recovery-packages.json
# Path to a file holding the Spark seed or mnemonic. Alternatively export the
# SPARK_SEED environment variable (the CLI reads it when no --seed-file is
# passed), which avoids writing the seed to disk.
SEED_FILE ?=
NETWORK ?= mainnet
ACCOUNT_NUMBER ?=
OPERATOR_SET ?=
APP_VERSION ?=

DESTINATION ?=
FEE_RATE ?= 1
CPFP_UTXO ?=
CPFP_ARGS ?= $(if $(CPFP_UTXO),--cpfp-utxo $(CPFP_UTXO),)
KEY_FILE ?=
SIGNED_PACKAGES ?= recovery-packages-signed.json
ESPLORA_URL ?=
ESPLORA_ARGS ?= $(if $(ESPLORA_URL),--esplora-url $(ESPLORA_URL),)

SEED_ARGS = $(if $(SEED_FILE),--seed-file $(SEED_FILE),)
ACCOUNT_ARGS = $(if $(ACCOUNT_NUMBER),--account-number $(ACCOUNT_NUMBER),)

REFRESH_ARGS = \
	$(if $(SEED_FILE),--seed-file $(SEED_FILE),) \
	--network $(NETWORK) \
	--out $(BUNDLE) \
	$(if $(ACCOUNT_NUMBER),--account-number $(ACCOUNT_NUMBER),) \
	$(if $(OPERATOR_SET),--operator-set $(OPERATOR_SET),) \
	$(if $(APP_VERSION),--app-version $(APP_VERSION),)

MULTIPLICITY ?=
DRY_RUN ?=
MAX_ROUNDS ?=
NO_REFRESH ?=
NO_CONSOLIDATE ?=

.PHONY: help refresh-recovery-bundle consolidate plan package sign-packages sweep \
	test-e2e cpfp-address watch-cpfp broadcast recover

help:
	@echo "Targets:"
	@echo "  make refresh-recovery-bundle SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json NETWORK=mainnet"
	@echo "  make consolidate SEED_FILE=../spark-seed.txt NETWORK=mainnet [DRY_RUN=1] [MULTIPLICITY=0]"
	@echo "                    # swap small leaves with the SSP into the fewest denominations so fewer"
	@echo "                    # leaves are uneconomical to exit; refresh the recovery bundle afterwards"
	@echo "  make plan BUNDLE=../recovery-bundle.json DESTINATION=<bitcoin-address> FEE_RATE=1 CPFP_UTXO=<txid:vout:value:script:pubkey>"
	@echo "  make package BUNDLE=../recovery-bundle.json DESTINATION=<bitcoin-address> FEE_RATE=1 CPFP_UTXO=<txid:vout:value:script:pubkey>"
	@echo "  make sign-packages PACKAGES=recovery-packages.json SEED_FILE=../spark-seed.txt   # or KEY_FILE=cpfp-key.hex"
	@echo "  make sweep PACKAGES=recovery-packages.json SEED_FILE=../spark-seed.txt NETWORK=mainnet DESTINATION=<bitcoin-address> FEE_RATE=1"
	@echo "  make test-e2e   # run the local unilateral-exit E2E against a running Spark stack"
	@echo ""
	@echo "Seed-derived simple flow (fund -> package -> autosign -> Esplora broadcast):"
	@echo "  make cpfp-address SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json FEE_RATE=1"
	@echo "  make watch-cpfp   SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json FEE_RATE=1"
	@echo "  make broadcast    SIGNED_PACKAGES=recovery-packages-signed.json NETWORK=mainnet"
	@echo "  make recover      SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json FEE_RATE=1"
	@echo "                    # auto-exit: first consolidates leaves and refreshes the bundle when operators"
	@echo "                    # are reachable (best effort; NO_REFRESH=1 / NO_CONSOLIDATE=1 to skip), then"
	@echo "                    # waits for funding, packages, signs, submits, and waits for confirmations"
	@echo "                    # round by round; skips uneconomical leaves (INCLUDE_UNECONOMICAL=1 to keep"
	@echo "                    # them); FAN_OUT=1 broadcasts leaves in parallel; safe to re-run anytime"
	@echo ""
	@echo "For multiple CPFP inputs, pass CPFP_ARGS='--cpfp-utxo <utxo1> --cpfp-utxo <utxo2>'."
	@echo "For a self-hosted Esplora (required on regtest), pass ESPLORA_URL=<url>."

test-e2e:
	@./scripts/run-e2e.sh

refresh-recovery-bundle:
	@if [ -f "$(BUNDLE)" ]; then \
		bundle="$(BUNDLE)"; \
		timestamp="$$(date -u +%Y%m%dT%H%M%SZ)"; \
		case "$$bundle" in \
			*.json) backup="$${bundle%.json}.$$timestamp.backup.json" ;; \
			*) backup="$$bundle.$$timestamp.backup.json" ;; \
		esac; \
		cp -p "$$bundle" "$$backup"; \
		echo "Saved existing bundle to $$backup"; \
	fi
	@$(NIX) cargo run --manifest-path tools/spark-recovery-bundle/Cargo.toml -- $(REFRESH_ARGS)

# Cooperative leaf consolidation (not an exit): swaps small leaves with the
# SSP into the unilateral-exit-optimal denomination set so fewer leaves are
# uneconomical to exit. Spends the current leaves, so refresh the recovery
# bundle afterwards. DRY_RUN=1 reports the plan without swapping.
consolidate: require-seed-file
	@$(NODE) src/cli.ts consolidate \
		$(SEED_ARGS) \
		--network $(NETWORK) \
		$(ACCOUNT_ARGS) \
		$(if $(MULTIPLICITY),--multiplicity $(MULTIPLICITY),) \
		$(if $(MAX_ROUNDS),--max-rounds $(MAX_ROUNDS),) \
		$(if $(DRY_RUN),--dry-run,)

plan: require-destination require-cpfp-args
	@$(NODE) src/cli.ts plan \
		--bundle $(BUNDLE) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(CPFP_ARGS)

package: require-destination require-cpfp-args
	@$(NODE) src/cli.ts package \
		--bundle $(BUNDLE) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(CPFP_ARGS)

sign-packages: require-signing-key
	@$(NODE) src/cli.ts sign-packages \
		--packages $(PACKAGES) \
		$(if $(KEY_FILE),--key-file $(KEY_FILE),$(SEED_ARGS) --network $(NETWORK) $(ACCOUNT_ARGS)) \
		--out $(SIGNED_PACKAGES)

cpfp-address:
	@$(NODE) src/cli.ts cpfp-address \
		--bundle $(BUNDLE) \
		$(SEED_ARGS) \
		--network $(NETWORK) \
		--fee-rate $(FEE_RATE) \
		$(ACCOUNT_ARGS)

watch-cpfp:
	@$(NODE) src/cli.ts watch-cpfp \
		--bundle $(BUNDLE) \
		$(SEED_ARGS) \
		--network $(NETWORK) \
		--fee-rate $(FEE_RATE) \
		$(ACCOUNT_ARGS) \
		$(ESPLORA_ARGS)

broadcast:
	@$(NODE) src/cli.ts broadcast \
		--packages $(SIGNED_PACKAGES) \
		--network $(NETWORK) \
		$(ESPLORA_ARGS)

# One-shot seed-derived flow. While operators are reachable it first
# consolidates leaves into the exit-optimal denominations and refreshes the
# bundle (both best effort: skipped with a note when operators or the SSP are
# offline, or when resuming a partial recovery; NO_REFRESH=1 / NO_CONSOLIDATE=1
# to opt out). Then it waits for funding at the derived CPFP address, packages,
# autosigns, submits, and waits for confirmations round by round until every
# economical leaf is broadcast or waiting on its refund timelock. Safe to
# interrupt and re-run; it resumes from chain state.
# Uneconomical leaves are skipped unless INCLUDE_UNECONOMICAL=1.
# FAN_OUT=1 splits funding into one UTXO per leaf to broadcast in parallel.
recover: require-seed-file
	@$(NODE) src/cli.ts auto-exit \
		--bundle $(BUNDLE) \
		$(SEED_ARGS) \
		--network $(NETWORK) \
		--fee-rate $(FEE_RATE) \
		$(ACCOUNT_ARGS) \
		$(ESPLORA_ARGS) \
		$(if $(INCLUDE_UNECONOMICAL),--include-uneconomical,) \
		$(if $(MIN_NET_SATS),--min-net-sats $(MIN_NET_SATS),) \
		$(if $(FAN_OUT),--fan-out,) \
		$(if $(NO_REFRESH),--no-refresh,) \
		$(if $(NO_CONSOLIDATE),--no-consolidate,) \
		--out $(PACKAGES)

sweep: require-destination
	@$(NODE) src/cli.ts sweep \
		--packages $(PACKAGES) \
		$(if $(SEED_FILE),--seed-file $(SEED_FILE),) \
		--network $(NETWORK) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(if $(ACCOUNT_NUMBER),--account-number $(ACCOUNT_NUMBER),)

.PHONY: require-destination require-cpfp-args require-signing-key require-seed-file

require-destination:
	@: $(if $(DESTINATION),,$(error DESTINATION is required))

require-cpfp-args:
	@: $(if $(CPFP_ARGS),,$(error CPFP_UTXO or CPFP_ARGS is required))

require-signing-key:
	@: $(if $(SEED_FILE)$(KEY_FILE)$(SPARK_SEED),,$(error SEED_FILE, KEY_FILE, or the SPARK_SEED environment variable is required))

require-seed-file:
	@: $(if $(SEED_FILE)$(SPARK_SEED),,$(error SEED_FILE or the SPARK_SEED environment variable is required))
