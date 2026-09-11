/** The three monetization tiers, gated by Discord Premium Apps entitlements. */
export type Tier = 'free' | 'plus' | 'pro' | 'max';

export const TIERS = ['free', 'plus', 'pro', 'max'] as const;

/** Ordering so we can express "at least Plus" as a numeric comparison. */
export const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, pro: 2, max: 3 };

export function tierAtLeast(tier: Tier, min: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

/**
 * AI usage is metered in tokens (prompt + completion, weighted equally) but
 * surfaced to users as "AI credits": 1 credit = 1,000 tokens. Quotas, top-up
 * grants, and every display are denominated in credits; only the ledger and
 * the boundary math work in raw tokens.
 */
export const CREDIT_TOKENS = 1_000;

export function creditsToTokens(credits: number): number {
  return Number.isFinite(credits) ? credits * CREDIT_TOKENS : credits;
}

/** Tokens → whole credits, rounding up (a partial credit counts as spent). */
export function tokensToCredits(tokens: number): number {
  return Math.ceil(tokens / CREDIT_TOKENS);
}

/**
 * Approximate credit cost per feature, for explainer copy only ("≈ N drafts
 * left") — actual metering always uses the real token counts from the ledger.
 */
export const APPROX_CREDITS_PER_FEATURE = {
  draft: 0.8,
  summary: 3,
  faq: 1.5,
  cluster_label: 0.1,
} as const;

/**
 * How many top-up credits a generation consumes once it spills past the base
 * monthly budget. Pure boundary math: only the portion of `costTokens` that
 * lands beyond the base budget is billed to top-ups, rounded up to whole
 * credits. Returns 0 while the generation fits inside the base budget.
 */
export function computeSpill(
  usedTokensBefore: number,
  costTokens: number,
  baseCredits: number,
): number {
  const baseTokens = creditsToTokens(baseCredits);
  if (!Number.isFinite(baseTokens)) return 0;
  const spillTokens = Math.min(Math.max(usedTokensBefore + costTokens - baseTokens, 0), costTokens);
  return tokensToCredits(spillTokens);
}

/** Per-tier monthly AI-credit budgets, overridable via env (QUOTA_CREDITS_*). */
export interface TierQuotas {
  plusCredits?: number;
  proCredits?: number;
  maxCredits?: number;
  mcpRequestsPerMinute?: number;
  freeEmbedTokens?: number;
  plusEmbedTokens?: number;
  proEmbedTokens?: number;
  maxEmbedTokens?: number;
}

/**
 * The env-configured quota overrides, in the shape tierLimits() takes. Every
 * consumer (bot / worker / web) must resolve limits through this so an env
 * override never silently applies in one app but not another.
 */
export function quotasFromEnv(env: {
  QUOTA_CREDITS_PLUS: number;
  QUOTA_CREDITS_PRO: number;
  QUOTA_CREDITS_MAX: number;
  MCP_RATE_PER_MIN: number;
  QUOTA_EMBED_TOKENS_FREE: number;
  QUOTA_EMBED_TOKENS_PLUS: number;
  QUOTA_EMBED_TOKENS_PRO: number;
  QUOTA_EMBED_TOKENS_MAX: number;
}): Required<TierQuotas> {
  return {
    plusCredits: env.QUOTA_CREDITS_PLUS,
    proCredits: env.QUOTA_CREDITS_PRO,
    maxCredits: env.QUOTA_CREDITS_MAX,
    mcpRequestsPerMinute: env.MCP_RATE_PER_MIN,
    freeEmbedTokens: env.QUOTA_EMBED_TOKENS_FREE,
    plusEmbedTokens: env.QUOTA_EMBED_TOKENS_PLUS,
    proEmbedTokens: env.QUOTA_EMBED_TOKENS_PRO,
    maxEmbedTokens: env.QUOTA_EMBED_TOKENS_MAX,
  };
}

/**
 * Per-tier feature limits. `Infinity` means unlimited. These encode the
 * tier-gating matrix from the plan in one place so every consumer agrees.
 */
export interface TierLimits {
  /** Number of forum channels Dejavue will monitor. */
  maxForumChannels: number;
  /** Number of tracked *normal* (non-forum) channels indexed as searchable KBs. */
  maxTrackedChannels: number;
  /**
   * Single cap on the TOTAL number of indexed messages across all forum + tracked
   * content. Everything indexed is auto-published, so there is no separate archive
   * vs published vs tracked cap — just one ceiling on index size. At the cap we stop
   * indexing new content (existing entries keep working).
   */
  indexCap: number;
  /** Semantic (embedding) dedup + search, vs keyword-only. */
  semanticSearch: boolean;
  /** Stale-question nudges. */
  nudges: boolean;
  /**
   * AI-drafted answers on duplicate matches (the Plus "taster" and up). Separate
   * from {@link TierLimits.generative}, which gates the full generative suite.
   */
  aiDrafts: boolean;
  /** Full generative AI suite (summarization / clustering / FAQ). */
  generative: boolean;
  /** KB pages render the AI-summarized canonical answer (Pro) vs the raw answer. */
  kbSummarizedAnswers: boolean;
  /** Expose the knowledge base as an MCP server (Max). */
  mcp: boolean;
  /** Rate limit for the MCP endpoint (0 = no MCP access). */
  mcpRequestsPerMinute: number;
  /** Whether the "powered by Dejavue" branding is removed. */
  removeBranding: boolean;
  /**
   * Whether the public knowledge base carries ads. True on Free only — removing them
   * is a paid perk, alongside removing the branding. Deliberately separate from
   * {@link TierLimits.removeBranding} so the two can be priced apart later.
   */
  ads: boolean;
  /** Monthly AI-credit budget (1 credit = 1,000 tokens; 0 = no AI access). */
  monthlyCredits: number;
  /**
   * Minimum gap between manual reindexes of the same channel. A reindex re-reads a whole
   * channel and re-checks every chunk, so an unthrottled button is the one place a user
   * can repeatedly trigger real embedding spend on demand.
   */
  manualReindexCooldownMs: number;
  /**
   * Monthly ceiling on embedding tokens. This is a runaway guard, not the product
   * limit — {@link TierLimits.indexCap} is what bounds how much a guild can index.
   * This exists so pathological churn (repeatedly removing and re-adding channels,
   * a reindex loop) cannot turn a free guild into an unbounded bill. Enforced
   * fail-CLOSED on Free and fail-OPEN (log + alert) on paid tiers.
   */
  monthlyEmbedTokens: number;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export const DEFAULT_QUOTAS = {
  // Sized so worst-case inference stays a small fraction of the subscription price at
  // full utilisation — and typical utilisation is far below the cap. The previous Plus
  // budget (25 credits ≈ 30 drafts/month) cost fractions of a cent and made the tier
  // feel broken within days. Re-check these against the current OpenRouter price.
  plusCredits: 250,
  proCredits: 2_500,
  maxCredits: 12_000,
  mcpRequestsPerMinute: 30,
  // Sized at roughly 5x a full re-index of the tier's index cap, so normal use (including
  // the occasional full reindex) never reaches them and only runaway churn does.
  freeEmbedTokens: 500_000,
  plusEmbedTokens: 5_000_000,
  proEmbedTokens: 50_000_000,
  maxEmbedTokens: 200_000_000,
} as const satisfies Required<TierQuotas>;

/**
 * The gating matrix.
 *
 * Guiding rule: anything already bounded by a real meter must NOT also carry a boolean
 * gate. Credits meter inference; `indexCap` meters embedding spend. Everything else —
 * search, analytics, nudges, channel counts, theming — costs nothing per guild, so
 * withholding it buys no margin and only makes the product look broken to the servers
 * most likely to grow into paying ones.
 *
 * What Free deliberately does NOT get is the spend itself (`monthlyCredits: 0`) and the
 * branding removal, which is the trade for everything it does get.
 */
export function tierLimits(tier: Tier, quotas: TierQuotas = {}): TierLimits {
  const q = { ...DEFAULT_QUOTAS, ...quotas };
  switch (tier) {
    case 'max':
      return {
        maxForumChannels: UNLIMITED,
        maxTrackedChannels: UNLIMITED,
        indexCap: UNLIMITED,
        semanticSearch: true,
        nudges: true,
        aiDrafts: true,
        generative: true,
        kbSummarizedAnswers: true,
        mcp: true,
        mcpRequestsPerMinute: q.mcpRequestsPerMinute,
        removeBranding: true,
        ads: false,
        monthlyCredits: q.maxCredits,
        manualReindexCooldownMs: 1 * 60 * 60 * 1000,
        monthlyEmbedTokens: q.maxEmbedTokens,
      };
    case 'pro':
      return {
        // Generous but finite — only Max is unlimited.
        maxForumChannels: 50,
        maxTrackedChannels: 50,
        indexCap: 250_000,
        semanticSearch: true,
        nudges: true,
        aiDrafts: true,
        generative: true,
        kbSummarizedAnswers: true,
        // MCP is search-only (no inference) and already rate-limited, so holding it at
        // Max forfeited the developer communities most likely to adopt it. Max keeps
        // unlimited scale + the custom domain as its story.
        mcp: true,
        mcpRequestsPerMinute: q.mcpRequestsPerMinute,
        removeBranding: true,
        ads: false,
        monthlyCredits: q.proCredits,
        manualReindexCooldownMs: 1 * 60 * 60 * 1000,
        monthlyEmbedTokens: q.proEmbedTokens,
      };
    case 'plus':
      return {
        maxForumChannels: 15,
        maxTrackedChannels: 15,
        indexCap: 25_000,
        semanticSearch: true,
        nudges: true,
        aiDrafts: true,
        // The generative suite is already metered by the credit budget; a second boolean
        // gate on top just double-charged for the same cost — and left Plus KB pages
        // rendering raw answers, which is worse SEO on pages carrying our branding.
        generative: true,
        kbSummarizedAnswers: true,
        mcp: false,
        mcpRequestsPerMinute: 0,
        removeBranding: true,
        ads: false,
        monthlyCredits: q.plusCredits,
        manualReindexCooldownMs: 6 * 60 * 60 * 1000,
        monthlyEmbedTokens: q.plusEmbedTokens,
      };
    case 'free':
    default:
      return {
        // Channel counts cost nothing — indexCap already bounds total embedding volume,
        // so capping both charged twice for one resource.
        maxForumChannels: 3,
        maxTrackedChannels: 3,
        // The one Free limit that reflects real spend. Free guilds were always indexed
        // (embedThread has no tier check) and then forbidden from querying the vectors
        // we had already paid for; the cap, not the search switch, is the right lever.
        indexCap: 2_500,
        semanticSearch: true,
        nudges: true,
        // No inference on Free. This is where the money actually goes.
        aiDrafts: false,
        generative: false,
        kbSummarizedAnswers: false,
        mcp: false,
        mcpRequestsPerMinute: 0,
        // The trade for everything above: Free KBs carry the branding.
        removeBranding: false,
        // Free knowledge bases carry ads; removing them is what Plus buys.
        ads: true,
        monthlyCredits: 0,
        manualReindexCooldownMs: 24 * 60 * 60 * 1000,
        monthlyEmbedTokens: q.freeEmbedTokens,
      };
  }
}

export function isUnlimited(n: number): boolean {
  return !Number.isFinite(n);
}
