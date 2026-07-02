# Dejavue — common tasks. Run `make` (or `make help`) for the list.
.DEFAULT_GOAL := help

COMPOSE := docker compose
DB_URL  := postgres://dejavue:dejavue@localhost:5432/dejavue

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install workspace dependencies (pnpm via corepack)
	corepack enable
	pnpm install

.PHONY: env
env: ## Create .env from .env.example if it doesn't exist
	@test -f .env && echo ".env already exists" || (cp .env.example .env && echo "created .env — fill in DISCORD_TOKEN etc.")

.PHONY: setup
setup: install env db-up db-migrate ## First-time setup: install + .env + Postgres + migrations

# ---------------------------------------------------------------------------
# Develop
# ---------------------------------------------------------------------------

.PHONY: dev
dev: ## Everything, one command: Postgres + migrations + bot/worker/web with live reload
	pnpm dev

.PHONY: dev-bot
dev-bot: ## Run only the Discord bot with live reload
	pnpm dev:bot

.PHONY: dev-worker
dev-worker: ## Run the background worker with live reload
	pnpm dev:worker

.PHONY: dev-web
dev-web: ## Run the Astro KB dev server (http://localhost:4321)
	pnpm dev:web

.PHONY: register
register: ## Register Discord slash commands (uses DISCORD_DEV_GUILD_ID if set)
	pnpm --filter @dejavue/bot register

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

.PHONY: db-up
db-up: ## Start Postgres (pgvector) in Docker
	$(COMPOSE) up -d postgres

.PHONY: db-down
db-down: ## Stop the Docker stack
	$(COMPOSE) down

.PHONY: db-migrate
db-migrate: ## Apply database migrations
	pnpm db:migrate

.PHONY: db-generate
db-generate: ## Generate a migration from schema changes (drizzle-kit generate)
	pnpm db:generate

.PHONY: db-verify
db-verify: ## Prove pgvector cosine search works end-to-end
	pnpm db:verify

.PHONY: psql
psql: ## Open a psql shell on the dev database
	$(COMPOSE) exec postgres psql -U dejavue -d dejavue

# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: ## Typecheck every workspace
	pnpm -r --no-bail typecheck

.PHONY: test
test: ## Run the vitest suite
	pnpm -w test

.PHONY: check
check: typecheck test ## Typecheck + tests (run before pushing)

.PHONY: build
build: ## Production-build the Astro web app
	pnpm --filter @dejavue/web build

# ---------------------------------------------------------------------------
# Full Docker stack (Postgres + migrate + bot + worker + web)
# ---------------------------------------------------------------------------

.PHONY: up
up: ## Build + start the full stack in Docker
	$(COMPOSE) up --build -d

.PHONY: down
down: ## Stop the full stack
	$(COMPOSE) down

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Show stack status
	$(COMPOSE) ps

# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build output and the web dist
	rm -rf apps/web/dist apps/web/.astro node_modules/.cache

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
