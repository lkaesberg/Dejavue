import { embed, embeddingModelId } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import {
  getBackfillJob,
  getDb,
  getGuildConfig,
  markEntitlementConsumed,
  updateBackfillJob,
  upsertEmbedding,
  upsertThread,
} from '@dejavue/db';
import type { BackfillForumJob } from '@dejavue/queue';
import {
  fetchActiveGuildThreads,
  fetchArchivedPublicThreads,
  fetchStarterMessage,
  type RawThread,
} from '../lib/discordRest';

const log = childLogger({ mod: 'job:backfill-forum' });
const CHECKPOINT_EVERY = 25;

/**
 * Import a forum channel's existing history into the archive. Idempotent
 * (upserts; skips already-processed threads) and resumable (checkpointed
 * processed-id set). The HNSW index already exists, so embeddings insert into it
 * incrementally.
 */
export async function handleBackfillForum(job: BackfillForumJob): Promise<void> {
  const db = getDb();
  const bf = await getBackfillJob(db, job.backfillJobId);
  if (!bf || bf.status === 'completed') return;

  await updateBackfillJob(db, bf.id, { status: 'running' });
  const cfg = await getGuildConfig(db, bf.guildId);
  const model = cfg?.embeddingModel ?? getEnv().EMBEDDING_MODEL;
  const storedModelId = embeddingModelId(model); // the actual active model id for provenance
  const solvedTagId = cfg?.solvedTagId ?? undefined;
  const processed = new Set(bf.processedThreadIds);

  // Collect active + paginated archived threads for the forum.
  const all: RawThread[] = [];
  try {
    const active = (await fetchActiveGuildThreads(bf.guildId)).filter(
      (t) => t.parent_id === bf.channelId,
    );
    all.push(...active);

    let cursor = bf.cursor ?? undefined;
    for (;;) {
      const page = await fetchArchivedPublicThreads(bf.channelId, cursor);
      all.push(...page.threads);
      const last = page.threads.at(-1);
      cursor = last?.thread_metadata?.archive_timestamp;
      if (page.threads.length === 0 || !page.hasMore || !cursor) break;
    }
  } catch (err) {
    log.error({ err, jobId: bf.id }, 'backfill: failed to list threads');
    await updateBackfillJob(db, bf.id, { status: 'failed' });
    return;
  }

  await updateBackfillJob(db, bf.id, { total: all.length });

  let processedCount = bf.processed;
  let failed = bf.failed;

  for (const t of all) {
    if (processed.has(t.id)) continue;
    try {
      const starter = await fetchStarterMessage(t.id);
      const isSolved = solvedTagId ? (t.applied_tags ?? []).includes(solvedTagId) : false;
      const row = await upsertThread(db, {
        guildId: bf.guildId,
        channelId: bf.channelId,
        threadId: t.id,
        title: t.name,
        questionBody: starter?.content ?? '',
        opUserId: starter?.author?.id ?? null,
        status: isSolved ? 'solved' : 'open',
      });
      const text = [t.name, starter?.content ?? ''].join('\n').trim();
      if (text) {
        const [vector] = await embed([text], { mode: 'passage', model });
        if (vector) {
          await upsertEmbedding(db, { threadRowId: row.id, guildId: bf.guildId, modelId: storedModelId, vector });
        }
      }
      processedCount++;
    } catch (err) {
      failed++;
      log.warn({ err, threadId: t.id }, 'backfill: failed to import thread');
    }
    processed.add(t.id);

    if (processedCount % CHECKPOINT_EVERY === 0) {
      await updateBackfillJob(db, bf.id, {
        processed: processedCount,
        failed,
        processedThreadIds: [...processed],
      });
    }
  }

  await updateBackfillJob(db, bf.id, {
    processed: processedCount,
    failed,
    processedThreadIds: [...processed],
    status: 'completed',
  });
  // Consume the durable entitlement only once the job has durably completed.
  if (bf.entitlementId) await markEntitlementConsumed(db, bf.entitlementId);
  log.info({ jobId: bf.id, processed: processedCount, failed, total: all.length }, 'backfill complete');
}
