import { and, cosineDistance, desc, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, thread } from '../schema';

/**
 * The ONLY place vector / full-text SQL lives. The bot and worker call these
 * typed repository functions; they never hand-write search SQL.
 */

export interface SearchMatch {
  rowId: string; // thread.id (uuid)
  threadId: string; // discord thread id
  title: string;
  channelName: string | null; // denormalized parent channel name (for "in #channel")
  status: 'open' | 'solved' | 'unsolved';
  score: number; // semantic/hybrid: similarity-like in [0,1]; keyword: ts_rank (not normalized)
  /** How `score` should be read by callers: a 0–1 similarity, or an opaque keyword rank. */
  kind: 'semantic' | 'keyword';
}

export interface SemanticSearchOptions {
  guildId: string;
  queryVector: number[];
  limit?: number;
  /** Cosine-similarity floor in [0,1]; matches below this are dropped. */
  minSimilarity?: number;
  /** Discord thread id to exclude (e.g. the asking thread itself). */
  excludeThreadId?: string;
  solvedOnly?: boolean;
  /**
   * Only compare against embeddings produced by this model id. Set to the active
   * model so a provider/model switch never compares the query vector against
   * stale vectors from a different model (different geometry → garbage scores).
   */
  modelId?: string;
  /** HNSW recall knob; higher = better recall, slower. */
  efSearch?: number;
}

const DEFAULT_EF_SEARCH = 100;

export async function semanticSearch(
  db: Database,
  opts: SemanticSearchOptions,
): Promise<SearchMatch[]> {
  const {
    guildId,
    queryVector,
    limit = 5,
    minSimilarity = 0,
    excludeThreadId,
    solvedOnly = true,
    modelId,
    efSearch = DEFAULT_EF_SEARCH,
  } = opts;

  // Order by the raw distance operator ascending so the HNSW index is usable;
  // expose similarity (1 - distance) as the score.
  const distance = cosineDistance(embedding.vec, queryVector);
  const similarity = sql<number>`1 - (${distance})`;

  return db.transaction(async (tx) => {
    // SET LOCAL doesn't take bind params — inline a sanitized integer.
    await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.trunc(efSearch)))}`);

    const conditions = [eq(embedding.guildId, guildId)];
    if (modelId) conditions.push(eq(embedding.modelId, modelId));
    if (solvedOnly) conditions.push(eq(thread.status, 'solved'));
    if (excludeThreadId) conditions.push(ne(thread.threadId, excludeThreadId));

    const rows = await tx
      .select({
        rowId: thread.id,
        threadId: thread.threadId,
        title: thread.title,
        channelName: thread.channelName,
        status: thread.status,
        score: similarity,
      })
      .from(embedding)
      .innerJoin(thread, eq(embedding.threadId, thread.id))
      .where(and(...conditions))
      .orderBy(distance)
      .limit(limit);

    return rows
      .filter((r) => r.score >= minSimilarity)
      .map((r) => ({ ...r, kind: 'semantic' as const }));
  });
}

export interface KeywordSearchOptions {
  guildId: string;
  query: string;
  limit?: number;
  excludeThreadId?: string;
  solvedOnly?: boolean;
}

/**
 * Postgres full-text search over title + question + accepted answer. Uses
 * `websearch_to_tsquery` so the /search command accepts natural queries.
 */
export async function keywordSearch(
  db: Database,
  opts: KeywordSearchOptions,
): Promise<SearchMatch[]> {
  const { guildId, query, limit = 5, excludeThreadId, solvedOnly = true } = opts;

  const document = sql`to_tsvector('english', ${thread.title} || ' ' || ${thread.questionBody} || ' ' || coalesce(${thread.acceptedAnswerText}, ''))`;
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank(${document}, ${tsquery})`;

  const conditions = [eq(thread.guildId, guildId), sql`${document} @@ ${tsquery}`];
  if (solvedOnly) conditions.push(eq(thread.status, 'solved'));
  if (excludeThreadId) conditions.push(ne(thread.threadId, excludeThreadId));

  const rows = await db
    .select({
      rowId: thread.id,
      threadId: thread.threadId,
      title: thread.title,
      channelName: thread.channelName,
      status: thread.status,
      score: rank,
    })
    .from(thread)
    .where(and(...conditions))
    .orderBy(desc(rank))
    .limit(limit);

  return rows.map((r) => ({ ...r, kind: 'keyword' as const }));
}

// ---------------------------------------------------------------------------
// Hybrid search — semantic recall with a keyword-overlap boost
// ---------------------------------------------------------------------------

/** How much a perfect keyword match adds to a result's similarity score. */
export const DEFAULT_KEYWORD_BOOST = 0.15;

export interface HybridFuseOptions {
  limit: number;
  /** The caller's similarity floor — applied to the BOOSTED score (see below). */
  minSimilarity: number;
  keywordBoost?: number;
  /** Append keyword-only hits (no semantic candidate) after the fused results. */
  includeKeywordOnly?: boolean;
}

/**
 * Fuse semantic candidates with keyword matches: a result that also matches the
 * query terms directly gets its similarity boosted by up to `keywordBoost`
 * (scaled by its ts_rank relative to the best keyword hit). The similarity
 * floor is applied to the boosted score, so a borderline semantic candidate
 * with a strong direct keyword match can clear the bar — callers should fetch
 * semantic candidates with a floor relaxed by `keywordBoost`.
 *
 * Pure function so the fusion math is unit-testable without a database.
 */
export function fuseMatches(
  semantic: SearchMatch[],
  keyword: SearchMatch[],
  opts: HybridFuseOptions,
): SearchMatch[] {
  const { limit, minSimilarity, keywordBoost = DEFAULT_KEYWORD_BOOST, includeKeywordOnly = true } = opts;
  const maxRank = keyword.reduce((m, r) => Math.max(m, r.score), 0);
  const kwNorm = new Map(
    keyword.map((r) => [r.rowId, maxRank > 0 ? r.score / maxRank : 0] as const),
  );

  const fused = new Map<string, SearchMatch>();
  for (const m of semantic) {
    const boosted = Math.min(0.99, m.score + keywordBoost * (kwNorm.get(m.rowId) ?? 0));
    if (boosted < minSimilarity) continue;
    fused.set(m.rowId, { ...m, score: boosted, kind: 'semantic' });
  }
  const out = [...fused.values()].sort((a, b) => b.score - a.score);

  if (includeKeywordOnly) {
    // Extra recall: direct keyword hits the embeddings missed, ranked below the
    // semantic results (score is just the scaled boost, well under any match).
    for (const m of keyword) {
      if (fused.has(m.rowId)) continue;
      out.push({ ...m, score: keywordBoost * (kwNorm.get(m.rowId) ?? 0), kind: 'keyword' });
    }
  }
  return out.slice(0, limit);
}

export interface HybridSearchOptions extends SemanticSearchOptions {
  /** The raw query text, for the keyword leg. */
  query: string;
  keywordBoost?: number;
  includeKeywordOnly?: boolean;
}

/**
 * Semantic search with a keyword-overlap boost (see fuseMatches). Use this for
 * user-facing search + duplicate suggestions; keep pure semanticSearch for
 * conservative machine decisions like backfill auto-folding.
 */
export async function hybridSearch(
  db: Database,
  opts: HybridSearchOptions,
): Promise<SearchMatch[]> {
  const {
    query,
    keywordBoost = DEFAULT_KEYWORD_BOOST,
    includeKeywordOnly = true,
    limit = 5,
    minSimilarity = 0,
    ...semanticOpts
  } = opts;
  const candidates = Math.max(limit * 3, 15);
  const [semantic, keyword] = await Promise.all([
    semanticSearch(db, {
      ...semanticOpts,
      limit: candidates,
      // Relaxed floor: fuseMatches re-applies the real floor to boosted scores.
      minSimilarity: Math.max(0, minSimilarity - keywordBoost),
    }),
    keywordSearch(db, {
      guildId: semanticOpts.guildId,
      query,
      limit: candidates,
      excludeThreadId: semanticOpts.excludeThreadId,
      solvedOnly: semanticOpts.solvedOnly ?? true,
    }),
  ]);
  return fuseMatches(semantic, keyword, { limit, minSimilarity, keywordBoost, includeKeywordOnly });
}
