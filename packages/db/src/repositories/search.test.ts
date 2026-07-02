import { describe, expect, it } from 'vitest';
import { fuseMatches, type SearchMatch } from './search';

const sem = (rowId: string, score: number): SearchMatch => ({
  rowId,
  threadId: `t-${rowId}`,
  title: rowId,
  channelName: null,
  status: 'solved',
  score,
  kind: 'semantic',
});
const kw = (rowId: string, rank: number): SearchMatch => ({ ...sem(rowId, rank), kind: 'keyword' });

describe('fuseMatches', () => {
  it('boosts semantic results that also match by keyword above meaning-only ones', () => {
    const out = fuseMatches(
      [sem('a', 0.7), sem('b', 0.72)],
      [kw('a', 0.4)], // a is the best (only) keyword hit → full boost
      { limit: 5, minSimilarity: 0.5 },
    );
    expect(out.map((m) => m.rowId)).toEqual(['a', 'b']); // a (0.85) overtakes b (0.72)
    expect(out[0]!.score).toBeCloseTo(0.85);
    expect(out[1]!.score).toBeCloseTo(0.72);
  });

  it('scales the boost by keyword rank relative to the best hit', () => {
    const out = fuseMatches(
      [sem('a', 0.6), sem('b', 0.6)],
      [kw('a', 0.5), kw('b', 0.25)], // b matches half as strongly
      { limit: 5, minSimilarity: 0 },
    );
    expect(out[0]!.rowId).toBe('a');
    expect(out[0]!.score).toBeCloseTo(0.75);
    expect(out[1]!.score).toBeCloseTo(0.675);
  });

  it('lets a strong keyword match lift a borderline candidate over the floor', () => {
    const out = fuseMatches(
      [sem('borderline', 0.62), sem('below', 0.55)],
      [kw('borderline', 0.3)],
      { limit: 5, minSimilarity: 0.65, includeKeywordOnly: false },
    );
    expect(out.map((m) => m.rowId)).toEqual(['borderline']); // 0.62 + 0.15 ≥ 0.65
  });

  it('appends keyword-only hits below semantic results, or drops them when disabled', () => {
    const semantic = [sem('s', 0.8)];
    const keyword = [kw('k', 0.4)];
    const withKw = fuseMatches(semantic, keyword, { limit: 5, minSimilarity: 0 });
    expect(withKw.map((m) => [m.rowId, m.kind])).toEqual([
      ['s', 'semantic'],
      ['k', 'keyword'],
    ]);
    const without = fuseMatches(semantic, keyword, {
      limit: 5,
      minSimilarity: 0,
      includeKeywordOnly: false,
    });
    expect(without.map((m) => m.rowId)).toEqual(['s']);
  });

  it('caps boosted scores below 1 and respects the limit', () => {
    const out = fuseMatches(
      [sem('a', 0.95), sem('b', 0.9), sem('c', 0.8)],
      [kw('a', 1)],
      { limit: 2, minSimilarity: 0 },
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.score).toBeLessThan(1);
  });
});
