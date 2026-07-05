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

REFRESH_ARGS = \
	$(if $(SEED_FILE),--seed-file $(SEED_FILE),) \
	--network $(NETWORK) \
	--out $(BUNDLE) \
	$(if $(ACCOUNT_NUMBER),--account-number $(ACCOUNT_NUMBER),) \
	$(if $(OPERATOR_SET),--operator-set $(OPERATOR_SET),) \
	$(if $(APP_VERSION),--app-version $(APP_VERSION),)

.PHONY: help refresh-recovery-bundle plan package sign-packages sweep test-e2e

help:
	@echo "Targets:"
	@echo "  make refresh-recovery-bundle SEED_FILE=../spark-seed.txt BUNDLE=../recovery-bundle.json NETWORK=mainnet"
	@echo "  make plan BUNDLE=../recovery-bundle.json DESTINATION=<bitcoin-address> FEE_RATE=1 CPFP_UTXO=<txid:vout:value:script:pubkey>"
	@echo "  make package BUNDLE=../recovery-bundle.json DESTINATION=<bitcoin-address> FEE_RATE=1 CPFP_UTXO=<txid:vout:value:script:pubkey>"
	@echo "  make sign-packages PACKAGES=recovery-packages.json KEY_FILE=cpfp-key.hex"
	@echo "  make sweep PACKAGES=recovery-packages.json SEED_FILE=../spark-seed.txt NETWORK=mainnet DESTINATION=<bitcoin-address> FEE_RATE=1"
	@echo "  make test-e2e   # run the local unilateral-exit E2E against a running Spark stack"
	@echo ""
	@echo "For multiple CPFP inputs, pass CPFP_ARGS='--cpfp-utxo <utxo1> --cpfp-utxo <utxo2>'."

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
	@$(NODE) src/cli.js plan \
		--bundle $(BUNDLE) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(CPFP_ARGS)

package: require-destination require-cpfp-args
	@$(NODE) src/cli.js package \
		--bundle $(BUNDLE) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(CPFP_ARGS)

sign-packages: require-key-file
	@$(NODE) src/cli.js sign-packages \
		--packages $(PACKAGES) \
		--key-file $(KEY_FILE) \
		--out $(SIGNED_PACKAGES)

sweep: require-destination
	@$(NODE) src/cli.js sweep \
		--packages $(PACKAGES) \
		$(if $(SEED_FILE),--seed-file $(SEED_FILE),) \
		--network $(NETWORK) \
		--destination $(DESTINATION) \
		--fee-rate $(FEE_RATE) \
		$(if $(ACCOUNT_NUMBER),--account-number $(ACCOUNT_NUMBER),)

.PHONY: require-destination require-cpfp-args require-key-file

require-destination:
	@: $(if $(DESTINATION),,$(error DESTINATION is required))

require-cpfp-args:
	@: $(if $(CPFP_ARGS),,$(error CPFP_UTXO or CPFP_ARGS is required))

require-key-file:
	@: $(if $(KEY_FILE),,$(error KEY_FILE is required))
