import { buildEmbeddingText, embed, embeddingModelId } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import {
  channelMode,
  countIndexedMessages,
  getBackfillJob,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  listEmbeddedThreadIdsInChannel,
  markEntitlementConsumed,
  semanticSearch,
  setDuplicateOf,
  setPublished,
  updateBackfillJob,
  upsertEmbedding,
  upsertThread,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import type { BackfillForumJob } from '@dejavue/queue';
import {
  fetchActiveGuildThreads,
  fetchArchivedPublicThreads,
  fetchStarterMessage,
  type RawThread,
} from '../lib/discordRest';
import { guildLimits } from '../lib/quota';

const log = childLogger({ mod: 'job:backfill-forum' });
const CHECKPOINT_EVERY = 25;
// No human confirms an imported duplicate, so only fold near-identical reposts.
const AUTO_FOLD_SIMILARITY = 0.9;

/**
 * Import a forum channel's existing history into the archive — free and bounded
 * by the guild's tier (archive cap). Idempotent (upserts; skips processed) and
 * resumable. As it imports it also: folds near-duplicate threads, and (if the KB
 * is on) publishes threads so older, inactive-but-solved threads show up online.
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
  const limits = await guildLimits(bf.guildId);
  const mode = channelMode(cfg, bf.channelId);
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

  // Oldest first (snowflake order) so a duplicate always folds under the older
  // canonical — acyclic and stable across re-imports.
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await updateBackfillJob(db, bf.id, { total: all.length });

  // Tier limit: stop importing once at the unified index cap.
  let indexedMessages = await countIndexedMessages(db, bf.guildId);
  // Threads already imported + embedded with the active model are skipped, so
  // re-running (e.g. setup again, or after a tier upgrade) is cheap and only
  // processes new history.
  const alreadyDone = new Set(
    await listEmbeddedThreadIdsInChannel(db, bf.guildId, bf.channelId, storedModelId),
  );

  let processedCount = bf.processed;
  let failed = bf.failed;
  let cappedOut = false;

  for (const t of all) {
    if (processed.has(t.id) || alreadyDone.has(t.id)) continue;
    if (indexedMessages >= limits.indexCap) {
      cappedOut = true;
      break;
    }
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
      indexedMessages++;

      let vector: number[] | undefined;
      // Backfill only has the starter message (no full transcript), so the
      // embedding text is title + question — the helper keeps it consistent with
      // the live embed job's fallback path.
      const text = buildEmbeddingText({ title: t.name, questionBody: starter?.content ?? '' });
      if (text) {
        [vector] = await embed([text], { mode: 'passage', model });
        if (vector) {
          await upsertEmbedding(db, { threadRowId: row.id, guildId: bf.guildId, modelId: storedModelId, vector });
        }
      }

      // Already a duplicate from a prior run, or fold it now under an older
      // near-identical canonical (resolve to root; only ever fold newer → older
      // so the graph stays acyclic).
      let isDup = !!row.duplicateOfThreadId;
      if (!isDup && vector) {
        const [match] = await semanticSearch(db, {
          guildId: bf.guildId,
          queryVector: vector,
          limit: 1,
          minSimilarity: AUTO_FOLD_SIMILARITY,
          excludeThreadId: t.id,
          solvedOnly: false,
          modelId: storedModelId,
        });
        if (match && match.threadId !== t.id) {
          const matchRow = await getThreadByDiscordId(db, bf.guildId, match.threadId);
          const root = matchRow?.duplicateOfThreadId ?? match.threadId;
          if (root !== t.id && BigInt(root) < BigInt(t.id)) {
            await setDuplicateOf(db, bf.guildId, t.id, root);
            isDup = true;
          }
        }
      }

      if (isDup) {
        // A folded copy never stands alone on the KB.
        await setPublished(db, bf.guildId, t.id, false);
      } else if (mode === 'knowledge' || isSolved) {
        // Auto-publish everything online. Open questions stay private until solved.
        await setPublished(db, bf.guildId, t.id, true);
        await enqueueRevalidateKb({ guildId: bf.guildId, threadId: t.id, action: 'publish' }).catch(
          () => undefined,
        );
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
  // Consume any legacy durable backfill entitlement once the job durably completes.
  if (bf.entitlementId) await markEntitlementConsumed(db, bf.entitlementId);
  log.info(
    { jobId: bf.id, processed: processedCount, failed, total: all.length, cappedOut, indexedMessages },
    'backfill complete',
  );
}
