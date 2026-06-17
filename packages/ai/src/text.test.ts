import { describe, expect, it } from 'vitest';
import { findAnswerIndex } from './text';

describe('findAnswerIndex', () => {
  it('returns -1 for an empty answer or no match', () => {
    expect(findAnswerIndex(['a', 'b'], '')).toBe(-1);
    expect(findAnswerIndex(['a', 'b'], '   ')).toBe(-1);
    expect(findAnswerIndex(['a', 'b'], 'something paraphrased entirely')).toBe(-1);
  });

  it('matches an exact message, preferring the last occurrence', () => {
    const msgs = ['restart it', 'noise', 'restart it'];
    expect(findAnswerIndex(msgs, 'restart it')).toBe(2);
  });

  it('does NOT match a short answer as a substring of an unrelated line', () => {
    // "ok" must not match because the long message merely contains it ("tokens").
    const msgs = ['How do I auth?', 'Set the timeout and refresh tokens.'];
    expect(findAnswerIndex(msgs, 'ok')).toBe(-1);
  });

  it('does NOT match when a short message is a substring of a longer answer', () => {
    // The dropped inverse direction: a one-word reply must not be tagged as the answer.
    const msgs = ['ok', 'The real fix is to pin the lockfile.'];
    // exact match wins for the real answer; the short "ok" is never chosen.
    expect(findAnswerIndex(msgs, 'The real fix is to pin the lockfile.')).toBe(1);
  });

  it('matches a substantial answer contained in a message (with surrounding text)', () => {
    const answer = 'pin the lockfile and delete node_modules';
    const msgs = ['I had this too', `Fix: ${answer}. That worked!`];
    expect(findAnswerIndex(msgs, answer)).toBe(1);
  });

  it('prefers a later quote over an earlier one (resolution clusters at the end)', () => {
    const answer = 'clear the cache and rebuild from scratch';
    const msgs = [`maybe: ${answer}?`, 'noise', `${answer} — that fixed it`];
    expect(findAnswerIndex(msgs, answer)).toBe(2);
  });
});
