import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  channelMode: vi.fn(() => 'support'),
  completeReindex: vi.fn(async () => undefined),
  countIndexedMessages: vi.fn(async () => 0),
  countIndexedMessagesInChannel: vi.fn(async () => 0),
  deleteThreadsByDiscordIds: vi.fn(async () => 0),
  failReindex: vi.fn(async () => undefined),
  forgetDeletedChannel: vi.fn(),
  getDb: vi.fn(() => ({})),
  getGuildConfig: vi.fn(),
  claimReindexJob: vi.fn(),
  getReindexJob: vi.fn(),
  getThreadByDiscordId: vi.fn(async () => undefined),
  isPublishable: vi.fn(() => true),
  heartbeatReindexJob: vi.fn(async () => true),
  isOptedOut: vi.fn(async () => false),
  listThreadIdsByChannel: vi.fn(async () => []),
  semanticSearch: vi.fn(async () => []),
  setDuplicateOf: vi.fn(),
  setPublished: vi.fn(async () => undefined),
  setTranscript: vi.fn(async () => undefined),
  transitionReindexJob: vi.fn(async (..._a: unknown[]) => true),
  updateChannelName: vi.fn(async () => undefined),
  updateReindexJob: vi.fn(async () => undefined),
  upsertThread: vi.fn(),
  withoutOptedOut: vi.fn(),
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
vi.mock('@dejavue/queue', () => ({
  enqueueIngestAttachment: vi.fn(async () => undefined),
  enqueueRevalidateKb: vi.fn(async () => undefined),
}));
vi.mock('@dejavue/ai', () => ({ embeddingModelId: (m: string) => m }));
vi.mock('@dejavue/core', async (orig) => ({
  ...(await orig<typeof import('@dejavue/core')>()),
  getEnv: () => ({ EMBEDDING_MODEL: 'embeddinggemma-300m', EMBED_BATCH_SIZE: 2 }),
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../lib/quota', () => ({
  embedBudgetGate: () => async () => true,
  guildLimits: vi.fn(async () => ({ indexCap: 1_000_000 })),
}));
const embed = vi.hoisted(() => ({ syncThreadEmbeddings: vi.fn() }));
vi.mock('../lib/embedChunks', () => embed);

const rest = vi.hoisted(() => ({
  channelExists: vi.fn(async () => true),
  fetchActiveGuildThreads: vi.fn(),
  fetchArchivedPublicThreads: vi.fn(),
  fetchChannelInfo: vi.fn(async () => ({ name: 'help', available_tags: [{ id: 'solved', name: 'solved' }] })),
  fetchStarterMessage: vi.fn(async (id: string) => ({ id, content: `body ${id}`, author: { id: 'u' } })),
}));
vi.mock('../lib/discordRest', async (orig) => ({
  ...(await orig<typeof import('../lib/discordRest')>()),
  ...rest,
}));

import { handleReindexChannel } from './reindexChannel';

const job = {
  id: 'rj1',
  guildId: 'g',
  channelId: 'forum',
  kind: 'forum',
  status: 'pending',
  processed: 0,
  failed: 0,
  processedThreadIds: [] as string[],
  statusChannelId: null,
  statusMessageId: null,
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
  db.getReindexJob.mockResolvedValue({ ...job });
  db.claimReindexJob.mockResolvedValue({ ...job, status: 'running' });
  db.getGuildConfig.mockResolvedValue(monitored);
  db.upsertThread.mockImplementation(async (_db: unknown, t: { threadId: string; status: string }) => ({
    id: `row-${t.threadId}`,
    status: t.status,
    duplicateOfThreadId: null,
    publishedToKb: false,
    acceptedAnswerText: null,
    transcript: null,
  }));
  embed.syncThreadEmbeddings.mockResolvedValue({ primaryVector: [0.1, 0.2] });
  rest.fetchActiveGuildThreads.mockResolvedValue(threads);
  rest.fetchArchivedPublicThreads.mockResolvedValue({ threads: [], hasMore: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

const statusCalls = (to: string) => db.transitionReindexJob.mock.calls.filter((c: unknown[]) => c[3] === to);

describe('handleReindexChannel (forum) outcome', () => {
  it('completes and settles the channel with no failures when every thread indexes', async () => {
    await handleReindexChannel({ reindexJobId: 'rj1' } as never);
    expect(statusCalls('completed')[0]?.[4]).toMatchObject({ processed: 3, failed: 0 });
    expect(db.completeReindex).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', expect.objectContaining({ failed: 0 }));
  });

  it('fails the run and releases the claim when every thread fails (never completed + synced)', async () => {
    embed.syncThreadEmbeddings.mockRejectedValue(new Error('expected 768 dimensions, not 384'));
    await handleReindexChannel({ reindexJobId: 'rj1' } as never);
    expect(statusCalls('completed')).toHaveLength(0);
    expect(statusCalls('failed')).toHaveLength(1);
    expect(db.completeReindex).not.toHaveBeenCalled();
    expect(db.failReindex).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', 'reindex failed');
    // Never prune on a run that indexed nothing.
    expect(db.deleteThreadsByDiscordIds).not.toHaveBeenCalled();
  });

  it('completes a partial run with the failure count (stale partial) and skips failed ids', async () => {
    embed.syncThreadEmbeddings.mockImplementation(async (_db: unknown, o: { threadRowId: string }) => {
      if (o.threadRowId === 'row-102') throw new Error('boom');
      return { primaryVector: [0.1, 0.2] };
    });
    await handleReindexChannel({ reindexJobId: 'rj1' } as never);
    expect(statusCalls('completed')[0]?.[4]).toMatchObject({
      processed: 2,
      failed: 1,
      processedThreadIds: ['101', '103'],
    });
    expect(db.completeReindex).toHaveBeenCalledWith(expect.anything(), 'g', 'forum', expect.objectContaining({ failed: 1 }));
  });

  it('stops before the next thread when the channel is removed from the hub mid-run', async () => {
    let reads = 0;
    // Monitored for the start, after-listing and first-thread (check + upsert) reads; removed after that.
    db.getGuildConfig.mockImplementation(async () => (++reads <= 4 ? monitored : { ...monitored, forumChannelIds: [] }));
    await handleReindexChannel({ reindexJobId: 'rj1' } as never);
    expect(db.upsertThread).toHaveBeenCalledTimes(1);
    // The first thread's publish re-check already saw the removal.
    expect(db.setPublished).not.toHaveBeenCalled();
    expect(statusCalls('completed')).toHaveLength(0);
    expect(statusCalls('failed')).toHaveLength(1);
    expect(db.completeReindex).not.toHaveBeenCalled();
  });

  it('writes no row when the channel is removed between the per-thread check and the upsert', async () => {
    let reads = 0;
    // Start, after-listing and first per-thread check pass; the removal lands while the
    // starter is fetched, so the atomic upsert sees it.
    db.getGuildConfig.mockImplementation(async () => (++reads <= 3 ? monitored : { ...monitored, forumChannelIds: [] }));
    await handleReindexChannel({ reindexJobId: 'rj1' } as never);
    expect(db.upsertThread).not.toHaveBeenCalled();
    expect(db.setPublished).not.toHaveBeenCalled();
    expect(statusCalls('failed')).toHaveLength(1);
    expect(db.completeReindex).not.toHaveBeenCalled();
  });
});
