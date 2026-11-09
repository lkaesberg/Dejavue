import { describe, expect, it, vi } from 'vitest';
import type { Tier } from '@dejavue/core';
import { checkTierUpgrade, type TierUpgradeDeps } from './upgrade';

/** In-memory deps with a real compare-and-set on lastTier. */
function fakeDeps(init: { lastTier: Tier | null; tier: Tier; forums: string[] }) {
  const state = { lastTier: init.lastTier as string | null, jobs: [] as { id: string; channelId: string; status: string }[] };
  const deps: TierUpgradeDeps = {
    getConfig: async () => ({ lastTier: state.lastTier, forumChannelIds: init.forums }),
    getTier: async () => init.tier,
    swapLastTier: async (_g, from, to) => {
      if (state.lastTier !== from) return false;
      state.lastTier = to;
      return true;
    },
    hasActiveImport: async (_g, channelId) =>
      state.jobs.some((j) => j.channelId === channelId && (j.status === 'pending' || j.status === 'running')),
    createJob: async (_g, channelId) => {
      const job = { id: `job-${state.jobs.length + 1}`, channelId, status: 'pending' };
      state.jobs.push(job);
      return job;
    },
    enqueue: vi.fn(async () => undefined),
    failPendingJob: async (id) => {
      const job = state.jobs.find((j) => j.id === id);
      if (job?.status === 'pending') job.status = 'failed';
    },
  };
  return { state, deps };
}

describe('checkTierUpgrade', () => {
  it('records a baseline on first sighting without importing', async () => {
    const { state, deps } = fakeDeps({ lastTier: null, tier: 'pro', forums: ['f1'] });
    await checkTierUpgrade('g', deps);
    expect(state.lastTier).toBe('pro');
    expect(state.jobs).toHaveLength(0);
  });

  it('records a downgrade without importing', async () => {
    const { state, deps } = fakeDeps({ lastTier: 'max', tier: 'plus', forums: ['f1'] });
    await checkTierUpgrade('g', deps);
    expect(state.lastTier).toBe('plus');
    expect(state.jobs).toHaveLength(0);
  });

  it('queues one import per forum when concurrent events race on the same upgrade', async () => {
    const { state, deps } = fakeDeps({ lastTier: 'free', tier: 'pro', forums: ['f1', 'f2'] });
    // CREATE, UPDATE and reconcile all read lastTier='free' before anyone writes.
    await Promise.all([checkTierUpgrade('g', deps), checkTierUpgrade('g', deps), checkTierUpgrade('g', deps)]);
    expect(state.lastTier).toBe('pro');
    expect(state.jobs.map((j) => j.channelId)).toEqual(['f1', 'f2']);
  });

  it('on an enqueue failure fails the orphan row and releases the claim so a retry finishes', async () => {
    const { state, deps } = fakeDeps({ lastTier: 'free', tier: 'pro', forums: ['f1', 'f2'] });
    const enqueue = vi.fn(async (id: string) => {
      if (id === 'job-2') throw new Error('queue down');
    });
    await checkTierUpgrade('g', { ...deps, enqueue });
    expect(state.lastTier).toBe('free');
    expect(state.jobs.find((j) => j.id === 'job-2')?.status).toBe('failed');

    await checkTierUpgrade('g', deps);
    expect(state.lastTier).toBe('pro');
    // f1 was already queued and is skipped; f2 gets a fresh job.
    expect(state.jobs.filter((j) => j.status === 'pending').map((j) => j.channelId)).toEqual(['f1', 'f2']);
  });
});
