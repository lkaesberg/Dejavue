import { describe, expect, it } from 'vitest';
import { MIN_SEGMENT_MSGS, SEGMENT_GAP_MS, segmentByGap, segmentTitle } from './segment';

const at = (minutesFromEpoch: number): string => new Date(minutesFromEpoch * 60_000).toISOString();

describe('segmentByGap', () => {
  it('keeps messages within the gap window in one segment', () => {
    const msgs = [{ createdAt: at(0) }, { createdAt: at(5) }, { createdAt: at(15) }];
    const segs = segmentByGap(msgs);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveLength(3);
  });

  it('starts a new segment after a >20-minute silence', () => {
    const msgs = [
      { createdAt: at(0) },
      { createdAt: at(10) },
      { createdAt: at(40) }, // 30-min gap → new segment
      { createdAt: at(45) },
    ];
    const segs = segmentByGap(msgs);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
  });

  it('treats exactly the gap threshold as the same segment (boundary is strictly greater)', () => {
    const msgs = [{ createdAt: at(0) }, { createdAt: new Date(SEGMENT_GAP_MS).toISOString() }];
    expect(segmentByGap(msgs)).toHaveLength(1);
  });

  it('returns no segments for an empty list', () => {
    expect(segmentByGap([])).toEqual([]);
  });
});

describe('segmentTitle', () => {
  it('falls back to "Conversation" when empty', () => {
    expect(segmentTitle(undefined)).toBe('Conversation');
    expect(segmentTitle('   ')).toBe('Conversation');
  });

  it('collapses whitespace and truncates long titles', () => {
    expect(segmentTitle('hello   world')).toBe('hello world');
    const long = 'a'.repeat(200);
    const title = segmentTitle(long);
    expect(title.length).toBe(118); // 117 chars + ellipsis
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('segmentation constants', () => {
  it('uses a 20-minute gap and indexes single-message segments', () => {
    expect(SEGMENT_GAP_MS).toBe(20 * 60 * 1000);
    // 1, deliberately: a standalone message is the whole conversation in a
    // sparse channel — a 2-minimum made such channels index nothing at setup.
    expect(MIN_SEGMENT_MSGS).toBe(1);
  });
});
