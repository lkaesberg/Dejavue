import { describe, expect, it } from 'vitest';
import { dot, greedyCluster } from './cluster';

// Two tight groups around orthogonal axes.
function near(axis: 'x' | 'y', jitter: number): number[] {
  return axis === 'x' ? [1, jitter] : [jitter, 1];
}

describe('greedyCluster', () => {
  it('groups similar vectors and separates dissimilar ones', () => {
    const items = [
      { id: 'x1', vector: near('x', 0.02) },
      { id: 'x2', vector: near('x', 0.05) },
      { id: 'x3', vector: near('x', 0.01) },
      { id: 'y1', vector: near('y', 0.03) },
      { id: 'y2', vector: near('y', 0.04) },
    ];
    const clusters = greedyCluster(items, 0.9, 2);
    expect(clusters.length).toBe(2);
    expect(clusters[0]!.size).toBeGreaterThanOrEqual(2);
    // The largest cluster is the x-group (3 members).
    expect(clusters[0]!.memberIds).toEqual(expect.arrayContaining(['x1', 'x2', 'x3']));
  });

  it('drops singletons below minSize', () => {
    const items = [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0, 1] },
    ];
    expect(greedyCluster(items, 0.95, 2)).toHaveLength(0);
  });

  it('picks a medoid', () => {
    const items = [
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [1, 0] },
      { id: 'c', vector: [1, 0] },
    ];
    const [cluster] = greedyCluster(items, 0.99, 2);
    expect(cluster).toBeDefined();
    expect(['a', 'b', 'c']).toContain(cluster!.medoidId);
  });

  it('dot of identical normalized-ish vectors is high', () => {
    expect(dot([1, 0], [1, 0])).toBe(1);
    expect(dot([1, 0], [0, 1])).toBe(0);
  });
});
