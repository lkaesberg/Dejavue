/** The three monetization tiers, gated by Discord Premium Apps entitlements. */
export type Tier = 'free' | 'plus' | 'pro' | 'max';

export const TIERS = ['free', 'plus', 'pro', 'max'] as const;

/** Ordering so we can express "at least Plus" as a numeric comparison. */
export const TIER_RANK: Record<Tier, number> = { free: 0, plus: 1, pro: 2, max: 3 };

export function tierAtLeast(tier: Tier, min: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

export type AnalyticsLevel = 'basic' | 'full';

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
}): Required<TierQuotas> {
  return {
    plusCredits: env.QUOTA_CREDITS_PLUS,
    proCredits: env.QUOTA_CREDITS_PRO,
    maxCredits: env.QUOTA_CREDITS_MAX,
    mcpRequestsPerMinute: env.MCP_RATE_PER_MIN,
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
  analytics: AnalyticsLevel;
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
  /** Monthly AI-credit budget (1 credit = 1,000 tokens; 0 = no AI access). */
  monthlyCredits: number;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export const DEFAULT_QUOTAS = {
  plusCredits: 25,
  proCredits: 1_000,
  maxCredits: 5_000,
  mcpRequestsPerMinute: 30,
} as const satisfies Required<TierQuotas>;

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
        analytics: 'full',
        aiDrafts: true,
        generative: true,
        kbSummarizedAnswers: true,
        mcp: true,
        mcpRequestsPerMinute: q.mcpRequestsPerMinute,
        removeBranding: true,
        monthlyCredits: q.maxCredits,
      };
    case 'pro':
      return {
        // Generous but finite — only Max is unlimited.
        maxForumChannels: 10,
        maxTrackedChannels: 15,
        indexCap: 50_000,
        semanticSearch: true,
        nudges: true,
        analytics: 'full',
        aiDrafts: true,
        generative: true,
        kbSummarizedAnswers: true,
        mcp: false,
        mcpRequestsPerMinute: 0,
        removeBranding: true,
        monthlyCredits: q.proCredits,
      };
    case 'plus':
      return {
        maxForumChannels: 5,
        maxTrackedChannels: 5,
        indexCap: 5_000,
        semanticSearch: true,
        nudges: true,
        analytics: 'full',
        // Taster: in-channel AI drafts only, on a small credit budget — the
        // full generative suite (summaries/FAQ/gaps) stays Pro+.
        aiDrafts: true,
        generative: false,
        kbSummarizedAnswers: false,
        mcp: false,
        mcpRequestsPerMinute: 0,
        removeBranding: true,
        monthlyCredits: q.plusCredits,
      };
    case 'free':
    default:
      return {
        maxForumChannels: 1,
        maxTrackedChannels: 1,
        indexCap: 500,
        semanticSearch: false,
        nudges: false,
        analytics: 'basic',
        aiDrafts: false,
        generative: false,
        kbSummarizedAnswers: false,
        mcp: false,
        mcpRequestsPerMinute: 0,
        removeBranding: false,
        monthlyCredits: 0,
      };
  }
}

export function isUnlimited(n: number): boolean {
  return !Number.isFinite(n);
}
