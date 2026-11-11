import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  channelMode: vi.fn(() => 'support'),
  claimBackfillJob: vi.fn(),
  completeReindex: vi.fn(),
  countIndexedMessages: vi.fn(async () => 0),
  countIndexedMessagesInChannel: vi.fn(async () => 0),
  ensureChannelSync: vi.fn(async () => ({ state: 'stale' })),
  getActiveReindexJob: vi.fn(async () => undefined),
  getBackfillJob: vi.fn(),
  getDb: vi.fn(() => ({})),
  getGuildConfig: vi.fn(),
  getOtherActiveBackfillJob: vi.fn(async () => undefined),
  heartbeatBackfillJob: vi.fn(async () => true),
  getThreadByDiscordId: vi.fn(async () => undefined),
  isPublishable: vi.fn(() => true),
  isOptedOut: vi.fn(async () => false),
  listEmbeddedThreadIdsInChannel: vi.fn(async () => []),
  markChannelStale: vi.fn(async () => undefined),
  markEntitlementConsumed: vi.fn(async () => undefined),
  recordEmbeddingUsage: vi.fn(async () => undefined),
  semanticSearch: vi.fn(async () => []),
  setDuplicateOf: vi.fn(),
  setEmbedContentHash: vi.fn(async () => undefined),
  setPublished: vi.fn(async () => undefined),
  transitionBackfillJob: vi.fn(async (..._a: unknown[]) => true),
  updateBackfillJob: vi.fn(async () => undefined),
  updateChannelName: vi.fn(async () => undefined),
  upsertEmbedding: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  upsertThread: vi.fn(),
  // The real one locks guild_config FOR SHARE; here it reads the same (mocked) config.
  whileChannelMonitored: vi.fn(
    async (_db: unknown, guildId: string, channelId: string, kind: string, fn: (tx: unknown) => unknown) => {
      // biome-ignore lint/suspicious/noExplicitAny: test double
      const cfg: any = await (db.getGuildConfig as any)({}, guildId);
      const ids = kind === 'forum' ? cfg?.forumChannelIds : cfg?.trackedChannelIds;
      return ids?.includes(channelId) ? fn({}) : undefined;
    },
  ),
}));
vi.mock('@dejavue/db', () => db);

vi.mock('@dejavue/analytics', () => ({ capture: vi.fn() }));
vi.mock('@dejavue/queue', () => ({ enqueueRevalidateKb: vi.fn(async () => undefined) }));
vi.mock('@dejavue/ai', () => ({
  buildEmbeddingChunks: (src: { title: string }) => [{ index: 0, hash: `h-${src.title}`, text: src.title }],
  embedBatch: vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2]), tokens: texts.length })),
  embedContentHash: () => 'hash',
  embeddingModelId: (m: string) => m,
}));
vi.mock('@dejavue/core', async (orig) => ({
  ...(await orig<typeof import('@dejavue/core')>()),
  getEnv: () => ({ EMBEDDING_MODEL: 'embeddinggemma-300m', EMBED_BATCH_SIZE: 2 }),
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../lib/quota', () => ({
  embedBudgetGate: () => async () => true,
  guildLimits: vi.fn(async () => ({ indexCap: 1_000_000 })),
}));

const rest = vi.hoisted(() => ({
  fetchActiveGuildThreads: vi.fn(),
  fetchArchivedPublicThreads: vi.fn(),
  fetchChannelInfo: vi.fn(async () => ({ id: 'forum', name: 'help', available_tags: [{ id: 'solved', name: 'solved' }] })),
  fetchStarterMessage: vi.fn(async (id: string) => ({ id, content: `body ${id}`, author: { id: 'u' } })),
}));
vi.mock('../lib/discordRest', async (orig) => ({
  ...(await orig<typeof import('../lib/discordRest')>()),
  ...rest,
}));

import { handleBackfillForum } from './backfillForum';

const job = {
  id: 'bf1',
  guildId: 'g',
  channelId: 'forum',
  status: 'pending',
  processed: 0,
  failed: 0,
  processedThreadIds: [] as string[],
  statusChannelId: null,
  statusMessageId: null,
  entitlementId: null,
};
const monitored = { forumChannelIds: ['forum'], trackedChannelIds: [], solvedTagId: 'solved' };
const threads = ['101', '102', '103'].map((id) => ({
  id,
  name: `q ${id}`,
  parent_id: 'forum',
  owner_id: 'u',
  applied_tags: ['solved'],
}));

beforeEach(() => {
  db.getBackfillJob.mockResolvedValue({ ...job });
  db.claimBackfillJob.mockResolvedValue({ ...job, status: 'running' });
  db.getGuildConfig.mockResolvedValue(monitored);
  db.upsertThread.mockImplementation(async (_db: unknown, t: { threadId: string; status: string }) => ({
    id: `row-${t.threadId}`,
    status: t.status,
  }));
  rest.fetchActiveGuildThreads.mockResolvedValue(threads);
  rest.fetchArchivedPublicThreads.mockResolvedValue({ threads: [], hasMore: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

const completedCalls = () =>
  db.transitionBackfillJob.mock.calls.filter((c: unknown[]) => c[3] === 'completed');

describe('handleBackfillForum outcome', () => {
  it('completes and marks the channel synced when every thread imports', async () => {
    await handleBackfillForum({ backfillJobId: 'bf1' } as never);
    expect(completedCalls()).toHaveLength(1);
    expect(completedCalls()[0]?.[4]).toMatchObject({ processed: 3, failed: 0, processedThreadIds: ['101', '102', '103'] });
    expect(db.completeReindex).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', expect.objectContaining({ failed: 0 }));
    expect(db.setPublished).toHaveBeenCalledTimes(3);
  });

  it('fails (never completed + synced) when every thread fails, and rethrows for a retry', async () => {
    db.upsertEmbedding.mockRejectedValue(new Error('expected 768 dimensions, not 384'));
    await expect(handleBackfillForum({ backfillJobId: 'bf1' } as never)).rejects.toThrow(/all 3 attempted threads failed/);
    expect(completedCalls()).toHaveLength(0);
    expect(db.completeReindex).not.toHaveBeenCalled();
    expect(db.transitionBackfillJob).toHaveBeenCalledWith(expect.anything(), 'bf1', ['running'], 'failed');
    expect(db.markChannelStale).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', 'forum', 'gap');
    // Failed threads are not recorded as processed, so the retry re-attempts them.
    expect(db.updateBackfillJob).toHaveBeenCalledWith(expect.anything(), 'bf1', expect.objectContaining({ processedThreadIds: [] }));
    expect(db.markEntitlementConsumed).not.toHaveBeenCalled();
    db.upsertEmbedding.mockReset();
  });

  it('completes a partial import as stale partial and leaves failed threads to retry', async () => {
    db.upsertEmbedding.mockImplementation(async (_db, e) => {
      if ((e as { threadRowId: string }).threadRowId === 'row-102') throw new Error('boom');
    });
    await handleBackfillForum({ backfillJobId: 'bf1' } as never);
    expect(completedCalls()[0]?.[4]).toMatchObject({ processed: 2, failed: 1, processedThreadIds: ['101', '103'] });
    expect(db.completeReindex).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', expect.objectContaining({ failed: 1 }));
    db.upsertEmbedding.mockReset();
  });

  it('stops before the next thread when the forum is removed from the hub mid-run', async () => {
    let reads = 0;
    // Monitored for the start-of-run read and the first thread (check + upsert); removed after that.
    db.getGuildConfig.mockImplementation(async () => (++reads <= 3 ? monitored : { ...monitored, forumChannelIds: [] }));
    await handleBackfillForum({ backfillJobId: 'bf1' } as never);
    expect(db.upsertThread).toHaveBeenCalledTimes(1);
    expect(db.setPublished).not.toHaveBeenCalled();
    expect(completedCalls()).toHaveLength(0);
    expect(db.transitionBackfillJob).toHaveBeenCalledWith(expect.anything(), 'bf1', ['running'], 'failed');
    expect(db.completeReindex).not.toHaveBeenCalled();
  });

  it('writes no row when the forum is removed between the per-thread check and the upsert', async () => {
    let reads = 0;
    // Start-of-run read and the first per-thread check pass; the removal lands while
    // the starter is fetched, so the atomic upsert sees it.
    db.getGuildConfig.mockImplementation(async () => (++reads <= 2 ? monitored : { ...monitored, forumChannelIds: [] }));
    await handleBackfillForum({ backfillJobId: 'bf1' } as never);
    expect(db.upsertThread).not.toHaveBeenCalled();
    expect(db.setPublished).not.toHaveBeenCalled();
    expect(completedCalls()).toHaveLength(0);
    expect(db.transitionBackfillJob).toHaveBeenCalledWith(expect.anything(), 'bf1', ['running'], 'failed');
  });
});
