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
});
