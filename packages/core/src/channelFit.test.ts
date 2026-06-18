import { describe, expect, it } from 'vitest';
import { FIT_MARGIN, FIT_MIN_BEST, GUARD_THRESHOLDS, judgeWrongChannel, suggestBetterChannel } from './channelFit';

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

describe('judgeWrongChannel', () => {
  it('flags a confidently misfiled post (low current fit, strong other, big gap)', () => {
    const scores = [
      { channelId: 'general', score: 0.1 },
      { channelId: 'billing', score: 0.6 },
    ];
    const v = judgeWrongChannel(scores, 'general', 'medium');
    expect(v?.channelId).toBe('billing');
    expect(v?.currentScore).toBe(0.1);
  });

  it('does NOT flag when the post fits its current channel well enough', () => {
    const scores = [
      { channelId: 'billing', score: 0.45 }, // above medium currentMax (0.28)
      { channelId: 'general', score: 0.7 },
    ];
    expect(judgeWrongChannel(scores, 'billing', 'medium')).toBeNull();
  });

  it('does NOT flag when no other channel is clearly relevant', () => {
    const scores = [
      { channelId: 'general', score: 0.1 },
      { channelId: 'billing', score: GUARD_THRESHOLDS.medium.bestMin - 0.05 },
    ];
    expect(judgeWrongChannel(scores, 'general', 'medium')).toBeNull();
  });

  it('high sensitivity flags borderline cases that medium leaves alone', () => {
    const scores = [
      { channelId: 'general', score: 0.3 },
      { channelId: 'billing', score: 0.43 },
    ];
    // current 0.3 > medium.currentMax (0.28) → medium ignores; high.currentMax 0.34 → high flags.
    expect(judgeWrongChannel(scores, 'general', 'medium')).toBeNull();
    expect(judgeWrongChannel(scores, 'general', 'high')?.channelId).toBe('billing');
  });

  it('respects candidate filtering', () => {
    const scores = [
      { channelId: 'general', score: 0.1 },
      { channelId: 'knowledge', score: 0.9 }, // best but not a candidate
      { channelId: 'support', score: 0.55 },
    ];
    const v = judgeWrongChannel(scores, 'general', 'medium', new Set(['general', 'support']));
    expect(v?.channelId).toBe('support');
  });
});
