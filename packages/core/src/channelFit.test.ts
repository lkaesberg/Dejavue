import { describe, expect, it } from 'vitest';
import { FIT_MARGIN, FIT_MIN_BEST, suggestBetterChannel } from './channelFit';

describe('suggestBetterChannel', () => {
  it('suggests a clearly better-fitting channel', () => {
    const scores = [
      { channelId: 'general', score: 0.3 },
      { channelId: 'billing', score: 0.72 },
    ];
    const s = suggestBetterChannel(scores, 'general');
    expect(s).not.toBeNull();
    expect(s?.channelId).toBe('billing');
    expect(s?.currentScore).toBe(0.3);
  });

  it('does not suggest when the current channel is already the best fit', () => {
    const scores = [
      { channelId: 'billing', score: 0.8 },
      { channelId: 'general', score: 0.4 },
    ];
    expect(suggestBetterChannel(scores, 'billing')).toBeNull();
  });

  it('requires a margin — near-ties are left alone', () => {
    const scores = [
      { channelId: 'a', score: 0.5 },
      { channelId: 'b', score: 0.5 + FIT_MARGIN / 2 },
    ];
    expect(suggestBetterChannel(scores, 'a')).toBeNull();
  });

  it('does not suggest a channel that is irrelevant to everything (below the floor)', () => {
    const scores = [
      { channelId: 'a', score: 0.02 },
      { channelId: 'b', score: FIT_MIN_BEST - 0.01 },
    ];
    expect(suggestBetterChannel(scores, 'a')).toBeNull();
  });

  it('returns null when the current channel has no topic to compare against', () => {
    const scores = [{ channelId: 'b', score: 0.9 }];
    expect(suggestBetterChannel(scores, 'current-without-topic')).toBeNull();
  });

  it('only suggests among the allowed candidates (e.g. question channels)', () => {
    const scores = [
      { channelId: 'general', score: 0.3 },
      { channelId: 'knowledge', score: 0.9 }, // best, but not a candidate
      { channelId: 'support', score: 0.7 },
    ];
    const s = suggestBetterChannel(scores, 'general', new Set(['general', 'support']));
    expect(s?.channelId).toBe('support'); // knowledge excluded despite the higher score
  });
});
