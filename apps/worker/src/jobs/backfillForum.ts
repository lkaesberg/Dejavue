import { capture } from '@dejavue/analytics';
import { buildEmbeddingChunks, embedBatch, embedContentHash, embeddingModelId } from '@dejavue/ai';
import { backfillProgressEmbed, childLogger, getEnv } from '@dejavue/core';
import {
  type BackfillJob,
  channelMode,
  claimBackfillJob,
  completeReindex,
  countIndexedMessages,
  countIndexedMessagesInChannel,
  ensureChannelSync,
  getActiveReindexJob,
  getBackfillJob,
  getDb,
  getGuildConfig,
  getOtherActiveBackfillJob,
  type GuildConfig,
  heartbeatBackfillJob,
  getThreadByDiscordId,
  isPublishable,
  isOptedOut,
  listEmbeddedThreadIdsInChannel,
  markChannelStale,
  markEntitlementConsumed,
  recordEmbeddingUsage,
  semanticSearch,
  setDuplicateOf,
  setEmbedContentHash,
  setPublished,
  transitionBackfillJob,
  updateBackfillJob,
  updateChannelName,
  upsertEmbedding,
  upsertThread,
  whileChannelMonitored,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import type { BackfillForumJob } from '@dejavue/queue';
import {
  fetchActiveGuildThreads,
  fetchArchivedPublicThreads,
  archivedAt,
  fetchChannelInfo,
  forumSolvedTagId,
  fetchStarterMessage,
  type RawThread,
} from '../lib/discordRest';
import {
  ChannelUnmonitoredError,
  isChannelMonitored,
  JOB_LEASE_MS,
  JobLeaseHeldError,
  startHeartbeat,
} from '../lib/jobLease';
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
  const existing = await getBackfillJob(db, job.backfillJobId);
  if (!existing || existing.status === 'completed') return;

  // The one live progress message posted at setup (null → silent import).
  const live =
    existing.statusChannelId && existing.statusMessageId
      ? new LiveProgress({ channelId: existing.statusChannelId, messageId: existing.statusMessageId })
      : null;
  const label = `<#${existing.channelId}>`;

  // One history job per forum at a time. A re-scan re-reads and re-embeds every thread
  // (a superset of this import), and a second import of the same forum would only redo
  // the same work — either way this row is redundant, so it ends instead of overlapping.
  if (existing.status !== 'running') {
    const other =
      (await getActiveReindexJob(db, existing.guildId, existing.channelId)) ??
      (await getOtherActiveBackfillJob(db, existing));
    if (other) {
      if (await transitionBackfillJob(db, existing.id, ['pending', 'failed'], 'failed')) {
        log.info({ jobId: existing.id, by: other.id }, 'backfill superseded by another job on this forum');
        await live?.fail(
          backfillProgressEmbed({
            channelLabel: label,
            phase: 'failed',
            error: 'Another import or re-scan of this channel is already running — it covers this one.',
          }),
        );
      }
      return;
    }
  }

  // pending/failed → running (a retry after a recorded failure resumes from its
  // checkpoint), or re-take a dead worker's run. A row a live worker holds is refused:
  // throw so pg-boss retries later instead of importing it twice.
  const bf = await claimBackfillJob(db, existing.id, JOB_LEASE_MS);
  if (!bf) throw new JobLeaseHeldError('backfill', existing.id);

  const stopHeartbeat = startHeartbeat(() => heartbeatBackfillJob(db, bf.id));
  try {
    await runBackfill(bf, live, label);
  } catch (err) {
    const unmonitored = err instanceof ChannelUnmonitoredError;
    if (unmonitored) log.info({ jobId: bf.id, channelId: bf.channelId }, 'backfill target no longer monitored; stopped');
    else log.error({ err, jobId: bf.id }, 'backfill failed');
    // Every error lands the row on 'failed' (never a stuck 'running'). A real failure is
    // rethrown so pg-boss retries it — the claim accepts 'failed', resuming from the
    // last checkpoint — and stays 'failed' once retries run out.
    await transitionBackfillJob(db, bf.id, ['running'], 'failed').catch(() => undefined);
    if (unmonitored) {
      await live?.fail(
        backfillProgressEmbed({
          channelLabel: label,
          phase: 'failed',
          error: 'This channel is no longer monitored, so the import stopped.',
        }),
      );
      return;
    }
    // Only flag freshness for a channel we still watch (never resurrect a removed row).
    if (isChannelMonitored(await getGuildConfig(db, bf.guildId).catch(() => undefined), bf.channelId, 'forum')) {
      await markChannelStale(db, bf.guildId, bf.channelId, 'forum', 'gap').catch(() => undefined);
    }
    await live?.fail(
      backfillProgressEmbed({
        channelLabel: label,
        phase: 'failed',
        error: err instanceof ListingError ? 'Could not read the channel history.' : 'The import hit an error.',
      }),
    );
    throw err;
  } finally {
    stopHeartbeat();
  }
}

/** Listing the forum's threads failed (Discord unreachable / no access). */
class ListingError extends Error {
  constructor(cause: unknown) {
    super('backfill: failed to list threads', { cause });
    this.name = 'ListingError';
  }
}

/** Abort (per thread, and at checkpoints) when the forum was removed from monitoring mid-run. */
async function loadMonitoredConfig(bf: BackfillJob): Promise<GuildConfig | undefined> {
  const cfg = await getGuildConfig(getDb(), bf.guildId);
  if (!isChannelMonitored(cfg, bf.channelId, 'forum')) throw new ChannelUnmonitoredError(bf.channelId);
  return cfg;
}

async function runBackfill(bf: BackfillJob, live: LiveProgress | null, label: string): Promise<void> {
  const db = getDb();
  live?.update(backfillProgressEmbed({ channelLabel: label, phase: 'listing', done: 0 }));
  const cfg = await loadMonitoredConfig(bf);
  const model = cfg?.embeddingModel ?? getEnv().EMBEDDING_MODEL;
  const storedModelId = embeddingModelId(model); // the actual active model id for provenance
  let limits = await guildLimits(bf.guildId);
  const mode = channelMode(cfg, bf.channelId);
  const processed = new Set(bf.processedThreadIds);

  // The KB groups its channel rail by the denormalized name on each row, so an import
  // needs it stamped here too — otherwise every imported forum lands in one nameless
  // "General" bucket. The update also repairs rows written before this ran.
  const info = await fetchChannelInfo(bf.channelId);
  const channelName = info?.name ?? null;
  const solvedTagId = forumSolvedTagId(info, cfg?.solvedTagId);
  if (channelName) {
    await updateChannelName(db, bf.guildId, bf.channelId, channelName).catch(() => undefined);
  }

  // Collect active + paginated archived threads for the forum. Always a full listing
  // (no cursor resume): it is cheap metadata, `total` needs the complete set, and
  // processedThreadIds already skips the expensive per-thread work on a retry.
  const all: RawThread[] = [];
  try {
    const active = (await fetchActiveGuildThreads(bf.guildId)).filter(
      (t) => t.parent_id === bf.channelId,
    );
    all.push(...active);

    let cursor: string | undefined;
    for (;;) {
      const page = await fetchArchivedPublicThreads(bf.channelId, cursor);
      all.push(...page.threads);
      const last = page.threads.at(-1);
      cursor = last?.thread_metadata?.archive_timestamp;
      if (page.threads.length === 0 || !page.hasMore || !cursor) break;
    }
  } catch (err) {
    throw new ListingError(err);
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
  // Failures of THIS run only: a failed thread is left out of processedThreadIds, so a
  // retry re-attempts it instead of skipping it — a prior run's count would double up.
  let failed = 0;
  let cappedOut = false;

  const checkpoint = async (): Promise<void> => {
    await loadMonitoredConfig(bf);
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
      // A forum removed from the hub mid-run must not gain rows (or KB pages) after the
      // removal — re-check before every thread, not just at the 25-thread checkpoints.
      await loadMonitoredConfig(bf);
      if (indexedMessages >= limits.indexCap) {
        // A tier upgrade may have landed mid-run (checkTierUpgrade won't queue a second
        // import while this one is active) — re-read the cap before stopping.
        limits = await guildLimits(bf.guildId);
        if (indexedMessages >= limits.indexCap) {
          cappedOut = true;
          break;
        }
      }
      try {
        const starter = await fetchStarterMessage(t.id);
        // A post by a member who opted out (`/dejavue privacy`) is never imported.
        if (await isOptedOut(db, starter?.author?.id ?? t.owner_id)) {
          processed.add(t.id);
          continue;
        }
        const isSolved = solvedTagId ? (t.applied_tags ?? []).includes(solvedTagId) : false;
        // Written atomically with the monitoring check: the check above ran before the
        // starter fetch, so a removal landing in between must still stop this row.
        const row = await whileChannelMonitored(db, bf.guildId, bf.channelId, 'forum', (tx) =>
          upsertThread(tx, {
            guildId: bf.guildId,
            channelId: bf.channelId,
            channelName: channelName ?? undefined, // never clobber a known name with null
            threadId: t.id,
            title: t.name,
            questionBody: starter?.content ?? '',
            opUserId: starter?.author?.id ?? null,
            status: isSolved ? 'solved' : 'open',
            solvedAt: isSolved ? archivedAt(t) : undefined,
          }),
        );
        if (!row) throw new ChannelUnmonitoredError(bf.channelId);
        indexedMessages++;
        // Backfill only has the starter message (no full transcript), so this is the
        // canonical title + question chunk — the same chunk 0 the live job builds.
        const src = { title: t.name, questionBody: starter?.content ?? '' };
        // The row's status, not the tag's: an 'open' row is promoted from the tag by
        // upsertThread, an explicit reopen to 'unsolved' is not overridden.
        prepared.push({
          t,
          rowId: row.id,
          isSolved: row.status === 'solved',
          src,
          chunk: buildEmbeddingChunks(src)[0],
        });
      } catch (err) {
        if (err instanceof ChannelUnmonitoredError) throw err;
        // Not added to `processed`: a retry of this job re-attempts the thread.
        failed++;
        log.warn({ err, threadId: t.id }, 'backfill: failed to import thread');
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
      let ok = false;
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

        if (isDup || (existing && !isPublishable(existing))) {
          // A folded copy (onto a canonical or by hand) or an opted-out post never
          // stands alone on the KB.
          if (isDup || existing?.publishedToKb) await setPublished(db, bf.guildId, p.t.id, false);
        } else if (mode === 'knowledge' || p.isSolved) {
          // Auto-publish everything online. Open questions stay private until solved.
          // Never publish into a forum that was just removed from the hub.
          const published = await whileChannelMonitored(db, bf.guildId, bf.channelId, 'forum', (tx) =>
            setPublished(tx, bf.guildId, p.t.id, true).then(() => true),
          );
          if (!published) throw new ChannelUnmonitoredError(bf.channelId);
          await enqueueRevalidateKb({
            guildId: bf.guildId,
            threadId: p.t.id,
            action: 'publish',
          }).catch(() => undefined);
        }

        processedCount++;
        ok = true;
      } catch (err) {
        if (err instanceof ChannelUnmonitoredError) throw err;
        failed++;
        log.warn({ err, threadId: p.t.id }, 'backfill: failed to import thread');
      }
      // Only a thread that made it is skipped on a retry; a failed one is re-attempted.
      if (ok) {
        processed.add(p.t.id);
        if (processedCount % CHECKPOINT_EVERY === 0) await checkpoint();
      }
    }
  }

  // Nothing this run made it but something failed (e.g. every embedding insert was
  // refused — a dimension mismatch, the DB or the embed service down): that is a failed
  // import, not "up to date". Save progress and throw, so the row lands on 'failed', the
  // channel on stale 'gap', and pg-boss retries the failed threads.
  if (failed > 0 && processedCount === bf.processed) {
    await updateBackfillJob(db, bf.id, { processed: processedCount, failed, processedThreadIds: [...processed] });
    throw new Error(`backfill: all ${failed} attempted threads failed`);
  }

  // Re-check before the final writes: a forum removed from the hub mid-run must not get
  // its channel_sync row recreated below.
  await loadMonitoredConfig(bf);
  if (
    !(await transitionBackfillJob(db, bf.id, ['running'], 'completed', {
      processed: processedCount,
      failed,
      processedThreadIds: [...processed],
    }))
  ) {
    log.warn({ jobId: bf.id }, 'backfill finished after its row left running; leaving channel state alone');
    return;
  }

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
        // Some threads failed → stale 'partial' (a re-scan retries them), not synced.
        await completeReindex(db, bf.guildId, bf.channelId, {
          indexedMessageCount: count,
          lastIndexedMessageId: all.at(-1)?.id ?? null,
          failed,
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
