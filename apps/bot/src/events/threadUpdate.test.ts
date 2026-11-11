import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  getGuildConfig: vi.fn(async () => ({ forumChannelIds: ['f1'] })),
  getThreadByDiscordId: vi.fn(),
  setMarkedDuplicate: vi.fn(),
  setPublished: vi.fn(),
  setThreadLabels: vi.fn(),
};
const unsolveThread = vi.fn(async () => undefined);
const enqueueRevalidateKb = vi.fn(async () => undefined);

vi.mock('@dejavue/core', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@dejavue/db', () => ({
  getDb: () => ({}),
  getGuildConfig: (...a: unknown[]) => db.getGuildConfig(...(a as [])),
  getThreadByDiscordId: (...a: unknown[]) => db.getThreadByDiscordId(...a),
  setMarkedDuplicate: (...a: unknown[]) => db.setMarkedDuplicate(...a),
  setPublished: (...a: unknown[]) => db.setPublished(...a),
  setThreadLabels: (...a: unknown[]) => db.setThreadLabels(...a),
}));
vi.mock('@dejavue/queue', () => ({ enqueueRevalidateKb: (...a: unknown[]) => enqueueRevalidateKb(...(a as [])) }));
vi.mock('../lib/solve', () => ({
  closeThread: vi.fn(),
  unsolveThread: (...a: unknown[]) => unsolveThread(...(a as [])),
}));
vi.mock('../lib/tier', () => ({ monitoredForum: async () => true }));
vi.mock('../lib/attachments', () => ({ mapAttachments: vi.fn(), queueImageRehost: vi.fn() }));

import { ChannelType, type ThreadChannel } from 'discord.js';
import { onThreadUpdate, reopenedByTags } from './threadUpdate';

const forum = {
  id: 'f1',
  type: ChannelType.GuildForum,
  availableTags: [
    { id: 'tSolved', name: 'solved' },
    { id: 'tUnsolved', name: 'unsolved' },
    { id: 'tDup', name: 'duplicate' },
    { id: 'tBilling', name: 'billing' },
  ],
};
const thread = (tags: string[]): ThreadChannel =>
  ({ id: 't1', guildId: 'g1', parent: forum, appliedTags: tags }) as unknown as ThreadChannel;

const solvedRow = {
  status: 'solved',
  markedDuplicate: false,
  publishedToKb: true,
  labels: ['billing'],
};

describe('reopenedByTags', () => {
  it('solved tag removed → reopened', () => {
    expect(reopenedByTags(thread(['tSolved', 'tBilling']), thread(['tBilling']))).toBe(true);
  });
  it('unsolved added in place of solved → reopened', () => {
    expect(reopenedByTags(thread(['tSolved']), thread(['tUnsolved']))).toBe(true);
  });
  it('solved still applied → not reopened', () => {
    expect(reopenedByTags(thread(['tSolved']), thread(['tSolved', 'tBilling']))).toBe(false);
  });
  it('an unrelated tag edit on a post solved without its tag → not reopened', () => {
    expect(reopenedByTags(thread(['tBilling']), thread([]))).toBe(false);
  });
});

describe('onThreadUpdate reopen', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reopens a solved post when a moderator removes the solved tag', async () => {
    db.getThreadByDiscordId.mockResolvedValue(solvedRow);
    const next = thread(['tUnsolved', 'tBilling']);
    await onThreadUpdate(thread(['tSolved', 'tBilling']), next);
    expect(unsolveThread).toHaveBeenCalledWith(next, 'open');
    // labels unchanged → no extra publish revalidate for the now-unpublished page
    expect(enqueueRevalidateKb).not.toHaveBeenCalled();
  });

  it('does not reopen an already-open post (our own tag swap after the reopen)', async () => {
    db.getThreadByDiscordId.mockResolvedValue({ ...solvedRow, status: 'open', publishedToKb: false });
    await onThreadUpdate(thread(['tBilling']), thread(['tUnsolved', 'tBilling']));
    expect(unsolveThread).not.toHaveBeenCalled();
  });

  it('a label change on a solved post leaves it solved', async () => {
    db.getThreadByDiscordId.mockResolvedValue({ ...solvedRow, labels: [] });
    await onThreadUpdate(thread(['tSolved']), thread(['tSolved', 'tBilling']));
    expect(unsolveThread).not.toHaveBeenCalled();
    expect(db.setThreadLabels).toHaveBeenCalledWith({}, 'g1', 't1', ['billing']);
  });
});
