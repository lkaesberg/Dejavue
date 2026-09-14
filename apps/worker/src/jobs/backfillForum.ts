import { capture } from '@dejavue/analytics';
import { buildEmbeddingChunks, embedBatch, embedContentHash, embeddingModelId } from '@dejavue/ai';
import { backfillProgressEmbed, childLogger, getEnv } from '@dejavue/core';
import {
  channelMode,
  completeReindex,
  countIndexedMessages,
  countIndexedMessagesInChannel,
  ensureChannelSync,
  getBackfillJob,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  listEmbeddedThreadIdsInChannel,
  markChannelStale,
  markEntitlementConsumed,
  recordEmbeddingUsage,
  semanticSearch,
  setDuplicateOf,
  setEmbedContentHash,
  setPublished,
  updateBackfillJob,
  updateChannelName,
  upsertEmbedding,
  upsertThread,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import type { BackfillForumJob } from '@dejavue/queue';
import {
  fetchActiveGuildThreads,
  fetchArchivedPublicThreads,
  fetchChannelInfo,
  fetchStarterMessage,
  type RawThread,
} from '../lib/discordRest';
import { LiveProgress } from '../lib/progress';
import { embedBudgetGate, guildLimits } from '../lib/quota';

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

  // The one live progress message posted at setup (null → silent import).
  const live =
    bf.statusChannelId && bf.statusMessageId
      ? new LiveProgress({ channelId: bf.statusChannelId, messageId: bf.statusMessageId })
      : null;
  const label = `<#${bf.channelId}>`;

  await updateBackfillJob(db, bf.id, { status: 'running' });
  live?.update(backfillProgressEmbed({ channelLabel: label, phase: 'listing', done: 0 }));
  const cfg = await getGuildConfig(db, bf.guildId);
  const model = cfg?.embeddingModel ?? getEnv().EMBEDDING_MODEL;
  const storedModelId = embeddingModelId(model); // the actual active model id for provenance
  const solvedTagId = cfg?.solvedTagId ?? undefined;
  const limits = await guildLimits(bf.guildId);
  const mode = channelMode(cfg, bf.channelId);
  const processed = new Set(bf.processedThreadIds);

  // The KB groups its channel rail by the denormalized name on each row, so an import
  // needs it stamped here too — otherwise every imported forum lands in one nameless
  // "General" bucket. The update also repairs rows written before this ran.
  const info = await fetchChannelInfo(bf.channelId);
  const channelName = info?.name ?? null;
  if (channelName) {
    await updateChannelName(db, bf.guildId, bf.channelId, channelName).catch(() => undefined);
  }

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
    await markChannelStale(db, bf.guildId, bf.channelId, 'forum', 'gap').catch(() => undefined);
    await live?.fail(
      backfillProgressEmbed({
        channelLabel: label,
        phase: 'failed',
        error: 'Could not read the channel history.',
      }),
    );
    return;
  }

  // Oldest first (snowflake order) so a duplicate always folds under the older
  // canonical — acyclic and stable across re-imports.
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await updateBackfillJob(db, bf.id, { total: all.length });
  live?.update(
    backfillProgressEmbed({ channelLabel: label, phase: 'importing', done: bf.processed, total: all.length }),
  );

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

  const checkpoint = async (): Promise<void> => {
    await updateBackfillJob(db, bf.id, {
      processed: processedCount,
      failed,
      processedThreadIds: [...processed],
    });
    live?.update(
      backfillProgressEmbed({
        channelLabel: label,
        phase: 'importing',
        done: processedCount,
        total: all.length,
      }),
    );
  };

  const todo = all.filter((t) => !processed.has(t.id) && !alreadyDone.has(t.id));
  const batchSize = getEnv().EMBED_BATCH_SIZE;
  const canSpend = embedBudgetGate(bf.guildId);

  // Imported in windows: rows are created first, then the whole window's passages are
  // embedded in ONE request (instead of one request per thread), then each thread is
  // folded/published in order. Sequencing the fold pass *after* the batch — but still
  // one thread at a time — keeps auto-fold semantics intact: thread N still searches a
  // database that already contains threads 1..N-1 from this same window.
  for (let w = 0; w < todo.length && !cappedOut; w += batchSize) {
    const prepared: {
      t: RawThread;
      rowId: string;
      isSolved: boolean;
      src: { title: string; questionBody: string };
      chunk: { index: number; hash: string; text: string } | undefined;
    }[] = [];

    for (const t of todo.slice(w, w + batchSize)) {
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
          channelName: channelName ?? undefined, // never clobber a known name with null
          threadId: t.id,
          title: t.name,
          questionBody: starter?.content ?? '',
          opUserId: starter?.author?.id ?? null,
          status: isSolved ? 'solved' : 'open',
        });
        indexedMessages++;
        // Backfill only has the starter message (no full transcript), so this is the
        // canonical title + question chunk — the same chunk 0 the live job builds.
        const src = { title: t.name, questionBody: starter?.content ?? '' };
        prepared.push({ t, rowId: row.id, isSolved, src, chunk: buildEmbeddingChunks(src)[0] });
      } catch (err) {
        failed++;
        log.warn({ err, threadId: t.id }, 'backfill: failed to import thread');
        processed.add(t.id);
      }
    }

    // An import is the single largest embedding spend a guild can trigger — check the
    // monthly ceiling per window rather than per thread.
    const withText = (await canSpend()) ? prepared.filter((p) => p.chunk) : [];
    const { vectors, tokens } = withText.length
      ? await embedBatch(
          withText.map((p) => p.chunk!.text),
          { mode: 'passage', model },
        )
      : { vectors: [] as number[][], tokens: 0 };
    const vectorOf = new Map(withText.map((p, i) => [p.t.id, vectors[i]] as const));
    // Import is where a guild's embedding spend actually lands — record it.
    if (tokens > 0) {
      await recordEmbeddingUsage(db, { guildId: bf.guildId, model: storedModelId, tokens }).catch(
        () => undefined,
      );
      capture('embedding_batch', bf.guildId, {
        tokens,
        chunks: withText.length,
        model_id: storedModelId,
        reason: 'backfill',
      });
    }

    for (const p of prepared) {
      try {
        const vector = vectorOf.get(p.t.id);
        if (vector && p.chunk) {
          await upsertEmbedding(db, {
            threadRowId: p.rowId,
            guildId: bf.guildId,
            modelId: storedModelId,
            chunkIndex: p.chunk.index,
            chunkHash: p.chunk.hash,
            vector,
          });
          // Stamp the thread hash too, so the first live capture doesn't see every
          // backfilled thread as dirty and re-embed the whole import.
          await setEmbedContentHash(db, p.rowId, embedContentHash(p.src)).catch(() => undefined);
        }

        // Already a duplicate from a prior run, or fold it now under an older
        // near-identical canonical (resolve to root; only ever fold newer → older
        // so the graph stays acyclic).
        const existing = await getThreadByDiscordId(db, bf.guildId, p.t.id);
        let isDup = !!existing?.duplicateOfThreadId;
        if (!isDup && vector) {
          const [match] = await semanticSearch(db, {
            guildId: bf.guildId,
            queryVector: vector,
            limit: 1,
            minSimilarity: AUTO_FOLD_SIMILARITY,
            excludeThreadId: p.t.id,
            solvedOnly: false,
            modelId: storedModelId,
          });
          if (match && match.threadId !== p.t.id) {
            const matchRow = await getThreadByDiscordId(db, bf.guildId, match.threadId);
            const root = matchRow?.duplicateOfThreadId ?? match.threadId;
            if (root !== p.t.id && BigInt(root) < BigInt(p.t.id)) {
              await setDuplicateOf(db, bf.guildId, p.t.id, root);
              isDup = true;
            }
          }
        }

        if (isDup) {
          // A folded copy never stands alone on the KB.
          await setPublished(db, bf.guildId, p.t.id, false);
        } else if (mode === 'knowledge' || p.isSolved) {
          // Auto-publish everything online. Open questions stay private until solved.
          await setPublished(db, bf.guildId, p.t.id, true);
          await enqueueRevalidateKb({
            guildId: bf.guildId,
            threadId: p.t.id,
            action: 'publish',
          }).catch(() => undefined);
        }

        processedCount++;
      } catch (err) {
        failed++;
        log.warn({ err, threadId: p.t.id }, 'backfill: failed to import thread');
      }
      processed.add(p.t.id);
      if (processedCount % CHECKPOINT_EVERY === 0) await checkpoint();
    }
  }

  await updateBackfillJob(db, bf.id, {
    processed: processedCount,
    failed,
    processedThreadIds: [...processed],
    status: 'completed',
  });

  // Flip the channel's freshness so the setup hub shows "✅ up to date" instead of
  // "not yet indexed" after the first import. `all` is sorted ascending, so the last
  // id is the newest thread (= its starter message id, a valid watermark). Using
  // completeReindex also stamps lastReindexAt, which both feeds "scanned X ago" and
  // keeps the hourly auto-rescan throttle from re-scanning right after the import.
  try {
    if (cappedOut) {
      await markChannelStale(db, bf.guildId, bf.channelId, 'forum', 'cap');
    } else {
      // ensure (not get): the upgrade-triggered backfill path never calls
      // ensureChannelSync, so the row may not exist yet — completeReindex is a bare
      // UPDATE that would silently no-op without it.
      const sync = await ensureChannelSync(db, bf.guildId, bf.channelId, 'forum');
      if (sync.state !== 'reindexing') {
        const count = await countIndexedMessagesInChannel(db, bf.guildId, bf.channelId);
        await completeReindex(db, bf.guildId, bf.channelId, {
          indexedMessageCount: count,
          lastIndexedMessageId: all.at(-1)?.id ?? null,
        });
      }
    }
  } catch (err) {
    log.warn({ err, jobId: bf.id }, 'backfill: failed to update channel sync');
  }
  await live?.finalize(
    backfillProgressEmbed({
      channelLabel: label,
      phase: 'done',
      done: processedCount,
      total: all.length,
      failedCount: failed,
      capped: cappedOut,
    }),
  );

  // Consume any legacy durable backfill entitlement once the job durably completes.
  if (bf.entitlementId) await markEntitlementConsumed(db, bf.entitlementId);
  log.info(
    { jobId: bf.id, processed: processedCount, failed, total: all.length, cappedOut, indexedMessages },
    'backfill complete',
  );
}
