# Dejavue

**Dejavue** is a Discord bot for help/Q&A **forum channels**. It catches duplicate questions the
moment they're posted, drives a clean *mark-solved* workflow, and turns every solved thread into a
searchable archive — inside Discord, on a public, SEO-friendly website, and (on the top tier) as an
**MCP server** your AI tools can query.

It's monetized per-server through **Discord Premium Apps**, with pricing aligned to cost: keyword
features are free, semantic search anchors the mid tier, and generative AI is metered in **AI credits**
(1 credit = 1,000 tokens) — a small taster budget on Plus, serious budgets on Pro/Max.

---

## How it works

1. **Someone posts** in a monitored forum → Dejavue debounces, reads the question, and checks for
   duplicates (keyword on Free, semantic on Plus+). If it finds similar solved posts, it replies with
   the matches — plus, on Plus and up, an **AI-drafted answer** (credit-metered).
2. The asker (or a helper) resolves it: click **Mark as solved** (which opens a modal so an answer is
   always captured), right-click the helpful reply → **Apps → Mark as Answer**, or hit
   **Use top answer & close** on the duplicate suggestion to borrow a previous answer.
3. On solve, Dejavue swaps the `unsolved` → `solved` tag, stores the **accepted answer + full
   transcript**, embeds it for semantic search, (Pro/Max) writes a clean **AI summary**, and — if the
   guild opted in — **publishes it to the public website**.
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
- Full thread **transcript** captured on solve (privacy-aliased speakers on the public website).

**AI (credit-metered via OpenRouter → DeepSeek V4 Pro; drafts on Plus+, full suite on Pro/Max)**
- **Answer drafting** from past solved threads when a duplicate is found.
- **Thread summarization** into a clean, canonical answer for the public website.
- **Knowledge-gap clustering** — groups recurring questions so you know what docs to write.
- **Auto-FAQ** generation/maintenance (respects manual edits).

**Public website**
- Per-guild **subdomain** (`{slug}.dejavue.app`) or your own **custom domain** (one-time purchase).
- Each monitored **channel becomes its own category**; pages show the answer + full discussion.
- `QAPage` / `FAQPage` JSON-LD, DB-driven sitemap, near-zero-JS pages for SEO.
- Opt-in per guild (default off); usernames aliased ("Original poster" / "Helper N").

**MCP server (Max)**
- Each Max guild exposes its published answers as a **Streamable HTTP MCP server** at `{slug}.dejavue.app/mcp`
  with a `search_knowledge_base` tool — add it to Claude or any MCP client to let your AI answer
  from the community's solved questions.

**Ops**
- Analytics: resolution rate, time-to-resolution, top helpers (Plus+).
- Stale-question **nudges** that ping a helper role on a timer (Plus+).
- **Backfill**: import a forum's entire history into the archive — included, up to your tier's indexed-message limit.

---

## Tiers

Billed per-server via Discord Premium Apps.

AI usage is metered in **AI credits** (1 credit = 1,000 model tokens, input + output). Each drafted
answer costs ≈ 0.8 credits and each thread summary ≈ 3, so the quotas below translate to roughly
"drafts per month" at 1.25× the credit number. Everything indexed counts against one **indexed
messages** ceiling (there is no separate archive/website-page cap); public website pages themselves are
unlimited, gated only by the per-guild publish opt-in + optional passphrase.

| | **Free** | **Plus** €4.99 | **Pro** €9.99 | **Max** €24.99 |
|---|---|---|---|---|
| Forum channels | 1 | 5 | 10 | unlimited |
| Tracked (non-forum) channels | 1 | 5 | 15 | unlimited |
| Indexed messages | 500 | 5,000 | 50,000 | unlimited |
| Duplicate detection / search | keyword | semantic | semantic | semantic |
| AI-drafted answers on duplicates | — | ✓ (taster) | ✓ | ✓ |
| AI summary / clustering / auto-FAQ | — | — | ✓ | ✓ |
| **AI credits / mo** | — | **25** | **1,000** | **5,000** |
| Stale-question nudges | — | ✓ | ✓ | ✓ |
| Analytics | basic counts | full | full | full |
| Website page rendering | raw | raw | AI-summarized | AI-summarized |
| **MCP server** | — | — | — | **✓** (30 req/min) |
| "Powered by Dejavue" branding | shown | removed | removed | removed |

**One-time purchases** (any tier): **Custom domain — €29.99** (serve your public website on your own
domain) · **Top-up — €1.99** (**+250 AI credits**, consumable, stacks, never expires). Importing
existing forum history is included — setup reindexes past threads up to the tier's indexed-message limit.

---

## Commands

`/dejavue` (slash) + a **Mark as Answer** message context menu.

| Subcommand | What it does | Who |
|---|---|---|
| `setup <forum>` | Monitor a forum channel; ensures solved/unsolved tags | admin |
| `status` | Full config: tier, channels, website/MCP URLs, quota, custom domain | admin |
| `config` | Quick configuration summary | anyone |
| `search <query>` | Search the solved-answer archive | anyone |
| `stats` | Solved/unsolved counts (+ quota on Pro+) | anyone |
| `analytics` | Resolution rate, top helpers, most-asked (Plus+) | anyone |
| `gaps` | Recurring unanswered-question clusters (Pro+) | anyone |
| `faq` | Auto-generated FAQ (Pro+) | anyone |
| `nudges [enabled] [hours] [role]` | Configure stale-question pings (Plus+) | admin |
| `solved` | Mark the current post solved (opens the answer modal) | OP/mod/admin |
| `kb [slug] [publish]` | Configure the public website (subdomain + publishing) | admin |
| `domain [host]` | Set a custom domain (one-time purchase) | admin |
| `backfill <forum>` | Import a forum's history (included, up to your tier's limit) | admin |
| `demo` | Create an example forum with sample Q&A to try it out | admin |
| `help` | Overview | anyone |

---

## Architecture

**Stack:** TypeScript · discord.js v14 · Postgres + pgvector (Drizzle) · pluggable embeddings
(self-host CPU via Transformers.js `bge-small-en-v1.5`, or OpenRouter `text-embedding-3-large`;
384-dim either way) · DeepSeek V4 Pro via OpenRouter · pg-boss (Postgres-backed jobs, no Redis) ·
Astro SSR (public website + MCP).

```
packages/core   shared types, env, tier/entitlement logic, clustering
packages/db     Drizzle schema + migrations (pgvector) + repositories
packages/ai     embeddings (Transformers.js) + OpenRouter LLM client
packages/queue  pg-boss queues + job definitions
apps/bot        discord.js gateway client (commands, events, interactions)
apps/worker     pg-boss jobs (embed, summarize, cluster, FAQ, nudge, backfill, reconcile)
apps/web        Astro SSR — public website (subdomain/custom-domain) + /mcp endpoint
```

The **bot** does live query-embedding + interactions; the **worker** does heavy/scheduled work; they
coordinate only through pg-boss + Postgres. Tier is derived purely from Discord entitlements (with an
hourly LIST reconcile + per-process cache) and gates every feature.

---

## Quick start

```bash
make setup                       # install + .env + Postgres + migrations
```

…or step by step (`make help` lists every task):

```bash
corepack enable                  # provides pnpm (pinned in package.json)
pnpm install
pnpm db:up                       # Postgres (pinned pgvector/pgvector:pg16)
pnpm db:migrate                  # extension + tables + HNSW index
pnpm db:verify                   # proves pgvector cosine search works
```

**Dev container:** open the repo in VS Code / Cursor and "Reopen in Container" — the
[.devcontainer](.devcontainer/devcontainer.json) starts Postgres alongside a Node 22 workspace,
installs dependencies, and runs migrations automatically (ports 4321/5432/8090 forwarded).

Then fill in `.env` (copy from `.env.example`) and start everything with one command:

```bash
make dev                         # Postgres + migrations + bot + worker + web (live reload)
```

Or run services individually: `pnpm dev:bot` / `pnpm dev:worker` / `pnpm dev:web`.

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
   - Consumable one-time: `SKU_TOPUP` (credit pack) · `SKU_CUSTOM_DOMAIN` (per-server unlock)
   - Backfill needs no SKU — history import is included
5. **Website domains:** point `*.dejavue.app` (wildcard DNS + TLS) at the web app. `.app` is HSTS-preloaded,
   so HTTPS is mandatory — the wildcard cert must cover `*.dejavue.app`. Custom domains CNAME to the
   same host (provision per-domain TLS / on-demand certs).

### Key env vars

`DATABASE_URL` · `DISCORD_TOKEN` · `DISCORD_CLIENT_ID` · `DISCORD_DEV_GUILD_ID` ·
`OPENROUTER_API_KEY` · `OPENROUTER_MODEL` (default `deepseek/deepseek-v4-pro`) ·
`KB_BASE_DOMAIN` (default `dejavue.app`) · `QUOTA_CREDITS_PLUS` / `QUOTA_CREDITS_PRO` /
`QUOTA_CREDITS_MAX` (monthly AI credits: 25 / 1,000 / 5,000) · `TOPUP_CREDITS` (default 250) ·
`MCP_RATE_PER_MIN` (default 30) · the `SKU_*` ids · `DEV_FORCE_TIER` (dev only).

**Embeddings** are pluggable via `EMBEDDING_PROVIDER`:

| Provider | `EMBEDDING_MODEL` | Cost | Notes |
|---|---|---|---|
| `local` (default) | `bge-small-en-v1.5` / `multilingual-e5-small` | free, on-CPU | downloads a small ONNX model |
| `openrouter` | `openai/text-embedding-3-large` | per-token API | reuses `OPENROUTER_API_KEY` |

Both produce **384-dim** vectors (`EMBEDDING_DIM`) to share one `vector(384)` column, so switching is
a config change — set `EMBEDDING_PROVIDER=openrouter` and restart. On startup the bot re-embeds threads
with the new model (search is scoped to the active model id, so stale vectors are never mixed in); run
`/dejavue backfill` to re-embed a forum's full history. Point `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY` at
`https://api.openai.com/v1` to call OpenAI directly instead of OpenRouter. Using a larger native
dimension means migrating the `vec` column (and re-embedding).

---

## Using the MCP server (Max)

Once a Max guild has set a website slug and opted in, its published answers are queryable at
`https://{slug}.dejavue.app/mcp`. Add it to an AI client as a **Streamable HTTP** MCP server; it
exposes one tool:

```
search_knowledge_base(query: string, limit?: number)  → relevant solved Q&As with source links
```

---

See [docs/PLAN.md](./docs/PLAN.md) for the full design rationale and milestone history.
