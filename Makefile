.DEFAULT_GOAL := help
.PHONY: help install build-enforce build-sdk dev demo origin tollgate wayfarer dashboard seed settle test lint clean generate-wallets docker-up docker-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[33m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (+ build the SDK so consumers resolve dist/)
	npm install
	$(MAKE) build-sdk

# The gate and any downstream consumer resolve @naulon/sdk's package exports against
# dist/, so the SDK must be built before lint/test pick up any source change. And
# @naulon/enforce (the toll-decision kernel + in-app middleware, which the gate and a
# publisher's app consume) resolves against enforce/dist too — it imports @naulon/shared,
# which re-exports @naulon/sdk, so enforce must build AFTER the SDK. The SDK does NOT
# depend on enforce, so the order is a plain linear chain (sdk → enforce), no cycle.
build-enforce: ## Build @naulon/enforce (tsc → dist/) — builds after the SDK
	npm run build -w @naulon/enforce

build-sdk: ## Build @naulon/sdk then @naulon/enforce (tsc → dist/), in dependency order
	npm run build -w @naulon/sdk
	npm run build -w @naulon/enforce

dev: ## Run the live stack (stub origin :3000 + tollgate :8402 + dashboard :8403)
	node scripts/dev.mjs

origin: ## Run the stub origin only (publisher stand-in for local gateway tests)
	node scripts/origin.mjs

demo: ## Full loop end to end, offline (origin → toll → pay → settle)
	node scripts/demo.mjs

arc-preflight: ## Read-only settle preflight (USDC domain + wallet funding) for SETTLEMENT_NETWORK
	npx tsx scripts/arc-preflight.mjs

arc-settle: ## LIVE memo settle smoke (SPENDS FUNDS — needs CONFIRM_SPEND=1). Usage: CONFIRM_SPEND=1 make arc-settle
	npx tsx scripts/arc-memo-settle.mjs

tollgate: ## Run the tollgate only
	npm run tollgate

dashboard: ## Run the earnings dashboard only
	npm run dashboard

wayfarer: ## Run the paying agent. Usage: make wayfarer TOPIC="payment and passage"
	npm run wayfarer -- "$(TOPIC)"

seed: ## Seed the ledger with sample crossings
	npm run -w @naulon/dashboard seed

settle: ## Run one attribution settlement pass
	npm run attribution

test: build-sdk ## Run unit tests
	npm test

lint: build-sdk ## Typecheck the whole workspace
	npm run lint

generate-wallets: ## Generate buyer/author wallets for PAYMENT_MODE=gateway
	npm run generate-wallets

clean: ## Remove build output + local ledger data
	rm -rf packages/*/dist data **/*.tsbuildinfo

docker-up: ## Build + run tollgate and dashboard in Docker
	docker compose up --build

docker-down: ## Stop the Docker stack
	docker compose down
