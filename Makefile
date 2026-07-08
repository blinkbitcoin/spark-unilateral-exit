NIX ?= nix develop --command
NODE ?= node

BUNDLE ?= ../recovery-bundle.json
PACKAGES ?= recovery-packages.json
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

.PHONY: help refresh-recovery-bundle plan package sign-packages sweep test-e2e \
	cpfp-address watch-cpfp broadcast recover

help:
	@echo "Targets:"
	@echo "  make refresh-recovery-bundle SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json NETWORK=mainnet"
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
	@echo "  make recover      SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json DESTINATION=<bitcoin-address> FEE_RATE=1"
	@echo "                    # recover = cpfp-address + watch-cpfp + package + sign-packages + broadcast in one run"
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
		$(if $(KEY_FILE),--key-file $(KEY_FILE),$(SEED_ARGS) $(ACCOUNT_ARGS)) \
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

# One-shot seed-derived flow: derive the CPFP funding address, wait for the
# operator to fund it, then package, autosign with the same seed, and broadcast
# each package through Esplora. Timelocked refund packages that Esplora rejects
# still need step 7 of docs/recovery-runbook.md after maturity.
recover: require-destination require-seed-file
	@set -e; umask 077; \
	$(NODE) src/cli.ts cpfp-address \
		--bundle $(BUNDLE) $(SEED_ARGS) --network $(NETWORK) \
		--fee-rate $(FEE_RATE) $(ACCOUNT_ARGS); \
	echo "Send at least requiredSats to cpfpAddress above, then leave this running." >&2; \
	watch_json=$$($(NODE) src/cli.ts watch-cpfp \
		--bundle $(BUNDLE) $(SEED_ARGS) --network $(NETWORK) \
		--fee-rate $(FEE_RATE) $(ACCOUNT_ARGS) $(ESPLORA_ARGS)); \
	cpfp_utxo=$$(printf '%s' "$$watch_json" | $(NODE) -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).cpfpUtxo))'); \
	echo "CPFP UTXO confirmed: $$cpfp_utxo" >&2; \
	$(NODE) src/cli.ts package \
		--bundle $(BUNDLE) --destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) --cpfp-utxo "$$cpfp_utxo" > $(PACKAGES); \
	echo "Wrote $(PACKAGES)" >&2; \
	$(NODE) src/cli.ts sign-packages \
		--packages $(PACKAGES) $(SEED_ARGS) $(ACCOUNT_ARGS) \
		--out $(SIGNED_PACKAGES); \
	echo "Wrote $(SIGNED_PACKAGES), broadcasting via Esplora..." >&2; \
	$(NODE) src/cli.ts broadcast \
		--packages $(SIGNED_PACKAGES) --network $(NETWORK) $(ESPLORA_ARGS)

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
	@: $(if $(SEED_FILE)$(KEY_FILE),,$(error SEED_FILE or KEY_FILE is required))

require-seed-file:
	@: $(if $(SEED_FILE),,$(error SEED_FILE is required))
