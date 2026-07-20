.DEFAULT_GOAL := help
.PHONY: help install build-shared build-enforce build-wayfarer build-sdk dev demo origin tollgate wayfarer dashboard seed settle test lint clean generate-wallets docker-up docker-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[33m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (+ build the SDK so consumers resolve dist/)
	npm install
	$(MAKE) build-sdk

# The gate and any downstream consumer (incl. a non-tsx publisher app) resolve the
# @naulon/{sdk,shared,enforce} package exports against dist/, so these three must be
# built before lint/test pick up any source change. The dependency order is a plain
# linear chain, no cycle: @naulon/shared re-exports @naulon/sdk (so sdk builds first),
# and @naulon/enforce imports @naulon/shared (so enforce builds last) — sdk → shared →
# enforce. shared ships dist/ (not raw src) precisely so enforce/dist resolves it in a
# plain-node consumer, not only under tsx.
#
# wayfarer + wayfarer-mcp are published too, so they are dist-pointed on the same
# pattern and extend the same linear chain: sdk → shared → enforce → wayfarer →
# wayfarer-mcp (wayfarer-mcp imports @naulon/wayfarer, so wayfarer builds first).
build-shared: ## Build @naulon/shared (tsc → dist/) — builds after the SDK
	npm run build -w @naulon/shared

build-enforce: ## Build @naulon/enforce (tsc → dist/) — builds after shared
	npm run build -w @naulon/enforce

build-wayfarer: ## Build @naulon/wayfarer → wayfarer-mcp (tsc → dist/) — builds after enforce
	npm run build -w @naulon/wayfarer
	npm run build -w @naulon/wayfarer-mcp

build-sdk: ## Build every published package (tsc → dist/), in dependency order
	npm run build -w @naulon/sdk
	npm run build -w @naulon/shared
	npm run build -w @naulon/enforce
	$(MAKE) build-wayfarer

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
