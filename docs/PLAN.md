# Dejavue — Discord Q&A Deduplication Bot (Implementation Plan)

> **Historical design doc.** This is the originally approved plan. The shipped product has since
> evolved — notably a 4th **Max** tier (only Max has unlimited caps; Pro is finite), a **custom-domain**
> one-time purchase, full-**transcript** KB pages, and an **MCP server** (Max). AI metering moved from
> per-generation counts to **token-based AI credits** (1 credit = 1,000 tokens; taster budget on Plus),
> and the per-tier "KB page caps" described below were replaced by a single **indexed-messages**
> ceiling. See **[README.md](../README.md)** for the current, authoritative tiers + features.

## Context

**Dejavue** is a paid SaaS Discord bot that watches help/Q&A **forum channels**, fights duplicate questions, and turns solved threads into a searchable knowledge base. The problem it solves: active support communities drown in repeat questions; the same answers get re-typed forever, and good answers are never reused. Dejavue detects likely duplicates the moment a post is created, drives a "mark-solved" workflow, archives canonical answers, and (on paid tiers) layers AI drafting/summarization and a public SEO knowledge base on top.

It is monetized through **Discord Premium Apps** (native per-server billing) across three tiers, with pricing aligned to marginal cost: keyword features are free, embedding-based semantic search anchors the mid tier, and generative AI lives behind a quota in the top tier. The public knowledge base — near-zero marginal cost to serve — is available on **every tier** (page caps 10 / 100 / 500 / unlimited — only Max is unlimited) to maximize the SEO/adoption flywheel.

This is a **greenfield build** — the working directory is empty. The decided stack is **TypeScript + discord.js v14**, **Postgres + pgvector**, **local CPU embeddings**, and **DeepSeek V4 Pro via OpenRouter** for generative AI. The public web KB is **multi-tenant by subdomain** (`{guild-slug}.{KB_BASE_DOMAIN}`). Scope is the full three-tier feature set plus the public knowledge base.

> **Brand/domain:** renamed from "Dejavu" → **Dejavue** for domain availability (intentional one-letter variant; identical pronunciation). Domain: **dejavue.app** (set as `KB_BASE_DOMAIN`). Note the minor SEO tradeoff of per-guild **subdomains** (Google treats them as separate sites, so each community's KB builds authority independently — acceptable for long-tail per-question ranking, and enables a future custom-domain upsell).

This plan was pressure-tested by an architecture-review pass; the non-obvious gotchas it surfaced (Drizzle pgvector index bug, archived `fastembed` package, entitlement lifecycle semantics, `threadCreate` race) are baked into the design below rather than left to be discovered mid-build.

---

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript, Node 22 LTS | |
| Bot framework | discord.js v14 | Pin exact version; v15 migration is in flight — verify APIs against installed version |
| Datastore | Postgres + pgvector | Docker image pinned to `pgvector/pgvector:pg16` (match prod pgvector version) |
| ORM | Drizzle ORM + drizzle-kit | Typed `vector` column; **index created via hand-written SQL migration** (see Data model) |
| Embeddings | `@huggingface/transformers` (Transformers.js v3), ONNX/CPU | `fastembed` original npm is **archived** — do not use. `@mastra/fastembed` is the fallback fork |
| Embedding model | `bge-small-en-v1.5` (384-dim) default; `multilingual-e5-small` (384-dim) per-guild swap | Both 384-dim so model swaps need no schema change. Query/passage prefixes bound to model id |
| Generative LLM | **DeepSeek V4 Pro** via OpenRouter (`openai` SDK, `baseURL` override) | Default model for all generative features (drafts/summaries/FAQ/cluster labels); per-feature override kept. `HTTP-Referer`/`X-Title` headers. Confirm exact OpenRouter id (e.g. `deepseek/deepseek-v4-pro`) |
| Public web KB | Astro **SSR** (node adapter), multi-tenant by **subdomain** | Each guild's KB at `{slug}.{KB_BASE_DOMAIN}`; host-based middleware resolves the tenant. SSR (not pure SSG) required for wildcard-subdomain routing; pages still ship near-zero JS for SEO |
| Job queue/scheduler | pg-boss v10 (Postgres-backed) | No Redis needed; native cron + singleton/stately queue policies |
| Config validation | zod | Fail-fast env parsing in `packages/core` |
| Logging | pino | |
| Tests | vitest | |
| Repo | pnpm workspaces monorepo (scope `@dejavue/*`) | |

---

## Monorepo layout

```
Dejavue/
├─ docker-compose.yml          # pinned pgvector/pgvector:pg16
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ core/                    # shared types, zod env config, tier/entitlement logic, tier cache
│  ├─ db/                      # Drizzle schema, migrations (incl. hand-written vector SQL), repositories
│  └─ ai/                      # embeddings client (Transformers.js) + OpenRouter LLM client + prompt templates
└─ apps/
   ├─ bot/                     # discord.js gateway client: commands, components, event handlers
   ├─ worker/                  # pg-boss job definitions (embedding, nudges, clustering, FAQ, reconcile, backfill)
   └─ web/                     # Astro SSR public knowledge base (subdomain multi-tenant)
```

**Process split:** `bot` and `worker` are **separate processes from day one**, sharing `packages/db`. They coordinate only through pg-boss + Postgres (no direct calls). Embedding inference rules:
- **Bulk/backfill encoding → worker only** (ONNX model load is ~100–400 MB RSS; must not compete with the gateway's heartbeat).
- **Live query encoding on `threadCreate`/search → bot**, lazy-loading the model on first use, **query-encoding only**. (If a second shard is ever added, extract a tiny embedding HTTP microservice so the model loads once — designed for, not built now.)

---

## Data model (`packages/db/src/schema.ts`)

Core entities (Drizzle/Postgres). Tags are **per-guild snowflakes**, never hardcoded constants. Embeddings always carry their producing model so swaps/upgrades are non-destructive.

| Table | Key fields |
|---|---|
| `guild` / `guild_config` | guild_id, monitored forum channel ids, solved/unsolved **tag ids** (per-guild snowflakes), embedding model id, nudge timers, `kb_publish_opt_in` (default **false**), `kb_slug` (subdomain label, unique, DNS-safe), branding flag |
| `entitlement` | sku_id, guild_id, user_id?, type, `starts_at` (nullable), `ends_at` (nullable), `deleted`, `consumed` (OTP). **Raw mirror of Discord objects — tier is computed over this, never stored as truth** |
| `thread` / `archived_post` | thread snowflake, guild, channel, op_user_id, title, question_body, accepted_answer_message_id, accepted_answer_text, created_at, solved_at, solved_by, status (open/solved/unsolved), `published_to_kb`, `do_not_publish` |
| `embedding` | `vector(384)` + **`model_id` + `embedding_version`** + `source` ('question' \| 'answer' \| 'summary'); FK to thread |
| `solution` / canonical answer | raw accepted Discord message vs LLM-summarized canonical text (provenance + clean KB text) |
| `generation_event` (quota ledger) | feature, guild, model, tokens (COGS), billing_window, success, top_up_credits_consumed. **Usage = aggregate over current window; never store a mutable "remaining" counter** |
| `knowledge_gap_cluster` | member thread ids, medoid, LLM label, status, counts |
| `faq_entry` | generated question, canonical answer, source thread/cluster refs, last_regenerated, published, `manual_override` (so human edits aren't clobbered by auto-regen) |
| `backfill_job` | guild, channel, cursor/checkpoint, total/processed/failed, status, consumed durable entitlement id |
| `helper_stats` (optional/materialized) | guild+user+window aggregate if "top helpers" gets heavy |

### pgvector migration approach (critical — avoids an open Drizzle bug)

There is an **open drizzle-orm bug (#5792)**: `drizzle-kit push` emits HNSW DDL without the operator class (→ `no default operator class for access method 'hnsw'`) and ignores the `.op('vector_cosine_ops')` schema hint. Therefore:

- Use **`drizzle-kit generate`** (SQL migration files) — **never `push`**, even in dev.
- Keep the column typed in Drizzle (`vector('embedding', { dimensions: 384 })`) so queries are typed.
- **Hand-write** a custom SQL migration (`packages/db/migrations/0000_init.sql`) for:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
  ```
- At query time tune recall: `SET LOCAL hnsw.ef_search = 100`, and decide "is this actually a duplicate" with a **cosine-distance threshold**, not blind top-K.
- During backfill, **bulk-insert rows first, then build the HNSW index** (incremental HNSW build over 10k rows is far slower).

The vector search query lives **only** in a `packages/db` repository method; the bot never hand-writes vector SQL.

---

## Entitlement & tier system (`packages/core/src/entitlements.ts`)

This is the riskiest *business* logic. Discord's semantics are counterintuitive:

- **Entitlements are the source of truth for access** — the Subscription API/events are reporting-only; never gate on them.
- A subscription that **lapses/cancels fires `ENTITLEMENT_UPDATE` with `ends_at` set — NOT `ENTITLEMENT_DELETE`.** DELETE fires only on refund, manual removal, or test-entitlement deletion.
- **Active subscription → `ends_at: null`.**
- **Test entitlements have no `starts_at`/`ends_at`** — valid until deleted.

**Tier predicate (pure function over local `entitlement` rows):**
> `active = row exists for guild's SKU AND not deleted AND (ends_at IS NULL OR ends_at > now)`
> Pro SKU active → `pro`; else Plus SKU active → `plus`; else `free`.

**Sync, three layers (defense in depth):**
1. Gateway handlers for `ENTITLEMENT_CREATE/UPDATE/DELETE` → upsert row + invalidate cache (low-latency upgrades).
2. **pg-boss cron reconcile** (hourly) + **on `ClientReady` reconcile** → call **LIST Entitlements**, treat as source of truth, upsert/expire rows (heals missed events — these *will* happen across reconnects/deploys).
3. **In-memory per-guild tier cache** (~60s TTL), invalidated immediately on gateway events, repopulated by reconcile. One helper: `getGuildTier(guildId): Promise<'free'|'plus'|'pro'>`. Hot paths (`threadCreate`, interactions) never hit Postgres for tier.

**Upgrade prompts:** `sendPremiumRequired()` is **removed** in v14. The only path is a **`ButtonStyle.Premium` button with `.setSkuId(...)`** (no custom label/url/emoji). Build one helper that returns an embed + Premium button row for a given SKU; use it both to block gated features and for contextual upsell (e.g. "this duplicate has an AI draft on Pro").

---

## Core loop

### Forum monitoring & duplicate detection (`apps/bot/src/events/threadCreate.ts`)

The OP's starter message can arrive **after** `threadCreate` fires. Handle the race in layers:
- Use the `newlyCreated` boolean to ignore threads the bot is merely added to.
- **Debounce**: enqueue a `detect-duplicates` pg-boss job with a small delay (3–8s) keyed by **thread id** (singleton). The worker fetches the starter message with **retry/backoff** (≈3 tries over ~10s).
- Also subscribe to `messageCreate` and treat "first message where the thread == channel" as a **fallback trigger** that collapses onto the same thread-id-keyed job (idempotent).
- Detection: **keyword** match (Free, all tiers) vs **semantic** vector search (Plus+). Reply with an embed listing matches + buttons; on Pro, include an AI draft (quota permitting).

### Mark-solved workflow (`apps/bot/src/commands` + components)

Button ("Mark as solved") + `/dejavue solved` slash command. On solve:
- `setAppliedTags` to add the guild's **solved** tag and remove **unsolved** (tag ids from `guild_config`).
- Record accepted answer (message id + text); persist/update the `thread` row to `solved`.
- Enqueue worker jobs: embed the thread, (Pro) summarize, (Pro, if opted-in) publish/revalidate KB page.
- Auto-apply the **unsolved** tag on new post creation.

### Search (`/dejavue search`)

Keyword search (Free, archive capped ~500 posts) → semantic vector search via the `db` repo (Plus+). Results link back to threads.

### Stats / analytics (`/dejavue stats`)

Basic solved/unsolved counts (Free). Plus: resolution rate, time-to-resolution (`solved_at − created_at`), top helpers (accepted-answer authors), most-asked.

### Config (`/dejavue config`, admin only)

Select forum channel(s), pick solved/unsolved tags, set nudge timers, embedding model (en/multilingual), KB publish opt-in, KB subdomain slug.

---

## AI layer (`packages/ai`)

- **Embeddings** (`embeddings.ts`): Transformers.js client that **binds model id ↔ its required prefix** (`bge`: query instruction; `e5`: `"query: "`/`"passage: "`). Forgetting prefixes silently degrades retrieval, so the caller can't get it wrong. Returns 384-dim vectors.
- **LLM** (`llm.ts`): `openai` SDK with `baseURL: https://openrouter.ai/api/v1` + attribution headers. **Default model: DeepSeek V4 Pro** (`deepseek/deepseek-v4-pro` — confirm exact id on OpenRouter) for all generative features, with a per-feature override map (e.g. a cheaper model for bulk summaries). DeepSeek's strong price/performance gives the Pro quota generous headroom and low COGS. **Do not rely on native `response_format: json_schema`** (reliability varies across OpenRouter providers; verify DeepSeek structured output) — use prompted-JSON + a **zod parse-and-repair loop**; per-feature `json_mode: 'native' | 'prompted'` flag.
- **Prompts**: drafting (answer from past solved threads), summarization (long thread → canonical answer), cluster labeling (medoid + few representatives → short title), FAQ generation/maintenance.

---

## Worker jobs (`apps/worker`, pg-boss v10)

Pin retention/archive config (v10 changed defaults; default completion archival can bloat tables). Use cron + singleton/stately policies.

| Job | Trigger | Purpose |
|---|---|---|
| `detect-duplicates` | threadCreate/messageCreate (debounced, singleton by thread id) | Fetch starter message w/ retry; keyword or semantic match; post embed |
| `embed-thread` | on solve | Generate + store embedding (model_id/version) |
| `summarize-thread` | on solve (Pro) | Canonical answer for archive/KB |
| `nudge-stale` | cron (Plus) | Find stale unanswered threads past configured timer; ping helpers/role |
| `cluster-gaps` | cron (Pro) | Greedy threshold agglomeration over pgvector → knowledge-gap clusters; LLM labels |
| `regen-faq` | cron (Pro) | Generate/maintain FAQ from clusters + reused answers; respect `manual_override` |
| `reconcile-entitlements` | cron hourly + on ready | LIST Entitlements → heal tier drift |
| `backfill-forum` | OTP purchase | Import existing forum history (see below) |
| `revalidate-kb` | on solve/edit/unsolve/delete | Trigger web KB page revalidation |

**Knowledge-gap clustering**: not ml-kmeans (needs fixed k). Use **greedy threshold/single-link agglomeration** with nearest-neighbor lookups done **in Postgres via the HNSW index** (avoids O(n²) in-memory). Parameterized by a cosine-distance threshold. Label by sending **medoid + a few representatives** to the LLM (cheap, stable), capping cluster size sent.

---

## Quota metering (Pro generative calls)

- **Meter generative calls only** (drafts, summaries, FAQ, cluster labels). **Embeddings / semantic search are unmetered** (cheap, priced as a flat Plus feature — verify they keep working when generative quota is exhausted).
- Count a generation **on success**, atomically with the result (transactional increment tied to the `generation_event` row) so retries/failures never double-charge.
- **No mutable "remaining" counter** — store the ledger, compute usage over the current window. Pick the window (entitlement period vs calendar-month-UTC) and **document it**.
- Guard every generative entry point with `checkAndReserveQuota()` → returns a token committed on success / released on failure.
- Near-limit UX at ~80% and ~100%: surface a Premium / **top-up** button. Top-ups = a **consumable SKU** granting N extra generations, modeled as ledger credits.

---

## Backfill one-time purchase (durable OTP)

- Runs entirely as a **checkpointed pg-boss job** (`backfill-forum`): list active threads + **paginate archived threads** (`GET /channels/{id}/threads/archived/public`, cursor by archive timestamp), fetch each starter message, bulk-embed, **then build/refresh HNSW**.
- **Rate limits**: rely on discord.js's REST queue but add a **concurrency cap (1–2 in flight)** and honor `Retry-After`; a naive `Promise.all` over thousands of threads trips global limits.
- **Idempotent**: upsert threads by `(guild_id, thread_id)`; embeddings keyed by `(thread_id, embedding_version)`. Re-running is a no-op for imported threads; resumes cleanly after a crash via persisted cursor.
- **Progress**: write to `backfill_job` row; edit a Discord status message **rate-limited** (every N threads / ~5s, not per thread).
- **Entitlement**: `consume` the durable entitlement once the job **durably starts** (not before), with a defined retry/refund behavior on failure.

---

## Public web KB (`apps/web`, Astro SSR — subdomain multi-tenant)

Available on **every tier** (cheap to serve, and it drives the SEO/adoption flywheel), with per-guild **published-page caps**: **Free 10 · Plus 100 · Pro 500 · Max unlimited**. Publishing is **not** a metered generative action. KB *content* differs by tier so cost stays aligned: Free/Plus publish the **raw question + accepted answer**; **Pro** publishes the **AI-summarized canonical answer** (the only generative, quota-counted part). Free-tier pages carry a small "powered by Dejavue" footer. Enforce by counting `published_to_kb = true` threads per guild against the tier cap; the 11th / 101st publish surfaces the Premium upsell instead of publishing.

- **Routing:** each guild's KB is served at **`{kb_slug}.{KB_BASE_DOMAIN}`** (e.g. `acme.dejavue.app`). A host-based **middleware** (`src/middleware.ts`) reads the `Host` header, extracts the subdomain, resolves the guild, and 404s unknown/unpublished slugs. Apex + `www` serve the marketing/landing page; reserve `app`, `api`, `docs`, `status`.
- **Slugs:** `guild_config.kb_slug` is unique, lowercase, DNS-safe, validated against a reserved-word blocklist; set via `/dejavue config`.
- **Infra:** requires **wildcard DNS** (`*.{KB_BASE_DOMAIN}` → web host) + a **wildcard TLS cert** (Let's Encrypt DNS-01) or a host with on-demand certs (Caddy / Cloudflare / Vercel wildcard domains). **`.app` is on the HSTS preload list → HTTPS is mandatory** (no HTTP fallback); our wildcard TLS satisfies this, but the cert must cover `*.dejavue.app` before any subdomain will load. Future upsell: Pro guilds CNAME their **own** domain (`help.theirsite.com`) — the middleware already keys on Host, so this is a small extension.
- **Content & SEO:** published solved threads render as **`QAPage`** JSON-LD; the curated FAQ renders as **`FAQPage`** JSON-LD (Google treats them differently — don't mix). Pages ship near-zero JS. Per-tenant **sitemap** generated from the DB (published threads), regenerated on publish/unpublish with `lastmod`. (SEO note: subdomains build authority per-tenant rather than consolidating onto the apex — acceptable for long-tail per-question ranking.)
- **Privacy/GDPR (default-safe):** publishing is **opt-in per guild, default off**; **usernames aliased** by default ("a community member") unless the helper opts in; per-thread `do_not_publish` flag; by default publish only question + accepted answer, not the whole thread.
- **Invalidation:** the worker calls a **secured revalidation route** on solve/edit/unsolve/delete, tagging pages by `guild:thread` so one solve invalidates exactly that page + the tenant's FAQ index + sitemap. Unsolve/delete → **`410 Gone` / noindex** so Google de-indexes.

---

## Tier-gating matrix

_(Original 3-tier matrix; a **Max** tier was added later — only Max is unlimited. See README.)_

| Feature | Free | Plus (~$4.99) | Pro (~$9.99) |
|---|---|---|---|
| Forum channels monitored | 1 | 3 | 5 |
| Duplicate detection | keyword | **semantic** | semantic + AI draft |
| Mark-solved + archive | ✓ (cap ~500) | ✓ (~1.5k) | ✓ (~2.5k) |
| `/dejavue search` | keyword | semantic | semantic |
| Stale-question nudges | — | ✓ | ✓ |
| Analytics | basic counts | full | full |
| Branding ("powered by Dejavue") | shown | removed | removed |
| AI summarization / gap clustering / auto-FAQ | — | — | ✓ (quota) |
| Public web KB (subdomain) | ✓ — up to **10** pages | ✓ — up to **100** pages | ✓ — up to **500** pages |
| KB answer rendering | raw accepted answer | raw accepted answer | **AI-summarized** canonical answer |
| Backfill | — | one-time purchase (durable SKU) | one-time purchase |
| Generation quota | — | — | ~300/mo + top-ups |

---

## Build sequence (milestones — each independently runnable/verifiable)

- **M0 — Scaffolding + DB foundation.** pnpm workspaces; all packages with empty exports; zod env config; pino; vitest; docker-compose (pinned pgvector). Drizzle schema for non-vector core entities + **hand-written SQL migration creating the vector extension, `vector(384)` column, and HNSW index** (proves the #5792 workaround on day one — the biggest unknown). *Verify:* `drizzle-kit generate` + migrate runs clean; a manual insert + `<=>` cosine query returns rows.
- **M1 — Bot connects + forum detection + mark-solved (no AI/dedup).** Login; detect forum channels; register `/dejavue`; mark-solved workflow swaps `appliedTags`, records answer, persists thread. *Verify:* solving a forum post flips tags and writes a DB row. (Dev: everyone treated as Pro.)
- **M2 — Embeddings + keyword baseline + search (Free behavior).** `packages/ai` embedding client (model id ↔ prefix); worker embeds on solve; keyword dedup on `threadCreate` with **debounce + retry + messageCreate fallback**; keyword `/dejavue search`. *Verify:* solve enqueues an embed job writing a 384-dim vector; new post triggers a keyword-duplicate embed; search returns hits. Proves the race fix + bot/worker pg-boss coordination.
- **M3 — Semantic dedup + semantic search (Plus core).** Swap to vector search via `db` repo (`ef_search` + distance threshold); per-guild model config. *Verify:* reworded near-duplicates match; English + non-English test threads retrieve sensibly.
- **M4 — Entitlements + tier gating + reconcile (SaaS).** Entitlement table; gateway handlers (UPDATE-not-DELETE); tier predicate + cache; **LIST reconcile cron + on-ready**; Premium-button helper. Gate features per matrix. *Verify:* using **test entitlements** (no dates — exercise that branch), flip Free↔Plus↔Pro and watch gating; kill bot mid-change and confirm reconcile heals tier.
- **M5 — Generative layer + quota (Pro).** OpenRouter client defaulting to **DeepSeek V4 Pro** (per-feature overrides; prompted-JSON + zod repair); AI draft on dedup; summarize on solve; quota ledger + reserve/commit; near-limit/top-up buttons. *Verify:* Pro guild gets a draft; the quota'th call blocks with upsell; consumable top-up restores capacity; embeddings still work when quota exhausted.
- **M6 — Backfill (durable OTP).** Checkpointed job; paginate archived+active threads; backoff; bulk-embed then build HNSW; progress message; consume entitlement on durable start. *Verify:* point at a forum with hundreds of threads; kill mid-run; confirm clean resume + idempotent re-run.
- **M7 — Analytics + gap clustering + auto-FAQ.** Analytics aggregates; greedy-threshold clustering over pgvector + LLM labels; auto-FAQ cron respecting `manual_override`. *Verify:* analytics returns numbers; clustering surfaces a recurring theme; FAQ generates/updates.
- **M8 — Public web KB (all tiers, subdomain).** Astro SSR + host-based tenant middleware; published threads (`QAPage`) + FAQ (`FAQPage`); **per-tier publish caps (Free 10 / Plus 100 / Pro 500 / Max unlimited)** enforced by counting published threads, with a Premium upsell on overflow; Free/Plus render the raw accepted answer while Pro renders the AI-summarized canonical answer; per-tenant DB-driven sitemap; opt-in publishing + username aliasing + "powered by Dejavue" footer on Free + unpublish/410; worker-triggered revalidation; wildcard DNS/TLS. *Verify:* solving in an opted-in guild creates a page at `{slug}.{KB_BASE_DOMAIN}` with valid structured data (Google Rich Results test); a Free guild's 11th publish is blocked with an upsell; unsolving removes a page; sitemap updates.

**Stub-early:** entitlements (M0–M3 run as "everyone Pro"); all AI (M0–M4); backfill, analytics, KB; multilingual (start English-only — the `model_id` column makes the swap free later).

---

## Critical files

- [packages/db/src/schema.ts](packages/db/src/schema.ts) — Drizzle schema; `vector(384)` column here, **not** the HNSW index.
- [packages/db/migrations/0000_init.sql](packages/db/migrations/0000_init.sql) — hand-written `CREATE EXTENSION vector` + HNSW index (the drizzle-kit #5792 workaround).
- [packages/db/src/repositories/search.ts](packages/db/src/repositories/search.ts) — the only place vector SQL lives (`ef_search`, cosine threshold).
- [packages/core/src/entitlements.ts](packages/core/src/entitlements.ts) — tier predicate (UPDATE-not-DELETE, null `ends_at` = active, test entitlements have no dates), tier cache, reconcile.
- [packages/core/src/env.ts](packages/core/src/env.ts) — zod env config.
- [packages/ai/src/embeddings.ts](packages/ai/src/embeddings.ts) — Transformers.js client binding model id ↔ prefix; multilingual swap seam.
- [packages/ai/src/llm.ts](packages/ai/src/llm.ts) — OpenRouter client defaulting to DeepSeek V4 Pro; prompted-JSON + zod repair.
- [apps/bot/src/events/threadCreate.ts](apps/bot/src/events/threadCreate.ts) — `newlyCreated` + debounce + `messageCreate` fallback → single idempotent job (race fix).
- [apps/bot/src/lib/upsell.ts](apps/bot/src/lib/upsell.ts) — Premium-button (`setSkuId`) upgrade-prompt helper.
- [apps/worker/src/jobs/](apps/worker/src/jobs/) — pg-boss job definitions (one file per job above).
- [apps/web/src/middleware.ts](apps/web/src/middleware.ts) — host-based tenant resolution (subdomain → guild).
- [apps/web/src/pages/](apps/web/src/pages/) — Astro KB routes + `QAPage`/`FAQPage` JSON-LD + DB-driven sitemap.

---

## Manual / external steps (not code — required to go live)

1. Create the Discord application; enable **Monetization** (requires team ownership + eligibility/verification).
2. In the developer portal, create SKUs: **Plus** (Guild Subscription), **Pro** (Guild Subscription), **Backfill** (Durable OTP), **Top-up** (Consumable OTP). Copy their IDs into env.
3. Bot scopes/intents: `bot` + `applications.commands`; **Guilds**, **Guild Messages**, **Message Content** (for forum starter messages) intents.
4. Env vars: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DATABASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `deepseek/deepseek-v4-pro`), `SKU_PLUS`, `SKU_PRO`, `SKU_BACKFILL`, `SKU_TOPUP`, `EMBEDDING_MODEL`, `KB_BASE_DOMAIN` (e.g. `dejavue.app`), `KB_REVALIDATE_SECRET`, plus optional per-feature model overrides.
5. Per guild (admin): pick forum channel(s), solved/unsolved tag ids, and a KB subdomain slug via `/dejavue config`.
6. **Domain + wildcard DNS/TLS** (for the KB): register `KB_BASE_DOMAIN`; point `*.{domain}` (wildcard A/CNAME) at the web app host; provision a **wildcard TLS cert** (Let's Encrypt DNS-01) or use a host with on-demand certs (Caddy/Cloudflare/Vercel). Reserve `www`, `app`, `api`, `docs`.

---

## Verification (end-to-end)

1. `docker compose up -d` (pinned pgvector) → `pnpm --filter @dejavue/db migrate` runs clean; manual cosine query returns rows.
2. Run `apps/bot` + `apps/worker` against a **test guild** with a forum channel; create a post → debounced duplicate embed appears; "Mark as solved" flips tags + archives.
3. Create a reworded duplicate → semantic match surfaces (Plus+); `/dejavue search` returns it.
4. Create a **test entitlement** in the portal → tier flips, gated features unlock; delete it → reconcile + gateway downgrade; kill the bot mid-change → reconcile heals on restart.
5. On a Pro guild: duplicate yields a DeepSeek-drafted answer; exhaust the quota → upsell button; apply a top-up → capacity restored; confirm semantic search still works at zero quota.
6. Trigger backfill on a forum with many threads; kill mid-run → resumes; re-run → no duplicates.
7. Run clustering/FAQ crons → knowledge-gap cluster + FAQ entry appear.
8. Opt a guild into KB publishing; solve a thread → public page at `{slug}.{KB_BASE_DOMAIN}` with valid `QAPage` JSON-LD (Google Rich Results test), sitemap updates; unsolve → `410`/de-indexed.
9. `pnpm test` (vitest) green for tier predicate, quota ledger, clustering threshold, embedding-prefix binding.

---

## Key risks (condensed reference)

- **Drizzle pgvector index (#5792):** never `push`; hand-write index SQL. *(M0)*
- **`fastembed` archived:** use `@huggingface/transformers`. *(M2)*
- **Entitlement lapse = UPDATE not DELETE; test entitlements have no dates; entitlements (not subscriptions) are truth.** *(M4)*
- **Missed gateway events:** mandatory LIST reconcile. *(M4)*
- **`sendPremiumRequired()` removed:** only `ButtonStyle.Premium` + `setSkuId`. *(M4)*
- **`threadCreate` body race:** debounce + retry + `messageCreate` fallback, idempotent by thread id. *(M2)*
- **Backfill rate limits:** concurrency cap, `Retry-After`, checkpointed/idempotent. *(M6)*
- **Quota:** count on success, ledger not counter, embeddings unmetered. *(M5)*
- **HNSW recall:** tune `ef_search` + distance threshold; index after bulk load. *(M3/M6)*
- **KB subdomains:** all tiers, per-guild caps 10/100/500/unlimited (only Max unlimited); SSR + wildcard DNS/TLS; opt-in default off, alias usernames, 410 on unpublish; per-tenant authority (SEO tradeoff). *(M8)*
- **Embedding dim lock-in:** `model_id`/`embedding_version` column keeps swaps non-destructive. *(M0)*

> Freshness caveat: discord.js (mid-v15 migration), pg-boss, Drizzle, and the exact DeepSeek V4 Pro OpenRouter model id move fast. Version-pin everything and confirm exact APIs/ids against what you install during M0–M1.
