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
  score: number; // semantic: cosine similarity in [0,1]; keyword: ts_rank (not normalized)
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
