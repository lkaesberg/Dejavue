import { z } from 'zod';

/**
 * Single source of truth for environment configuration.
 *
 * Everything has a default or is optional, so importing this never throws for a
 * missing var — individual entrypoints assert the vars they actually need
 * (e.g. the bot asserts DISCORD_TOKEN) via {@link requireEnv}.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().default('postgres://dejavue:dejavue@localhost:5432/dejavue'),

  // Discord
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  // Ops-alert webhook: startup / subscription / failure events are posted here.
  // Unset (or empty) → notifications are silently skipped (dev/CI stay quiet).
  DISCORD_WEBHOOK_URL: z.string().optional(),

  // Premium Apps SKU ids
  SKU_PLUS: z.string().optional(),
  SKU_PRO: z.string().optional(),
  SKU_MAX: z.string().optional(),
  SKU_BACKFILL: z.string().optional(),
  // Consumable AI-credit top-up packs — one SKU per pack size. How many credits
  // each grants is fixed in code (see @dejavue/core `topUpTiers`); only the ids
  // vary per environment. Leave a pack's id unset to hide that pack.
  SKU_TOPUP_500: z.string().optional(),
  SKU_TOPUP_1000: z.string().optional(),
  SKU_TOPUP_2000: z.string().optional(),
  SKU_TOPUP_5000: z.string().optional(),
  SKU_CUSTOM_DOMAIN: z.string().optional(),

  // ---- Public knowledge-base ads (Free tier only) ----
  // A cookieless, non-tracking network by design: the KB is other communities' content
  // and the privacy policy promises no visitor profiling, so a behavioural network is
  // not an option here. 'none' (default) disables ads entirely and falls back to an
  // in-house upgrade promo, which is also what a visitor who declines consent sees.
  ADS_PROVIDER: z.enum(['none', 'ethicalads']).default('none'),
  // Publisher id / slug issued by the network.
  ADS_PUBLISHER_ID: z.string().optional(),

  /**
   * Product analytics (optional). Unset → both pipelines below are a hard no-op, so a
   * self-hosted instance sends nothing at all.
   *
   * Used in TWO places, which is worth knowing before changing anything here:
   *   - bot + worker, via @dejavue/analytics (posthog-node). Server-scoped operational
   *     events; `distinct_id` is the guild id and an allowlist makes it structurally
   *     impossible to emit content, titles, queries or user ids.
   *   - the public web tier, via components/KbAnalytics.astro (posthog-js), on tenant
   *     knowledge bases only — never the apex marketing site. Cookieless mode with
   *     person profiles disabled: no cookie, no local storage, no persistent visitor id.
   *
   * Because the second one runs in the visitor's browser, this value is rendered into
   * the page HTML. That is correct for a PostHog *project* key (`phc_…`), which is
   * public by design — do NOT put a personal API key (`phx_…`) here.
   *
   * Both are disclosed in PlatformPrivacy; keep that page in step with any change.
   */
  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().default('https://eu.posthog.com'),

  // Embeddings — switch the backend between self-host and OpenRouter.
  //   local      → CPU model via Transformers.js (free, no API).
  //   openrouter → OpenAI-compatible embeddings API (e.g. text-embedding-3-large).
  EMBEDDING_PROVIDER: z.enum(['local', 'openrouter']).default('local'),
  // For local: a known model key (bge-small-en-v1.5 | multilingual-e5-small).
  // For openrouter: the API model id (e.g. openai/text-embedding-3-large).
  EMBEDDING_MODEL: z.string().default('embeddinggemma-300m'),
  // Output dimension. MUST match the `vector(...)` DB column (currently 384).
  // The OpenRouter backend requests this many dimensions (Matryoshka), so a
  // big model like text-embedding-3-large drops straight into the 384-d column.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
  // OpenRouter backend: base URL + key. Defaults to OpenRouter using
  // OPENROUTER_API_KEY; point EMBEDDING_BASE_URL at https://api.openai.com/v1
  // (with EMBEDDING_API_KEY) to call OpenAI directly instead.
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  // Hard ceiling on how many chunks a single thread is split into. 0 = unlimited
  // (the default): every message in the thread is embedded. Setting a positive
  // value keeps the canonical Q&A chunk and the accepted-answer chunk, then keeps
  // chunks from the start and end of the thread and DROPS the middle — so only set
  // it if a pathological megathread actually becomes a problem.
  EMBED_MAX_CHUNKS_PER_THREAD: z.coerce.number().int().min(0).default(0),
  // How many chunks are sent to the embedding backend per request. Bulk imports
  // batch across threads; the API backend takes an array natively, so this mostly
  // trades request count against per-request latency and memory.
  EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(64),

  // Generative (OpenRouter, OpenAI-compatible)
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('deepseek/deepseek-v4-pro'),
  OPENROUTER_APP_URL: z.string().default('https://dejavue.app'),
  OPENROUTER_APP_NAME: z.string().default('Dejavue'),

  // Public web KB
  KB_BASE_DOMAIN: z.string().default('dejavue.app'),
  KB_PUBLIC_URL: z.string().default('https://dejavue.app'),
  // Also signs the private-KB gate cookie. REQUIRED in production — getEnv() rejects a
  // production boot without it rather than falling back to a constant that is public in
  // this repo (see apps/web/src/lib/gate.ts).
  KB_REVALIDATE_SECRET: z.string().optional(),
  /**
   * How many reverse proxies sit between the internet and this app, each appending to
   * `X-Forwarded-For`. Determines which entry of that header is trustworthy — see
   * apps/web/src/lib/clientIp.ts, which explains why this is deployment configuration
   * rather than a tuning knob. 0 (default) ignores forwarding headers entirely and uses
   * the socket peer, which is the safe answer for a directly exposed app. The hosted
   * topology (Cloudflare → Traefik → app) is 2.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  // Monthly AI-credit budgets per tier (1 credit = 1,000 tokens). Defaults mirror
  // packages/core types.ts. Top-up pack sizes are fixed in code (`topUpTiers`), not env.
  QUOTA_CREDITS_PLUS: z.coerce.number().int().nonnegative().default(250),
  QUOTA_CREDITS_PRO: z.coerce.number().int().positive().default(2_500),
  QUOTA_CREDITS_MAX: z.coerce.number().int().positive().default(12_000),
  // MCP endpoint burst limit (requests/minute, Max tier).
  MCP_RATE_PER_MIN: z.coerce.number().int().positive().default(30),
  // Monthly embedding-token ceilings. A runaway guard, not the product limit (indexCap
  // is): they only trip on pathological churn. Fail-closed on Free, alert-only on paid.
  QUOTA_EMBED_TOKENS_FREE: z.coerce.number().int().min(0).default(500_000),
  QUOTA_EMBED_TOKENS_PLUS: z.coerce.number().int().min(0).default(5_000_000),
  QUOTA_EMBED_TOKENS_PRO: z.coerce.number().int().min(0).default(50_000_000),
  QUOTA_EMBED_TOKENS_MAX: z.coerce.number().int().min(0).default(200_000_000),
  // How many channel history jobs (backfill / reindex) the worker runs in parallel.
  // Each re-embeds on a CPU model, so parallelism trades throughput for memory — raise
  // on a roomy host, keep at 1 on a memory-constrained one to avoid OOM.
  CHANNEL_JOB_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Dev-only: force a tier regardless of entitlements (e.g. 'pro' locally so all
  // features are exercisable without real SKUs). Leave unset in production.
  DEV_FORCE_TIER: z.enum(['free', 'plus', 'pro', 'max']).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse + memoize env. Call after `import 'dotenv/config'` in entrypoints. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (source.PRO_MONTHLY_QUOTA !== undefined) {
    // Removed in the token-based quota rework — its unit (generations/month) is
    // incompatible with credit budgets, so a silent fallback would be wrong.
    console.warn(
      'PRO_MONTHLY_QUOTA is no longer used; set QUOTA_CREDITS_PRO (AI credits, 1 credit = 1,000 tokens) instead.',
    );
  }
  cached = parsed.data;
  return cached;
}

/** Reset the memoized env — used in tests. */
export function resetEnvCache(): void {
  cached = undefined;
}

type RequiredKey = {
  [K in keyof Env]-?: undefined extends Env[K] ? K : never;
}[keyof Env];

/** Assert that an optional env var is present, returning it narrowed to a string. */
export function requireEnv<K extends RequiredKey>(key: K): NonNullable<Env[K]> {
  const value = getEnv()[key];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<Env[K]>;
}
