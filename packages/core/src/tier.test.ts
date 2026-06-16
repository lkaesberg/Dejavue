import { describe, expect, it } from 'vitest';
import { deriveTier, isEntitlementActive } from './tier';
import { tierLimits, tierAtLeast } from './types';

const SKUS = { plus: 'sku_plus', pro: 'sku_pro' };
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

  it('ignores expired entitlements', () => {
    expect(deriveTier([{ skuId: 'sku_pro', endsAt: '2026-01-01T00:00:00Z' }], SKUS, NOW)).toBe('free');
  });

  it('honors a future end date (cancelled but not yet lapsed)', () => {
    expect(deriveTier([{ skuId: 'sku_pro', endsAt: '2026-12-01T00:00:00Z' }], SKUS, NOW)).toBe('pro');
  });
});

describe('tierLimits', () => {
  it('caps the public KB at 10 / 100 / unlimited', () => {
    expect(tierLimits('free').kbPageCap).toBe(10);
    expect(tierLimits('plus').kbPageCap).toBe(100);
    expect(tierLimits('pro').kbPageCap).toBe(Number.POSITIVE_INFINITY);
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
  });
});
