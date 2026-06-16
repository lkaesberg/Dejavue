import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { type GuildConfig, guildConfig, type Thread, thread } from '../schema';

/** Resolve a guild by its KB subdomain slug (only if publishing is opted in). */
export async function getGuildBySlug(db: Database, slug: string): Promise<GuildConfig | undefined> {
  const [row] = await db
    .select()
    .from(guildConfig)
    .where(and(eq(guildConfig.kbSlug, slug), eq(guildConfig.kbPublishOptIn, true)))
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

export async function countPublished(db: Database, guildId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.publishedToKb, true)));
  return row?.c ?? 0;
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
 * the KB), newest first, up to the tier's page cap. Returns how many were added.
 */
export async function publishExistingSolved(
  db: Database,
  guildId: string,
  cap: number,
): Promise<number> {
  const alreadyPublished = await countPublished(db, guildId);
  if (Number.isFinite(cap) && alreadyPublished >= cap) return 0;
  const remaining = Number.isFinite(cap) ? cap - alreadyPublished : null;

  const rows = await db
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.status, 'solved'),
        eq(thread.publishedToKb, false),
        eq(thread.doNotPublish, false),
      ),
    )
    .orderBy(sql`${thread.solvedAt} desc nulls last`)
    .limit(remaining ?? 1_000_000);

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
