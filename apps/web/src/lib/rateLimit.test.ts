import { describe, expect, it } from 'vitest';
import { takeToken } from './rateLimit';

describe('takeToken', () => {
  it('allows a burst up to the per-minute capacity, then rejects', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(takeToken('burst', 5, t0)).toBe(true);
    expect(takeToken('burst', 5, t0)).toBe(false);
  });

  it('refills proportionally with elapsed time', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 5; i++) takeToken('refill', 5, t0);
    expect(takeToken('refill', 5, t0)).toBe(false);
    // 12 seconds later at 5/min → one token back.
    expect(takeToken('refill', 5, t0 + 12_000)).toBe(true);
    expect(takeToken('refill', 5, t0 + 12_000)).toBe(false);
  });

  it('caps refill at capacity', () => {
    const t0 = 3_000_000;
    takeToken('cap', 2, t0);
    // An hour later there are still only 2 tokens.
    expect(takeToken('cap', 2, t0 + 3_600_000)).toBe(true);
    expect(takeToken('cap', 2, t0 + 3_600_000)).toBe(true);
    expect(takeToken('cap', 2, t0 + 3_600_000)).toBe(false);
  });

  it('rejects everything when the limit is 0 (no access)', () => {
    expect(takeToken('none', 0)).toBe(false);
  });

  it('tracks keys independently', () => {
    const t0 = 4_000_000;
    expect(takeToken('a', 1, t0)).toBe(true);
    expect(takeToken('b', 1, t0)).toBe(true);
    expect(takeToken('a', 1, t0)).toBe(false);
  });
});
