import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { attachment, type NewAttachment, thread, type TranscriptMessage } from '../schema';

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

/**
 * Delete the re-hosted bytes that deleted threads' transcripts showed, unless another thread of
 * the guild still shows them. `attachment` has no foreign key to `thread`, so without this an image
 * stays public at /a/<id> after its thread is deleted in Discord, its channel is untracked, or its
 * author opts out with `/dejavue privacy`. Call it after the thread rows are gone.
 */
export async function deleteTranscriptAttachments(
  db: Database,
  guildId: string,
  transcripts: (TranscriptMessage[] | null | undefined)[],
): Promise<void> {
  const ids = [
    ...new Set(transcripts.flatMap((t) => (t ?? []).flatMap((m) => (m.attachments ?? []).map((a) => a.id)))),
  ];
  for (let i = 0; i < ids.length; i += 1000) {
    await db
      .delete(attachment)
      .where(
        and(
          eq(attachment.guildId, guildId),
          inArray(attachment.id, ids.slice(i, i + 1000)),
          sql`not exists (select 1 from ${thread} where ${thread.guildId} = ${guildId} and ${thread.transcript} @> jsonb_build_array(jsonb_build_object('attachments', jsonb_build_array(jsonb_build_object('id', ${attachment.id})))))`,
        ),
      );
  }
}
