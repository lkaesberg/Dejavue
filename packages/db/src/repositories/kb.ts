import { and, cosineDistance, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, type GuildConfig, guildConfig, type Thread, thread } from '../schema';

/** A public-KB search hit: the same shape for keyword and semantic, plus an optional match %. */
export interface KbSearchResult {
  threadId: string;
  title: string;
  channel: string | null;
  snippet: string;
  /** Custom forum labels on the thread. */
  labels: string[];
  /** Cosine similarity in [0,1] for semantic results; undefined for keyword. */
  relevance?: number;
}

function snippetFrom(parts: { summary?: string | null; answer?: string | null; question?: string | null }): string {
  const body = (parts.summary || parts.answer || parts.question || '').replace(/\s+/g, ' ').trim();
  return body.length > 180 ? `${body.slice(0, 180)}…` : body;
}

export async function listGuildsWithKb(db: Database): Promise<GuildConfig[]> {
  return db.select().from(guildConfig).where(eq(guildConfig.kbPublishOptIn, true));
}

/** Resolve a guild by its KB subdomain slug (only if publishing is opted in). */
export async function getGuildBySlug(db: Database, slug: string): Promise<GuildConfig | undefined> {
  const [row] = await db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.kbSlug, slug), eq(guildConfig.kbPublishOptIn, true)))
    .limit(1);
  return row;
}

/** Resolve a guild by its custom domain (one-time purchase), if publishing is opted in. */
export async function getGuildByCustomDomain(
  db: Database,
  host: string,
): Promise<GuildConfig | undefined> {
  const [row] = await db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.customDomain, host), eq(guildConfig.kbPublishOptIn, true)))
    .limit(1);
  return row;
}

export async function getPublishedThreads(
  db: Database,
  guildId: string,
  limit = 500,
): Promise<Thread[]> {
  return db
    .select()
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.publishedToKb, true),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId), // duplicates are folded under their canonical thread
      ),
    )
    .orderBy(sql`${thread.solvedAt} desc nulls last`)
    .limit(limit);
}

export async function getPublishedThread(
  db: Database,
  guildId: string,
  discordThreadId: string,
): Promise<Thread | undefined> {
  const [row] = await db
    .select()
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.threadId, discordThreadId),
        eq(thread.publishedToKb, true),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId), // a folded duplicate is not its own page
      ),
    )
    .limit(1);
  return row;
}

/** Fetch title + best answer (canonical summary or accepted) for row ids — for MCP results. */
export async function getKbAnswersByRowIds(
  db: Database,
  ids: string[],
): Promise<{ rowId: string; threadId: string; title: string; answer: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      rowId: thread.id,
      threadId: thread.threadId,
      title: thread.title,
      canonical: thread.canonicalSummary,
      accepted: thread.acceptedAnswerText,
    })
    .from(thread)
    .where(inArray(thread.id, ids));
  return rows.map((r) => ({
    rowId: r.rowId,
    threadId: r.threadId,
    title: r.title,
    answer: r.canonical || r.accepted || '',
  }));
}

/** Duplicate threads folded under a canonical thread (shown as "also asked as"). */
export async function getDuplicatesOf(
  db: Database,
  guildId: string,
  originalThreadId: string,
): Promise<{ threadId: string; title: string }[]> {
  return db
    .select({ threadId: thread.threadId, title: thread.title })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.duplicateOfThreadId, originalThreadId)))
    .limit(50);
}

/** Keyword (full-text) search over a tenant's published, non-duplicate KB threads. */
export async function searchPublished(
  db: Database,
  guildId: string,
  query: string,
  limit = 20,
  channelId?: string,
): Promise<KbSearchResult[]> {
  // Full text over EVERY text field on the thread — including each reply in the
  // discussion transcript — so an answer is findable by anything said in it.
  // (jsonb_typeof guards against null / non-array transcripts.)
  const transcriptText = sql`coalesce(case when jsonb_typeof(${thread.transcript}) = 'array'
    then (select string_agg(msg->>'content', ' ') from jsonb_array_elements(${thread.transcript}) as msg)
    else '' end, '')`;
  const document = sql`to_tsvector('english',
    ${thread.title} || ' ' ||
    ${thread.questionBody} || ' ' ||
    coalesce(${thread.acceptedAnswerText}, '') || ' ' ||
    coalesce(${thread.canonicalSummary}, '') || ' ' ||
    coalesce(${thread.channelName}, '') || ' ' ||
    ${transcriptText})`;
  const tsquery = sql`websearch_to_tsquery('english', ${query})`;
  const rank = sql<number>`ts_rank(${document}, ${tsquery})`;
  const rows = await db
    .select({
      threadId: thread.threadId,
      title: thread.title,
      channel: thread.channelName,
      labels: thread.labels,
      summary: thread.canonicalSummary,
      answer: thread.acceptedAnswerText,
      question: thread.questionBody,
    })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.publishedToKb, true),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId),
        ...(channelId ? [eq(thread.channelId, channelId)] : []),
        sql`${document} @@ ${tsquery}`,
      ),
    )
    .orderBy(sql`${rank} desc`)
    .limit(limit);

  return rows.map((r) => ({
    threadId: r.threadId,
    title: r.title,
    channel: r.channel,
    labels: r.labels,
    snippet: snippetFrom(r),
  }));
}

/**
 * Semantic (embedding) search over a tenant's published, non-duplicate KB threads
 * (forum + tracked-channel). Mirrors `searchPublished` output plus a `relevance`
 * (cosine similarity in [0,1]). Caller supplies the query vector + active model id.
 */
export async function searchPublishedSemantic(
  db: Database,
  guildId: string,
  queryVector: number[],
  modelId: string,
  limit = 20,
  channelId?: string,
): Promise<KbSearchResult[]> {
  const distance = cosineDistance(embedding.vec, queryVector);
  const similarity = sql<number>`1 - (${distance})`;
  const rows = await db
    .select({
      threadId: thread.threadId,
      title: thread.title,
      channel: thread.channelName,
      labels: thread.labels,
      summary: thread.canonicalSummary,
      answer: thread.acceptedAnswerText,
      question: thread.questionBody,
      relevance: similarity,
    })
    .from(embedding)
    .innerJoin(thread, eq(embedding.threadId, thread.id))
    .where(
      and(
        eq(embedding.guildId, guildId),
        eq(embedding.modelId, modelId),
        eq(thread.publishedToKb, true),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId),
        ...(channelId ? [eq(thread.channelId, channelId)] : []),
      ),
    )
    .orderBy(distance)
    .limit(limit);

  // One row per thread (a thread may have several passage embeddings); keep the best.
  const best = new Map<string, KbSearchResult>();
  for (const r of rows) {
    const existing = best.get(r.threadId);
    if (existing && (existing.relevance ?? 0) >= r.relevance) continue;
    best.set(r.threadId, {
      threadId: r.threadId,
      title: r.title,
      channel: r.channel,
      labels: r.labels,
      snippet: snippetFrom(r),
      relevance: r.relevance,
    });
  }
  return [...best.values()].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
}

/**
 * Hybrid KB search: semantic results with a keyword-overlap boost, plus direct
 * keyword hits the embeddings missed appended below (their `relevance` is left
 * unset, so the UI badges them "keyword"). A result matching both by meaning
 * AND by exact terms outranks a meaning-only match. The keyword leg's ts_rank
 * isn't returned by searchPublished, so the boost is scaled by rank position.
 */
export async function searchPublishedHybrid(
  db: Database,
  guildId: string,
  query: string,
  queryVector: number[],
  modelId: string,
  limit = 20,
  channelId?: string,
  keywordBoost = 0.15,
): Promise<KbSearchResult[]> {
  const candidates = Math.max(limit * 2, 30);
  const [semantic, keyword] = await Promise.all([
    searchPublishedSemantic(db, guildId, queryVector, modelId, candidates, channelId),
    searchPublished(db, guildId, query, candidates, channelId),
  ]);
  // Position-based keyword weight: best keyword hit = 1, decaying linearly.
  const kwWeight = new Map(
    keyword.map((r, i) => [r.threadId, (keyword.length - i) / keyword.length] as const),
  );

  const fused: KbSearchResult[] = semantic
    .map((r) => ({
      ...r,
      relevance: Math.min(0.99, (r.relevance ?? 0) + keywordBoost * (kwWeight.get(r.threadId) ?? 0)),
    }))
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const seen = new Set(fused.map((r) => r.threadId));
  for (const r of keyword) {
    if (!seen.has(r.threadId)) fused.push(r); // keyword-only recall, ranked last
  }
  return fused.slice(0, limit);
}

/**
 * Publish all not-yet-published threads in a (knowledge) channel regardless of
 * solved status. Everything indexed is auto-published (the only ceiling is the
 * unified index cap, enforced at capture time), so this flips every eligible row.
 * Returns count added.
 */
export async function publishExistingInChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<number> {
  const rows = await db
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.channelId, channelId),
        eq(thread.publishedToKb, false),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId),
      ),
    );

  if (rows.length === 0) return 0;
  await db
    .update(thread)
    .set({ publishedToKb: true, updatedAt: new Date() })
    .where(
      inArray(
        thread.id,
        rows.map((r) => r.id),
      ),
    );
  return rows.length;
}

/**
 * Publish all not-yet-published *tracked-channel* segments in a channel (kind =
 * 'channel'). Their count is already bounded at capture by `trackedDocCap`, so this
 * just flips the publish flag — used to retroactively publish segments captured
 * while the KB was off, then turned on (live capture + startup reconcile).
 */
export async function publishExistingTracked(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<number> {
  const rows = await db
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.channelId, channelId),
        eq(thread.kind, 'channel'),
        eq(thread.publishedToKb, false),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId),
      ),
    );
  if (rows.length === 0) return 0;
  await db
    .update(thread)
    .set({ publishedToKb: true, updatedAt: new Date() })
    .where(
      inArray(
        thread.id,
        rows.map((r) => r.id),
      ),
    );
  return rows.length;
}

export async function setPublished(
  db: Database,
  guildId: string,
  discordThreadId: string,
  published: boolean,
): Promise<void> {
  await db
    .update(thread)
    .set({ publishedToKb: published, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)));
}

/**
 * Retroactively publish already-solved threads (e.g. when a guild first enables
 * the KB). Everything indexed is auto-published, so this flips every eligible
 * solved row. Returns how many were added.
 */
export async function publishExistingSolved(db: Database, guildId: string): Promise<number> {
  const rows = await db
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.status, 'solved'),
        eq(thread.publishedToKb, false),
        eq(thread.doNotPublish, false),
        isNull(thread.duplicateOfThreadId), // never retroactively publish a folded duplicate
      ),
    );

  if (rows.length === 0) return 0;
  await db
    .update(thread)
    .set({ publishedToKb: true, updatedAt: new Date() })
    .where(
      inArray(
        thread.id,
        rows.map((r) => r.id),
      ),
    );
  return rows.length;
}
