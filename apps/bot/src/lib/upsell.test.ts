import { describe, expect, it } from 'vitest';
import { channelCapUpsellLine } from './upsell';

// Doubles as a drift guard: if tierLimits channel caps change, these strings (and the
// pricing page) need a review.
describe('channelCapUpsellLine', () => {
  it('derives forum caps from tierLimits', () => {
    expect(channelCapUpsellLine('forum')).toBe(
      'Upgrade to **Plus** (15), **Pro** (50), or **Max** (unlimited).',
    );
  });

  it('derives tracked-channel caps from tierLimits', () => {
    expect(channelCapUpsellLine('tracked')).toBe(
      'Upgrade to **Plus** (15), **Pro** (50), or **Max** (unlimited).',
    );
  });
});
