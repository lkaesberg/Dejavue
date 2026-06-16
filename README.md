# Dejavue

A Discord bot that watches Q&A **forum channels**, detects duplicate questions, drives a
mark-solved workflow, and turns solved threads into a searchable knowledge base — including a
public, SEO-indexable web KB. Monetized per-server through Discord Premium Apps (Free / Plus / Pro).

See the full design in [the implementation plan](./docs/PLAN.md) (mirrored from the approved plan).

## Stack

- **TypeScript** + **discord.js v14**
- **Postgres + pgvector** (Drizzle ORM)
- **Local CPU embeddings** via Transformers.js (`bge-small-en-v1.5`, 384-dim)
- **DeepSeek V4 Pro via OpenRouter** for generative features
- **pg-boss** for background jobs (Postgres-backed; no Redis)
- **Astro SSR** for the public web KB (subdomain multi-tenant on `dejavue.app`)

## Monorepo

```
packages/core   shared types, env config, tier/entitlement logic
packages/db     Drizzle schema + migrations (pgvector) + repositories
packages/ai     embeddings + OpenRouter LLM client
apps/bot        discord.js gateway client
apps/worker     pg-boss jobs
apps/web        Astro public knowledge base
```

## Quick start (dev)

```bash
# 1. install (pnpm via corepack)
corepack enable        # or: corepack pnpm install
pnpm install

# 2. start Postgres (pinned pgvector image)
pnpm db:up

# 3. run migrations (creates the vector extension + HNSW index)
pnpm db:migrate

# 4. verify pgvector end-to-end (insert + cosine search)
pnpm db:verify
```

Then copy `.env.example` → `.env` and fill in Discord + OpenRouter credentials to run the bot/worker/web.

## Run the whole stack with Docker

```bash
cp .env.example .env   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, OPENROUTER_API_KEY
docker compose up --build
```

Brings up everything with one command: Postgres (pinned pgvector) → a one-shot
`migrate` → **bot**, **worker**, and the **web KB** (http://localhost:4321). The
apps read credentials from `.env`; `DATABASE_URL` is overridden to the `postgres`
service automatically, and the CPU embedding model is cached in a named volume so
it isn't re-downloaded on restart. Slash commands still need a one-time
`pnpm --filter @dejavue/bot register` (after inviting the bot with the
`applications.commands` scope).
