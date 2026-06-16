# Dejavue

**Dejavue** is a Discord bot for help/Q&A **forum channels**. It catches duplicate questions the
moment they're posted, drives a clean *mark-solved* workflow, and turns every solved thread into a
searchable archive — inside Discord, on a public SEO knowledge base, and (on the top tier) as an
**MCP server** your AI tools can query.

It's monetized per-server through **Discord Premium Apps**, with pricing aligned to cost: keyword
features are free, semantic search anchors the mid tier, and generative AI lives behind a quota up top.

---

## How it works

1. **Someone posts** in a monitored forum → Dejavue debounces, reads the question, and checks for
   duplicates (keyword on Free, semantic on Plus+). If it finds similar solved posts, it replies with
   the matches — plus, on Pro/Max, an **AI-drafted answer**.
2. The asker (or a helper) resolves it: click **Mark as solved** (which opens a modal so an answer is
   always captured), right-click the helpful reply → **Apps → Mark as Answer**, or hit
   **Use top answer & close** on the duplicate suggestion to borrow a previous answer.
3. On solve, Dejavue swaps the `unsolved` → `solved` tag, stores the **accepted answer + full
   transcript**, embeds it for semantic search, (Pro/Max) writes a clean **AI summary**, and — if the
   guild opted in — **publishes it to the public KB**.
4. Members find answers with `/dejavue search`; admins watch `/dejavue analytics`, `gaps`, and `faq`.

Only the **original poster, a moderator, or an admin** can resolve a thread.

---

## Features

**Duplicate detection & search**
- Keyword (Free) or **semantic** (Plus+) duplicate detection on new posts, debounced with a
  starter-message retry + `messageCreate` fallback so it never misses the question text.
- `/dejavue search` over the solved-answer archive (keyword → semantic by tier).
- "Use top answer & close" borrows a matched answer, posts it, and marks the post solved + duplicate.

**Solving & archive**
- Button + modal + message context menu + slash command, all permission-gated to OP/mod/admin.
- Per-forum `solved` / `unsolved` tag automation (created automatically on setup).
- Full thread **transcript** captured on solve (privacy-aliased speakers on the public KB).

**AI (Pro / Max, quota-metered via OpenRouter → DeepSeek V4 Pro)**
- **Answer drafting** from past solved threads when a duplicate is found.
- **Thread summarization** into a canonical KB answer.
- **Knowledge-gap clustering** — groups recurring questions so you know what docs to write.
- **Auto-FAQ** generation/maintenance (respects manual edits).

**Public web knowledge base**
- Per-guild **subdomain** (`{slug}.dejavue.app`) or your own **custom domain** (one-time purchase).
- Each monitored **channel becomes its own category**; pages show the answer + full discussion.
- `QAPage` / `FAQPage` JSON-LD, DB-driven sitemap, near-zero-JS pages for SEO.
- Opt-in per guild (default off); usernames aliased ("Original poster" / "Helper N").

**MCP server (Max)**
- Each Max guild exposes its KB as a **Streamable HTTP MCP server** at `{slug}.dejavue.app/mcp`
  with a `search_knowledge_base` tool — add it to Claude or any MCP client to let your AI answer
  from the community's solved questions.

**Ops**
- Analytics: resolution rate, time-to-resolution, top helpers (Plus+).
- Stale-question **nudges** that ping a helper role on a timer (Plus+).
- **Backfill** one-time purchase: import a forum's entire history into the archive.

---

## Tiers

Billed per-server via Discord Premium Apps (prices are suggestions — set the real amounts on your SKUs).

| | **Free** | **Plus** ~$4.99 | **Pro** ~$9.99 | **Max** ~$24.99 |
|---|---|---|---|---|
| Forum channels | 1 | 3 | 5 | unlimited |
| Duplicate detection / search | keyword | semantic | semantic + AI draft | semantic + AI draft |
| Mark-solved + archive | ✓ (≤500) | ✓ (≤1,500) | ✓ (≤2,500) | ✓ unlimited |
| Stale-question nudges | — | ✓ | ✓ | ✓ |
| Analytics | basic counts | full | full | full |
| AI summary / clustering / auto-FAQ | — | — | ✓ | ✓ |
| AI generation quota / mo | — | — | ~300 | ~1,500 |
| Public KB pages | 10 | 100 | 500 | unlimited |
| KB answer rendering | raw | raw | AI-summarized | AI-summarized |
| **MCP server** | — | — | — | **✓** |
| "Powered by Dejavue" branding | shown | removed | removed | removed |

**One-time purchases** (any tier): **Backfill** (import existing forum history) · **Custom domain**
(serve the KB on your own domain) · **Top-up** (extra AI generations, consumable).

---

## Commands

`/dejavue` (slash) + a **Mark as Answer** message context menu.

| Subcommand | What it does | Who |
|---|---|---|
| `setup <forum>` | Monitor a forum channel; ensures solved/unsolved tags | admin |
| `status` | Full config: tier, channels, KB/MCP URLs, quota, custom domain | admin |
| `config` | Quick configuration summary | anyone |
| `search <query>` | Search the solved-answer archive | anyone |
| `stats` | Solved/unsolved counts (+ quota on Pro+) | anyone |
| `analytics` | Resolution rate, top helpers, most-asked (Plus+) | anyone |
| `gaps` | Recurring unanswered-question clusters (Pro+) | anyone |
| `faq` | Auto-generated FAQ (Pro+) | anyone |
| `nudges [enabled] [hours] [role]` | Configure stale-question pings (Plus+) | admin |
| `solved` | Mark the current post solved (opens the answer modal) | OP/mod/admin |
| `kb [slug] [publish]` | Configure the public KB subdomain + publishing | admin |
| `domain [host]` | Set a custom domain (one-time purchase) | admin |
| `backfill <forum>` | Import a forum's history (one-time purchase) | admin |
| `demo` | Create an example forum with sample Q&A to try it out | admin |
| `help` | Overview | anyone |

---

## Architecture

**Stack:** TypeScript · discord.js v14 · Postgres + pgvector (Drizzle) · local CPU embeddings
(Transformers.js, `bge-small-en-v1.5`, 384-dim) · DeepSeek V4 Pro via OpenRouter · pg-boss
(Postgres-backed jobs, no Redis) · Astro SSR (public KB + MCP).

```
packages/core   shared types, env, tier/entitlement logic, clustering
packages/db     Drizzle schema + migrations (pgvector) + repositories
packages/ai     embeddings (Transformers.js) + OpenRouter LLM client
packages/queue  pg-boss queues + job definitions
apps/bot        discord.js gateway client (commands, events, interactions)
apps/worker     pg-boss jobs (embed, summarize, cluster, FAQ, nudge, backfill, reconcile)
apps/web        Astro SSR — public KB (subdomain/custom-domain) + /mcp endpoint
```

The **bot** does live query-embedding + interactions; the **worker** does heavy/scheduled work; they
coordinate only through pg-boss + Postgres. Tier is derived purely from Discord entitlements (with an
hourly LIST reconcile + per-process cache) and gates every feature.

---

## Quick start

```bash
corepack enable                  # provides pnpm (pinned in package.json)
pnpm install
pnpm db:up                       # Postgres (pinned pgvector/pgvector:pg16)
pnpm db:migrate                  # extension + tables + HNSW index
pnpm db:verify                   # proves pgvector cosine search works
```

Then fill in `.env` (copy from `.env.example`) and run the services:

```bash
pnpm dev:bot                     # gateway client      (needs DISCORD_TOKEN)
pnpm dev:worker                  # background jobs
pnpm dev:web                     # Astro KB + MCP      (http://localhost:4321)
```

**Or the whole stack in one command:**

```bash
cp .env.example .env             # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, OPENROUTER_API_KEY
docker compose up --build        # Postgres → migrate → bot + worker + web
```

`DATABASE_URL` is auto-pointed at the `postgres` service; the CPU embedding model is cached in a
named volume. Set `DEV_FORCE_TIER=max` in `.env` to exercise every feature locally without real SKUs.

---

## Discord setup (to go live)

1. **Bot → Privileged Gateway Intents:** enable **Message Content** (only). Leave Presence + Server
   Members off.
2. **OAuth2 → URL Generator:** scopes **`bot`** + **`applications.commands`**; permissions: View
   Channels, Send Messages, Create Public Threads, Send Messages in Threads, Manage Threads, Manage
   Channels, Embed Links, Read Message History. Open the generated URL to add the bot.
3. **Register commands:** `pnpm --filter @dejavue/bot register` (uses `DISCORD_DEV_GUILD_ID` for
   instant guild commands, or registers globally if unset).
4. **Enable Monetization** and create SKUs in the developer portal, then put their ids in `.env`:
   - Guild subscriptions: `SKU_PLUS`, `SKU_PRO`, `SKU_MAX`
   - Durable one-time: `SKU_BACKFILL`, `SKU_CUSTOM_DOMAIN`
   - Consumable one-time: `SKU_TOPUP`
5. **KB domains:** point `*.dejavue.app` (wildcard DNS + TLS) at the web app. `.app` is HSTS-preloaded,
   so HTTPS is mandatory — the wildcard cert must cover `*.dejavue.app`. Custom domains CNAME to the
   same host (provision per-domain TLS / on-demand certs).

### Key env vars

`DATABASE_URL` · `DISCORD_TOKEN` · `DISCORD_CLIENT_ID` · `DISCORD_DEV_GUILD_ID` ·
`OPENROUTER_API_KEY` · `OPENROUTER_MODEL` (default `deepseek/deepseek-v4-pro`) ·
`EMBEDDING_MODEL` (default `bge-small-en-v1.5`) · `KB_BASE_DOMAIN` (default `dejavue.app`) ·
`PRO_MONTHLY_QUOTA` (default 300) · the `SKU_*` ids · `DEV_FORCE_TIER` (dev only).

---

## Using the MCP server (Max)

Once a Max guild has set a KB slug and opted in, its knowledge base is queryable at
`https://{slug}.dejavue.app/mcp`. Add it to an AI client as a **Streamable HTTP** MCP server; it
exposes one tool:

```
search_knowledge_base(query: string, limit?: number)  → relevant solved Q&As with source links
```

---

See [docs/PLAN.md](./docs/PLAN.md) for the full design rationale and milestone history.
