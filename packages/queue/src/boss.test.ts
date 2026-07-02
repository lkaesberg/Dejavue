import { describe, expect, it } from 'vitest';
import { QUEUE_POLICIES } from './boss';
import { QUEUES } from './jobs';

describe('QUEUE_POLICIES', () => {
  it('defines a policy for every queue', () => {
    for (const name of Object.values(QUEUES)) {
      expect(QUEUE_POLICIES[name], `missing policy for ${name}`).toBeDefined();
    }
  });

  it('always retries with backoff (never pg-boss default immediate retry)', () => {
    for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
      expect(policy.retryLimit, name).toBeGreaterThan(0);
      expect(policy.retryDelay, name).toBeGreaterThan(0);
      expect(policy.retryBackoff, name).toBe(true);
    }
  });

  it('gives long-running history jobs an expiry well past 15 minutes', () => {
    expect(QUEUE_POLICIES[QUEUES.BACKFILL_FORUM].expireInSeconds).toBeGreaterThanOrEqual(3600);
    expect(QUEUE_POLICIES[QUEUES.REINDEX_CHANNEL].expireInSeconds).toBeGreaterThanOrEqual(3600);
  });
});
