import { afterEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  sweepStaleReindexJobs: vi.fn(),
  sweepStaleBackfillJobs: vi.fn(),
  getActiveReindexJob: vi.fn(),
  failReindex: vi.fn(),
}));
vi.mock('@dejavue/db', () => db);

import {
  isChannelMonitored,
  JOB_LEASE_MS,
  JOB_HEARTBEAT_MS,
  RUNNING_STALE_MS,
  startHeartbeat,
  sweepStaleChannelJobs,
} from './jobLease';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('isChannelMonitored', () => {
  const cfg = { forumChannelIds: ['f1'], trackedChannelIds: ['t1'] };
  it('checks the list that matches the job kind', () => {
    expect(isChannelMonitored(cfg, 'f1', 'forum')).toBe(true);
    expect(isChannelMonitored(cfg, 't1', 'tracked')).toBe(true);
    expect(isChannelMonitored(cfg, 't1', 'forum')).toBe(false);
    expect(isChannelMonitored(cfg, 'gone', 'tracked')).toBe(false);
  });
  it('treats a missing guild config as unmonitored', () => {
    expect(isChannelMonitored(undefined, 'f1', 'forum')).toBe(false);
  });
});

describe('lease timing', () => {
  it('beats several times per lease and sweeps only well past it', () => {
    expect(JOB_LEASE_MS / JOB_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
    expect(RUNNING_STALE_MS).toBeGreaterThan(JOB_LEASE_MS);
  });
});

describe('startHeartbeat', () => {
  it('beats on the interval until stopped, surviving a failed beat', async () => {
    vi.useFakeTimers();
    const beat = vi.fn().mockRejectedValueOnce(new Error('db blip')).mockResolvedValue(true);
    const stop = startHeartbeat(beat, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(beat).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(beat).toHaveBeenCalledTimes(3);
  });
});

describe('sweepStaleChannelJobs', () => {
  it('releases the channel claim of each swept reindex unless a newer job owns it', async () => {
    db.sweepStaleReindexJobs.mockResolvedValue([
      { id: 'r1', guildId: 'g', channelId: 'c1' },
      { id: 'r2', guildId: 'g', channelId: 'c2' },
    ]);
    db.sweepStaleBackfillJobs.mockResolvedValue([{ id: 'b1', guildId: 'g', channelId: 'f1' }]);
    db.getActiveReindexJob.mockImplementation(async (_db: unknown, _g: string, ch: string) =>
      ch === 'c2' ? { id: 'r3' } : undefined,
    );
    const out = await sweepStaleChannelJobs({} as never);
    expect(out).toEqual({ reindex: 2, backfill: 1 });
    expect(db.failReindex).toHaveBeenCalledTimes(1);
    expect(db.failReindex).toHaveBeenCalledWith({}, 'g', 'c1', 'reindex failed');
  });
});
