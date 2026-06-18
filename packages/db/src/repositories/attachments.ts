import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { attachment, type NewAttachment } from '../schema';

/** Which of these attachment ids are already re-hosted (skip re-downloading). */
export async function existingAttachmentIds(db: Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: attachment.id })
    .from(attachment)
    .where(inArray(attachment.id, ids));
  return new Set(rows.map((r) => r.id));
}

/** Store one re-hosted attachment's bytes (idempotent — ignores a duplicate id). */
export async function insertAttachment(db: Database, values: NewAttachment): Promise<void> {
  await db.insert(attachment).values(values).onConflictDoNothing({ target: attachment.id });
}

/** Fetch a re-hosted attachment, scoped to the tenant guild (the web serve route). */
export async function getAttachment(
  db: Database,
  guildId: string,
  id: string,
): Promise<{ name: string; contentType: string | null; data: Buffer } | undefined> {
  const [row] = await db
    .select({ name: attachment.name, contentType: attachment.contentType, data: attachment.data })
    .from(attachment)
    .where(and(eq(attachment.id, id), eq(attachment.guildId, guildId)))
    .limit(1);
  return row;
}
