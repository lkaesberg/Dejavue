import { describe, expect, it } from 'vitest';
import {
  isTopUpSku,
  TOP_UP_PACK_CREDITS,
  topUpCreditsForSku,
  topUpTiers,
} from './topup';

const FULL = {
  SKU_TOPUP_500: 'sku_500',
  SKU_TOPUP_1000: 'sku_1000',
  SKU_TOPUP_2000: 'sku_2000',
  SKU_TOPUP_5000: 'sku_5000',
};

describe('topUpTiers', () => {
  it('returns configured packs ascending, mapped to their fixed credit amounts', () => {
    expect(topUpTiers(FULL)).toEqual([
      { credits: 500, skuId: 'sku_500' },
      { credits: 1000, skuId: 'sku_1000' },
      { credits: 2000, skuId: 'sku_2000' },
      { credits: 5000, skuId: 'sku_5000' },
    ]);
  });

  it('omits packs whose SKU id is unset (nothing configured → empty)', () => {
    expect(topUpTiers({})).toEqual([]);
    expect(topUpTiers({ SKU_TOPUP_1000: 'only_1k' })).toEqual([
      { credits: 1000, skuId: 'only_1k' },
    ]);
  });

  it('keeps ascending order even when a middle pack is missing', () => {
    const tiers = topUpTiers({ SKU_TOPUP_5000: 'big', SKU_TOPUP_500: 'small' });
    expect(tiers.map((t) => t.credits)).toEqual([500, 5000]);
  });

  it('covers every declared pack size', () => {
    expect(topUpTiers(FULL).map((t) => t.credits)).toEqual([...TOP_UP_PACK_CREDITS]);
  });
});

describe('topUpCreditsForSku', () => {
  it('resolves a pack SKU to its credit amount', () => {
    expect(topUpCreditsForSku(FULL, 'sku_2000')).toBe(2000);
  });

  it('returns undefined for a non-top-up SKU (so callers can distinguish 0-credit)', () => {
    expect(topUpCreditsForSku(FULL, 'sku_pro')).toBeUndefined();
    expect(topUpCreditsForSku({}, 'sku_500')).toBeUndefined();
  });
});

describe('isTopUpSku', () => {
  it('is true only for a configured pack id', () => {
    expect(isTopUpSku(FULL, 'sku_5000')).toBe(true);
    expect(isTopUpSku(FULL, 'sku_custom_domain')).toBe(false);
    expect(isTopUpSku({ SKU_TOPUP_500: 'sku_500' }, 'sku_1000')).toBe(false);
  });
});
