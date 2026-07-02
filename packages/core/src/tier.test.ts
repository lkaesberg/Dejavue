import { describe, expect, it } from 'vitest';
import { activeForumChannels, isMonitoredForum } from './channels';
import { deriveTier, isEntitlementActive } from './tier';
import {
  computeSpill,
  CREDIT_TOKENS,
  creditsToTokens,
  tierAtLeast,
  tierLimits,
  tokensToCredits,
} from './types';

const SKUS = { plus: 'sku_plus', pro: 'sku_pro', max: 'sku_max' };
const NOW = new Date('2026-06-16T00:00:00Z');

describe('isEntitlementActive', () => {
  it('treats a null end date as active (live sub or test entitlement)', () => {
    expect(isEntitlementActive({ skuId: 'x', endsAt: null }, NOW)).toBe(true);
    expect(isEntitlementActive({ skuId: 'x' }, NOW)).toBe(true);
  });

  it('treats a future end date as active (lapsed-at-period-end sub still valid)', () => {
    expect(isEntitlementActive({ skuId: 'x', endsAt: '2026-07-01T00:00:00Z' }, NOW)).toBe(true);
  });

  it('treats a past end date as inactive', () => {
    expect(isEntitlementActive({ skuId: 'x', endsAt: '2026-06-01T00:00:00Z' }, NOW)).toBe(false);
  });

  it('treats a deleted entitlement as inactive even with no end date', () => {
    expect(isEntitlementActive({ skuId: 'x', endsAt: null, deleted: true }, NOW)).toBe(false);
  });
});

describe('deriveTier', () => {
  it('returns free with no entitlements', () => {
    expect(deriveTier([], SKUS, NOW)).toBe('free');
  });

  it('returns plus for an active plus entitlement', () => {
    expect(deriveTier([{ skuId: 'sku_plus', endsAt: null }], SKUS, NOW)).toBe('plus');
  });

  it('returns pro for an active pro entitlement', () => {
    expect(deriveTier([{ skuId: 'sku_pro', endsAt: null }], SKUS, NOW)).toBe('pro');
  });

  it('lets pro win when both are active', () => {
    expect(
      deriveTier([{ skuId: 'sku_plus', endsAt: null }, { skuId: 'sku_pro', endsAt: null }], SKUS, NOW),
    ).toBe('pro');
  });

  it('returns max for an active max entitlement', () => {
    expect(deriveTier([{ skuId: 'sku_max', endsAt: null }], SKUS, NOW)).toBe('max');
  });

  it('lets max win over pro and plus', () => {
    expect(
      deriveTier(
        [
          { skuId: 'sku_plus', endsAt: null },
          { skuId: 'sku_pro', endsAt: null },
          { skuId: 'sku_max', endsAt: null },
        ],
        SKUS,
        NOW,
      ),
    ).toBe('max');
  });

  it('ignores expired entitlements', () => {
    expect(deriveTier([{ skuId: 'sku_pro', endsAt: '2026-01-01T00:00:00Z' }], SKUS, NOW)).toBe('free');
  });

  it('honors a future end date (cancelled but not yet lapsed)', () => {
    expect(deriveTier([{ skuId: 'sku_pro', endsAt: '2026-12-01T00:00:00Z' }], SKUS, NOW)).toBe('pro');
  });
});

describe('tierLimits', () => {
  it('caps the total index at 500 / 5k / 50k / unlimited messages', () => {
    expect(tierLimits('free').indexCap).toBe(500);
    expect(tierLimits('plus').indexCap).toBe(5_000);
    expect(tierLimits('pro').indexCap).toBe(50_000);
    expect(tierLimits('max').indexCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('caps forum channels at 1 / 5 / 10 / unlimited', () => {
    expect(tierLimits('free').maxForumChannels).toBe(1);
    expect(tierLimits('plus').maxForumChannels).toBe(5);
    expect(tierLimits('pro').maxForumChannels).toBe(10);
    expect(tierLimits('max').maxForumChannels).toBe(Number.POSITIVE_INFINITY);
  });

  it('reserves unlimited caps for max only', () => {
    for (const t of ['free', 'plus', 'pro'] as const) {
      const l = tierLimits(t);
      expect(Number.isFinite(l.maxForumChannels)).toBe(true);
      expect(Number.isFinite(l.indexCap)).toBe(true);
    }
    const max = tierLimits('max');
    expect(max.maxForumChannels).toBe(Number.POSITIVE_INFINITY);
    expect(max.indexCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('reserves MCP for the max tier only, with a rate limit', () => {
    expect(tierLimits('pro').mcp).toBe(false);
    expect(tierLimits('pro').mcpRequestsPerMinute).toBe(0);
    expect(tierLimits('max').mcp).toBe(true);
    expect(tierLimits('max').mcpRequestsPerMinute).toBe(30);
  });

  it('budgets AI credits at 0 / 25 / 1000 / 5000 by default', () => {
    expect(tierLimits('free').monthlyCredits).toBe(0);
    expect(tierLimits('plus').monthlyCredits).toBe(25);
    expect(tierLimits('pro').monthlyCredits).toBe(1_000);
    expect(tierLimits('max').monthlyCredits).toBe(5_000);
  });

  it('passes configured credit budgets through', () => {
    const quotas = { plusCredits: 50, proCredits: 2_000, maxCredits: 9_000 };
    expect(tierLimits('plus', quotas).monthlyCredits).toBe(50);
    expect(tierLimits('pro', quotas).monthlyCredits).toBe(2_000);
    expect(tierLimits('max', quotas).monthlyCredits).toBe(9_000);
  });

  it('gives plus the drafts taster but not the full generative suite', () => {
    expect(tierLimits('free').aiDrafts).toBe(false);
    expect(tierLimits('plus').aiDrafts).toBe(true);
    expect(tierLimits('plus').generative).toBe(false);
    expect(tierLimits('pro').aiDrafts).toBe(true);
    expect(tierLimits('pro').generative).toBe(true);
    expect(tierLimits('pro').kbSummarizedAnswers).toBe(true);
  });

  it('only free shows branding', () => {
    expect(tierLimits('free').removeBranding).toBe(false);
    expect(tierLimits('plus').removeBranding).toBe(true);
  });
});

describe('credit conversions', () => {
  it('converts credits to tokens and back (ceiling)', () => {
    expect(creditsToTokens(25)).toBe(25 * CREDIT_TOKENS);
    expect(creditsToTokens(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(tokensToCredits(1)).toBe(1);
    expect(tokensToCredits(1_000)).toBe(1);
    expect(tokensToCredits(1_001)).toBe(2);
    expect(tokensToCredits(0)).toBe(0);
  });
});

describe('computeSpill', () => {
  it('consumes nothing while inside the base budget', () => {
    expect(computeSpill(0, 800, 25)).toBe(0);
    expect(computeSpill(24_000, 1_000, 25)).toBe(0);
  });

  it('bills only the portion past the base budget, rounded up', () => {
    // Base 25 credits = 25k tokens; 24.5k used, 1k cost → 500 tokens spill → 1 credit.
    expect(computeSpill(24_500, 1_000, 25)).toBe(1);
    // Entirely past the base → full cost, ceil'd.
    expect(computeSpill(30_000, 2_500, 25)).toBe(3);
  });

  it('never bills more than the generation itself cost', () => {
    expect(computeSpill(1_000_000, 1_500, 25)).toBe(2);
  });

  it('treats an unlimited base budget as never spilling', () => {
    expect(computeSpill(50_000, 3_000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('activeForumChannels / isMonitoredForum', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('keeps the first N configured channels under a finite cap', () => {
    expect(activeForumChannels(ids, 2)).toEqual(['a', 'b']);
    expect(activeForumChannels(ids, Number.POSITIVE_INFINITY)).toEqual(ids);
    expect(activeForumChannels(ids, 0)).toEqual([]);
  });

  it('monitors everything when no channels are configured (pre-setup default)', () => {
    expect(isMonitoredForum({ forumChannelIds: [] }, 'anything', 1)).toBe(true);
    expect(isMonitoredForum(null, 'anything', 1)).toBe(true);
  });

  it('enforces the downgrade cap at point of use', () => {
    expect(isMonitoredForum({ forumChannelIds: ids }, 'b', 2)).toBe(true);
    expect(isMonitoredForum({ forumChannelIds: ids }, 'c', 2)).toBe(false);
    expect(isMonitoredForum({ forumChannelIds: ids }, 'c', Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('rejects unconfigured channels once any are configured', () => {
    expect(isMonitoredForum({ forumChannelIds: ids }, 'zzz', 10)).toBe(false);
  });
});

describe('tierAtLeast', () => {
  it('orders tiers', () => {
    expect(tierAtLeast('pro', 'plus')).toBe(true);
    expect(tierAtLeast('free', 'plus')).toBe(false);
    expect(tierAtLeast('plus', 'plus')).toBe(true);
    expect(tierAtLeast('max', 'pro')).toBe(true);
  });
});
