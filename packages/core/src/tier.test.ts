import { describe, expect, it } from 'vitest';
import { deriveTier, isEntitlementActive } from './tier';
import { tierLimits, tierAtLeast } from './types';

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
  it('caps the public KB at 10 / 100 / 500 / unlimited', () => {
    expect(tierLimits('free').kbPageCap).toBe(10);
    expect(tierLimits('plus').kbPageCap).toBe(100);
    expect(tierLimits('pro').kbPageCap).toBe(500);
    expect(tierLimits('max').kbPageCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('caps forum channels at 1 / 3 / 5 / unlimited', () => {
    expect(tierLimits('free').maxForumChannels).toBe(1);
    expect(tierLimits('plus').maxForumChannels).toBe(3);
    expect(tierLimits('pro').maxForumChannels).toBe(5);
    expect(tierLimits('max').maxForumChannels).toBe(Number.POSITIVE_INFINITY);
  });

  it('caps the searchable archive at 500 / 1,500 / 2,500 / unlimited', () => {
    expect(tierLimits('free').archiveCap).toBe(500);
    expect(tierLimits('plus').archiveCap).toBe(1500);
    expect(tierLimits('pro').archiveCap).toBe(2500);
    expect(tierLimits('max').archiveCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('reserves unlimited caps for max only', () => {
    for (const t of ['free', 'plus', 'pro'] as const) {
      const l = tierLimits(t);
      expect(Number.isFinite(l.maxForumChannels)).toBe(true);
      expect(Number.isFinite(l.archiveCap)).toBe(true);
      expect(Number.isFinite(l.kbPageCap)).toBe(true);
    }
    const max = tierLimits('max');
    expect(max.maxForumChannels).toBe(Number.POSITIVE_INFINITY);
    expect(max.archiveCap).toBe(Number.POSITIVE_INFINITY);
    expect(max.kbPageCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('reserves MCP for the max tier only', () => {
    expect(tierLimits('pro').mcp).toBe(false);
    expect(tierLimits('max').mcp).toBe(true);
  });

  it('gives max a larger quota than pro', () => {
    expect(tierLimits('max', 300).monthlyGenerationQuota).toBe(1500);
    expect(tierLimits('pro', 300).monthlyGenerationQuota).toBe(300);
  });

  it('reserves generative + summarized KB answers for pro', () => {
    expect(tierLimits('plus').generative).toBe(false);
    expect(tierLimits('pro').generative).toBe(true);
    expect(tierLimits('pro').kbSummarizedAnswers).toBe(true);
  });

  it('only free shows branding', () => {
    expect(tierLimits('free').removeBranding).toBe(false);
    expect(tierLimits('plus').removeBranding).toBe(true);
  });

  it('passes the configured pro quota through', () => {
    expect(tierLimits('pro', 500).monthlyGenerationQuota).toBe(500);
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
