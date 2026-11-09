import { describe, expect, it } from 'vitest';
import { archivedAt, forumSolvedTagId } from './discordRest';

describe('forumSolvedTagId', () => {
  it("uses the forum's own solved tag, not the guild-wide one", () => {
    const info = { name: 'help', available_tags: [{ id: 'f2-solved', name: 'Solved' }, { id: 'x', name: 'bug' }] };
    expect(forumSolvedTagId(info, 'f1-solved')).toBe('f2-solved');
  });

  it('has no solved tag when the forum has none', () => {
    expect(forumSolvedTagId({ available_tags: [] }, 'f1-solved')).toBeUndefined();
  });

  it('falls back to the guild value only when the forum could not be read', () => {
    expect(forumSolvedTagId(null, 'f1-solved')).toBe('f1-solved');
    expect(forumSolvedTagId({ name: 'x' }, null)).toBeUndefined();
  });
});

describe('archivedAt', () => {
  it('reads the archive timestamp', () => {
    expect(archivedAt({ id: '1', name: 'n', thread_metadata: { archive_timestamp: '2025-01-01T00:00:00.000Z' } })?.toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    );
    expect(archivedAt({ id: '1', name: 'n' })).toBeUndefined();
    expect(archivedAt({ id: '1', name: 'n', thread_metadata: { archive_timestamp: 'garbage' } })).toBeUndefined();
  });
});
