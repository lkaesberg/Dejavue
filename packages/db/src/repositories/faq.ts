import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { faqEntry, type FaqEntry } from '../schema';

export async function getFaqEntries(db: Database, guildId: string): Promise<FaqEntry[]> {
  return db
    .select()
    .from(faqEntry)
    .where(and(eq(faqEntry.guildId, guildId), eq(faqEntry.published, true)));
}

export interface UpsertFaqInput {
  guildId: string;
  clusterId?: string | null;
  question: string;
  answer: string;
  sourceThreadIds?: string[];
}

/**
 * Upsert a generated FAQ entry keyed by its source cluster. A human edit
 * (manual_override) is never clobbered by regeneration.
 */
export async function upsertGeneratedFaq(db: Database, input: UpsertFaqInput): Promise<void> {
  const existing = input.clusterId
    ? (
        await db
          .select()
          .from(faqEntry)
          .where(and(eq(faqEntry.guildId, input.guildId), eq(faqEntry.clusterId, input.clusterId)))
          .limit(1)
      )[0]
    : undefined;

  if (existing) {
    if (existing.manualOverride) return;
    await db
      .update(faqEntry)
      .set({
        question: input.question,
        answer: input.answer,
        sourceThreadIds: input.sourceThreadIds ?? [],
        lastRegeneratedAt: new Date(),
      })
      .where(eq(faqEntry.id, existing.id));
    return;
  }

  await db.insert(faqEntry).values({
    guildId: input.guildId,
    clusterId: input.clusterId ?? null,
    question: input.question,
    answer: input.answer,
    sourceThreadIds: input.sourceThreadIds ?? [],
    lastRegeneratedAt: new Date(),
  });
}
