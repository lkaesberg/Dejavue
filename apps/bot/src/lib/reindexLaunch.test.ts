import { describe, expect, it, vi } from 'vitest';

vi.mock('@dejavue/db', () => ({}));
vi.mock('@dejavue/queue', () => ({}));

import { launchClaimedReindex, type ReindexLaunchDeps } from './reindexLaunch';

const input = {
  guildId: 'g',
  channelId: 'c',
  kind: 'tracked' as const,
  statusChannelId: null,
  statusMessageId: null,
};

function deps(patch: Partial<ReindexLaunchDeps> = {}): ReindexLaunchDeps {
  return {
    createJob: vi.fn(async () => ({ id: 'job-1' })),
    enqueue: vi.fn(async () => undefined),
    failPendingJob: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => undefined),
    ...patch,
  };
}

describe('launchClaimedReindex', () => {
  it('creates and enqueues the job, leaving the claim in place', async () => {
    const d = deps();
    await expect(launchClaimedReindex(input, d)).resolves.toBe('job-1');
    expect(d.enqueue).toHaveBeenCalledWith('job-1');
    expect(d.releaseClaim).not.toHaveBeenCalled();
    expect(d.failPendingJob).not.toHaveBeenCalled();
  });

  it('releases the claim when the job row cannot be created', async () => {
    const d = deps({ createJob: vi.fn(async () => Promise.reject(new Error('db down'))) });
    await expect(launchClaimedReindex(input, d)).rejects.toThrow('db down');
    expect(d.failPendingJob).not.toHaveBeenCalled();
    expect(d.releaseClaim).toHaveBeenCalledWith('g', 'c');
  });

  it('fails the orphan pending row and releases the claim when enqueue fails', async () => {
    const d = deps({ enqueue: vi.fn(async () => Promise.reject(new Error('queue down'))) });
    await expect(launchClaimedReindex(input, d)).rejects.toThrow('queue down');
    expect(d.failPendingJob).toHaveBeenCalledWith('job-1');
    expect(d.releaseClaim).toHaveBeenCalledWith('g', 'c');
  });

  it('still rethrows the original error when the rollback itself fails', async () => {
    const d = deps({
      enqueue: vi.fn(async () => Promise.reject(new Error('queue down'))),
      failPendingJob: vi.fn(async () => Promise.reject(new Error('also down'))),
      releaseClaim: vi.fn(async () => Promise.reject(new Error('also down'))),
    });
    await expect(launchClaimedReindex(input, d)).rejects.toThrow('queue down');
  });
});
