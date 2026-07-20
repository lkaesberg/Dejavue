import { describe, expect, it } from 'vitest';
import { channelCapUpsellLine } from './upsell';

// Doubles as a drift guard: if tierLimits channel caps change, these strings (and the
// pricing page) need a review.
describe('channelCapUpsellLine', () => {
  it('derives forum caps from tierLimits', () => {
    expect(channelCapUpsellLine('forum')).toBe(
      'Upgrade to **Plus** (5), **Pro** (10), or **Max** (unlimited).',
    );
  });

  it('derives tracked-channel caps from tierLimits', () => {
    expect(channelCapUpsellLine('tracked')).toBe(
      'Upgrade to **Plus** (5), **Pro** (15), or **Max** (unlimited).',
    );
  });
});
