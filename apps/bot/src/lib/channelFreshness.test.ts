import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  sync: { state: 'synced', staleReason: null as string | null },
  active: undefined as unknown,
  markChannelSynced: vi.fn(async () => undefined),
}));

vi.mock('@dejavue/db', () => ({
  getDb: () => ({}),
  ensureChannelSync: async () => db.sync,
  getActiveBackfillJob: async () => db.active,
  countIndexedMessagesInChannel: async () => 7,
  markChannelSynced: db.markChannelSynced,
}));

import { refreshForumFreshness } from './channelFreshness';

describe('refreshForumFreshness', () => {
  beforeEach(() => {
    db.markChannelSynced.mockClear();
    db.active = undefined;
  });

  it('flips a stale gap back to synced after a live capture', async () => {
    db.sync = { state: 'stale', staleReason: 'gap' };
    await refreshForumFreshness('g', 'f');
    expect(db.markChannelSynced).toHaveBeenCalledWith({}, 'g', 'f', 'forum', null, 7);
  });

  it.each(['cap', 'partial'])('keeps stale %s (a live capture does not fill it in)', async (reason) => {
    db.sync = { state: 'stale', staleReason: reason };
    await refreshForumFreshness('g', 'f');
    expect(db.markChannelSynced).not.toHaveBeenCalled();
  });

  it('leaves a reindexing claim alone', async () => {
    db.sync = { state: 'reindexing', staleReason: null };
    await refreshForumFreshness('g', 'f');
    expect(db.markChannelSynced).not.toHaveBeenCalled();
  });
});
