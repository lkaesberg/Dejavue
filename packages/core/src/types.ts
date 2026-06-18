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
 * Per-tier feature limits. `Infinity` means unlimited. These encode the
 * tier-gating matrix from the plan in one place so every consumer agrees.
 */
export interface TierLimits {
  /** Number of forum channels Dejavue will monitor. */
  maxForumChannels: number;
  /** Number of tracked *normal* (non-forum) channels indexed as searchable KBs. */
  maxTrackedChannels: number;
  /** Cap on indexed conversation segments captured from tracked normal channels. */
  trackedDocCap: number;
  /** In-Discord searchable archive cap (solved threads indexed for /search). */
  archiveCap: number;
  /** Public web KB published-page cap. */
  kbPageCap: number;
  /** Semantic (embedding) dedup + search, vs keyword-only. */
  semanticSearch: boolean;
  /** Stale-question nudges. */
  nudges: boolean;
  analytics: AnalyticsLevel;
  /** Generative AI (drafting / summarization / clustering / FAQ). */
  generative: boolean;
  /** KB pages render the AI-summarized canonical answer (Pro) vs the raw answer. */
  kbSummarizedAnswers: boolean;
  /** Expose the knowledge base as an MCP server (Pro). */
  mcp: boolean;
  /** Whether the "powered by Dejavue" branding is removed. */
  removeBranding: boolean;
  /** Monthly generative quota (0 = no generative access). */
  monthlyGenerationQuota: number;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export function tierLimits(tier: Tier, proMonthlyQuota = 300): TierLimits {
  switch (tier) {
    case 'max':
      return {
        maxForumChannels: UNLIMITED,
        maxTrackedChannels: UNLIMITED,
        trackedDocCap: UNLIMITED,
        archiveCap: UNLIMITED,
        kbPageCap: UNLIMITED,
        semanticSearch: true,
        nudges: true,
        analytics: 'full',
        generative: true,
        kbSummarizedAnswers: true,
        mcp: true,
        removeBranding: true,
        // Max gets a far larger generation quota than Pro.
        monthlyGenerationQuota: proMonthlyQuota * 5,
      };
    case 'pro':
      return {
        // Generous but finite — only Max is unlimited.
        maxForumChannels: 5,
        maxTrackedChannels: 10,
        trackedDocCap: 5000,
        archiveCap: 2500,
        kbPageCap: 500,
        semanticSearch: true,
        nudges: true,
        analytics: 'full',
        generative: true,
        kbSummarizedAnswers: true,
        mcp: false,
        removeBranding: true,
        monthlyGenerationQuota: proMonthlyQuota,
      };
    case 'plus':
      return {
        maxForumChannels: 3,
        maxTrackedChannels: 3,
        trackedDocCap: 1000,
        archiveCap: 1500,
        kbPageCap: 100,
        semanticSearch: true,
        nudges: true,
        analytics: 'full',
        generative: false,
        kbSummarizedAnswers: false,
        mcp: false,
        removeBranding: true,
        monthlyGenerationQuota: 0,
      };
    case 'free':
    default:
      return {
        maxForumChannels: 1,
        maxTrackedChannels: 1,
        trackedDocCap: 200,
        archiveCap: 500,
        kbPageCap: 10,
        semanticSearch: false,
        nudges: false,
        analytics: 'basic',
        generative: false,
        kbSummarizedAnswers: false,
        mcp: false,
        removeBranding: false,
        monthlyGenerationQuota: 0,
      };
  }
}

export function isUnlimited(n: number): boolean {
  return !Number.isFinite(n);
}
