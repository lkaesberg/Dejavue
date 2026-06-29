import { describe, expect, it } from 'vitest';
import { isReembedDue } from './knowledge';

describe('isReembedDue (knowledge re-embed backoff)', () => {
  it('always embeds the first time (never embedded)', () => {
    expect(isReembedDue(1, null)).toBe(true);
    expect(isReembedDue(0, null)).toBe(true);
    expect(isReembedDue(50, 0)).toBe(true);
  });

  it('only re-embeds once the count has quadrupled', () => {
    expect(isReembedDue(1, 1)).toBe(false); // 1 → need 4
    expect(isReembedDue(3, 1)).toBe(false);
    expect(isReembedDue(4, 1)).toBe(true);
    expect(isReembedDue(15, 4)).toBe(false); // 4 → need 16
    expect(isReembedDue(16, 4)).toBe(true);
    expect(isReembedDue(63, 16)).toBe(false); // 16 → need 64
    expect(isReembedDue(64, 16)).toBe(true);
  });

  it('follows a quadrupling sequence 1→4→16→64→… (~half as many scans as doubling)', () => {
    const fired: number[] = [];
    let last = 0;
    for (let count = 1; count <= 300; count++) {
      if (isReembedDue(count, last)) {
        fired.push(count);
        last = count;
      }
    }
    // Quadruplings up to and including the 256 cap; nothing fires after last hits 256.
    expect(fired).toEqual([1, 4, 16, 64, 256]);
  });

  it('stops re-embedding once the cap is reached (topic settled)', () => {
    expect(isReembedDue(256, 256)).toBe(false);
    expect(isReembedDue(1000, 256)).toBe(false);
    expect(isReembedDue(5000, 512)).toBe(false);
  });

  it('re-embeds on an in-place content change (edit/delete: count did not grow)', () => {
    // Edit on a small thread: count unchanged + dirty → re-embed (would otherwise wait for 4×).
    expect(isReembedDue(1, 1)).toBe(false);
    expect(isReembedDue(1, 1, true)).toBe(true);
    // Edit on a settled thread (past the cap): still re-embeds.
    expect(isReembedDue(256, 256, true)).toBe(true);
    // Delete (count dropped) on a settled thread: re-embeds.
    expect(isReembedDue(200, 256, true)).toBe(true);
  });

  it('keeps pure growth on the backoff even when the hash changed (fewer re-embeds)', () => {
    // New messages change the embed text (dirty) but count grew past last → still backoff.
    expect(isReembedDue(2, 1, true)).toBe(false); // 1 → needs 4
    expect(isReembedDue(300, 256, true)).toBe(false); // settled cap holds for growth
  });
});
