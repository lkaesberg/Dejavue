import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyedTrailingDebounce } from './debounce';

describe('keyedTrailingDebounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses a burst within the window to one run', async () => {
    const runs: string[] = [];
    const schedule = keyedTrailingDebounce<string>(
      1000,
      async (p) => void runs.push(p),
      () => undefined,
    );
    schedule('t1', 'a');
    schedule('t1', 'b');
    schedule('t1', 'c');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual(['c']); // one run, freshest payload
  });

  it('re-runs once for calls that arrive while a run is in flight', async () => {
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const schedule = keyedTrailingDebounce<string>(
      1000,
      async (p) => {
        runs.push(p);
        if (runs.length === 1) await gate; // first run hangs mid-flight
      },
      () => undefined,
    );
    schedule('t1', 'a');
    await vi.advanceTimersByTimeAsync(1000); // first run starts, blocked on gate
    expect(runs).toEqual(['a']);

    schedule('t1', 'late'); // the previously-lost case: arrives mid-run
    release();
    await vi.advanceTimersByTimeAsync(1000); // follow-up run fires
    expect(runs).toEqual(['a', 'late']);
  });

  it('runs again on a call after everything settled', async () => {
    const runs: string[] = [];
    const schedule = keyedTrailingDebounce<string>(
      1000,
      async (p) => void runs.push(p),
      () => undefined,
    );
    schedule('t1', 'a');
    await vi.advanceTimersByTimeAsync(1000);
    schedule('t1', 'b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual(['a', 'b']);
  });

  it('keys are independent and errors are routed without breaking the loop', async () => {
    const runs: string[] = [];
    const errors: string[] = [];
    const schedule = keyedTrailingDebounce<string>(
      1000,
      async (p) => {
        if (p === 'boom') throw new Error('boom');
        runs.push(p);
      },
      (_err, p) => void errors.push(p),
    );
    schedule('a', 'boom');
    schedule('b', 'fine');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual(['fine']);
    expect(errors).toEqual(['boom']);
    // The errored key accepts new work.
    schedule('a', 'recovered');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual(['fine', 'recovered']);
  });
});
