/**
 * Greedy single-link threshold clustering over (normalized) embedding vectors.
 *
 * Parameterized by a cosine-similarity threshold (intuitive: "how similar before
 * two questions are the same"), not a fixed `k` — right for "how many distinct
 * recurring questions are there". For very large guilds, the nearest-neighbor
 * step would move into Postgres (HNSW); this in-memory pass is fine for typical
 * archive sizes.
 */
export interface ClusterItem {
  id: string;
  vector: number[];
}

export interface ClusterResult {
  memberIds: string[];
  medoidId: string;
  size: number;
}

/** Dot product. Our embeddings are L2-normalized, so dot == cosine similarity. */
export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

function medoidOf(members: ClusterItem[]): string {
  if (members.length === 1) return members[0]!.id;
  let bestId = members[0]!.id;
  let bestScore = -Infinity;
  for (const candidate of members) {
    let score = 0;
    for (const other of members) {
      if (candidate.id === other.id) continue;
      score += dot(candidate.vector, other.vector);
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestId;
}

export function greedyCluster(
  items: readonly ClusterItem[],
  threshold: number,
  minSize = 2,
): ClusterResult[] {
  const assigned = new Set<string>();
  const clusters: ClusterResult[] = [];

  for (const seed of items) {
    if (assigned.has(seed.id)) continue;
    const members: ClusterItem[] = [seed];
    assigned.add(seed.id);
    for (const other of items) {
      if (assigned.has(other.id)) continue;
      if (dot(seed.vector, other.vector) >= threshold) {
        members.push(other);
        assigned.add(other.id);
      }
    }
    if (members.length >= minSize) {
      clusters.push({
        memberIds: members.map((m) => m.id),
        medoidId: medoidOf(members),
        size: members.length,
      });
    }
  }

  // Largest clusters first.
  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}
