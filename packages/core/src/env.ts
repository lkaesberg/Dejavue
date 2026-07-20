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

  // Embeddings — switch the backend between self-host and OpenRouter.
  //   local      → CPU model via Transformers.js (free, no API).
  //   openrouter → OpenAI-compatible embeddings API (e.g. text-embedding-3-large).
  EMBEDDING_PROVIDER: z.enum(['local', 'openrouter']).default('local'),
  // For local: a known model key (bge-small-en-v1.5 | multilingual-e5-small).
  // For openrouter: the API model id (e.g. openai/text-embedding-3-large).
  EMBEDDING_MODEL: z.string().default('bge-small-en-v1.5'),
  // Output dimension. MUST match the `vector(...)` DB column (currently 384).
  // The OpenRouter backend requests this many dimensions (Matryoshka), so a
  // big model like text-embedding-3-large drops straight into the 384-d column.
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),
  // OpenRouter backend: base URL + key. Defaults to OpenRouter using
  // OPENROUTER_API_KEY; point EMBEDDING_BASE_URL at https://api.openai.com/v1
  // (with EMBEDDING_API_KEY) to call OpenAI directly instead.
  EMBEDDING_BASE_URL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),

  // Generative (OpenRouter, OpenAI-compatible)
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('deepseek/deepseek-v4-pro'),
  OPENROUTER_APP_URL: z.string().default('https://dejavue.app'),
  OPENROUTER_APP_NAME: z.string().default('Dejavue'),

  // Public web KB
  KB_BASE_DOMAIN: z.string().default('dejavue.app'),
  KB_PUBLIC_URL: z.string().default('https://dejavue.app'),
  KB_REVALIDATE_SECRET: z.string().optional(),

  // Monthly AI-credit budgets per tier (1 credit = 1,000 tokens). Defaults mirror
  // packages/core types.ts. Top-up pack sizes are fixed in code (`topUpTiers`), not env.
  QUOTA_CREDITS_PLUS: z.coerce.number().int().nonnegative().default(25),
  QUOTA_CREDITS_PRO: z.coerce.number().int().positive().default(1_000),
  QUOTA_CREDITS_MAX: z.coerce.number().int().positive().default(5_000),
  // MCP endpoint burst limit (requests/minute, Max tier).
  MCP_RATE_PER_MIN: z.coerce.number().int().positive().default(30),
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
