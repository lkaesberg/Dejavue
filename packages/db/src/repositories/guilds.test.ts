import { describe, expect, it } from 'vitest';
import { generationStatus } from './guilds';

const OPTS = { throttleMs: 5 * 60_000, maxRunMs: 5 * 60_000 };
const NOW = 1_000_000_000;
const cfg = (run: { started?: number; finished?: number }) => ({ genRuns: { cluster: run } });

describe('generationStatus', () => {
  it('reports neither in-flight nor fresh when never run', () => {
    expect(generationStatus(null, 'cluster', OPTS, NOW)).toEqual({
      inFlight: false,
      fresh: false,
      startedAt: undefined,
      finishedAt: undefined,
    });
  });

  it('is in-flight after a recent start with no finish', () => {
    const st = generationStatus(cfg({ started: NOW - 10_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(true);
    expect(st.fresh).toBe(false);
  });

  it('is fresh (not in-flight) after a recent finish', () => {
    const st = generationStatus(cfg({ started: NOW - 60_000, finished: NOW - 30_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(false);
    expect(st.fresh).toBe(true);
  });

  it('is in-flight again when a new run started after the last finish', () => {
    const st = generationStatus(cfg({ started: NOW - 10_000, finished: NOW - 60_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(true);
  });

  it('stops treating a stuck run as in-flight past maxRunMs', () => {
    const st = generationStatus(cfg({ started: NOW - 6 * 60_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(false);
  });

  it('is stale (not fresh) once the throttle window passes', () => {
    const st = generationStatus(cfg({ started: NOW - 7 * 60_000, finished: NOW - 6 * 60_000 }), 'cluster', OPTS, NOW);
    expect(st.fresh).toBe(false);
    expect(st.inFlight).toBe(false);
  });
});
