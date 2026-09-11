import { describe, expect, it } from 'vitest';
import { __resetBuckets, takeAll, takeToken } from './rateLimit';

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

describe('takeAll (stacked limits)', () => {
  it('consumes from every bucket, so a stricter limit cannot shield a looser one', () => {
    const t0 = 5_000_000;
    // Per-IP allows 5, per-tenant allows 2 — the tenant ceiling must bind.
    for (let i = 0; i < 2; i++) {
      expect(takeAll([{ key: 'ip-a', perMinute: 5 }, { key: 'tenant', perMinute: 2 }], t0)).toBe(true);
    }
    expect(takeAll([{ key: 'ip-a', perMinute: 5 }, { key: 'tenant', perMinute: 2 }], t0)).toBe(false);
  });

  it('keeps charging a refused request against every bucket (no short-circuit)', () => {
    // Otherwise a caller who is already over one limit would ride free on the others.
    const t0 = 6_000_000;
    takeAll([{ key: 'x-narrow', perMinute: 1 }, { key: 'x-wide', perMinute: 3 }], t0);
    takeAll([{ key: 'x-narrow', perMinute: 1 }, { key: 'x-wide', perMinute: 3 }], t0); // refused
    takeAll([{ key: 'x-narrow', perMinute: 1 }, { key: 'x-wide', perMinute: 3 }], t0); // refused
    // x-wide has now been charged three times despite x-narrow refusing.
    expect(takeToken('x-wide', 3, t0)).toBe(false);
  });

  it('a forged per-visitor key cannot lift the non-forgeable tenant ceiling', () => {
    // The shape of the search-page fix: rotating the IP half of the key buys fresh
    // per-visitor allowance, but the per-tenant bucket still runs dry.
    const t0 = 7_000_000;
    let allowed = 0;
    for (let i = 0; i < 50; i++) {
      if (takeAll([{ key: `spoof-${i}`, perMinute: 20 }, { key: 'ceiling', perMinute: 10 }], t0)) allowed++;
    }
    expect(allowed).toBe(10);
  });
});

describe('bucket eviction', () => {
  it('evicting for capacity does not reset an actively used bucket', () => {
    // The regression: this used to clear() the whole map, so minting 10k keys reset
    // every OTHER tenant's limit too — an amplification primitive, not just a leak.
    const t0 = 8_000_000;
    __resetBuckets();
    expect(takeToken('victim', 2, t0)).toBe(true);
    expect(takeToken('victim', 2, t0)).toBe(true);
    expect(takeToken('victim', 2, t0)).toBe(false); // drained

    // Flood past MAX_BUCKETS, touching the victim often enough to stay recently-used.
    for (let i = 0; i < 12_000; i++) {
      takeToken(`flood-${i}`, 100, t0);
      if (i % 500 === 0) takeToken('victim', 2, t0);
    }

    // Still drained: the flood must not have handed the victim a fresh bucket.
    expect(takeToken('victim', 2, t0)).toBe(false);
    __resetBuckets();
  });
});
