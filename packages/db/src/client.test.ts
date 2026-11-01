import { describe, expect, it } from 'vitest';
import { waitForDatabase } from './client';

describe('waitForDatabase', () => {
  it('returns at once when the database answers', async () => {
    const delays: number[] = [];
    await waitForDatabase({ ping: async () => 1, sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([]);
  });

  it('retries with doubling, capped backoff until the database answers', async () => {
    let calls = 0;
    const delays: number[] = [];
    const retries: number[] = [];
    await waitForDatabase({
      ping: async () => {
        calls++;
        if (calls <= 7) throw new Error('ECONNREFUSED');
      },
      sleep: async (ms) => void delays.push(ms),
      onRetry: (attempt) => retries.push(attempt),
    });
    expect(calls).toBe(8);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(retries).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
