import { embeddingModelId } from '@dejavue/ai';
import {
  childLogger,
  getEnv,
  MIN_SEGMENT_MSGS,
  reindexProgressEmbed,
  segmentByGap,
  segmentTitle,
} from '@dejavue/core';
import {
  channelMode,
  completeReindex,
  countIndexedMessages,
  countIndexedMessagesInChannel,
  deleteThreadsByDiscordIds,
  failReindex,
  getDb,
  getGuildConfig,
  getReindexJob,
  getThreadByDiscordId,
  type GuildConfig,
  listThreadIdsByChannel,
  type ReindexJob,
  semanticSearch,
  setDuplicateOf,
  setPublished,
  setTranscript,
  type TranscriptAttachment,
  type TranscriptMessage,
  updateChannelName,
  updateReindexJob,
  upsertThread,
} from '@dejavue/db';
import {
  enqueueIngestAttachment,
  enqueueRevalidateKb,
  type IngestAttachmentItem,
  type ReindexChannelJob,
} from '@dejavue/queue';
import {
  fetchActiveGuildThreads,
  fetchArchivedPublicThreads,
  fetchChannelInfo,
  fetchChannelMessages,
  fetchStarterMessage,
  type RawChannelMessage,
  type RawThread,
} from '../lib/discordRest';
import { LiveProgress } from '../lib/progress';
import { syncThreadEmbeddings } from '../lib/embedChunks';
import { embedBudgetGate, guildLimits } from '../lib/quota';

const log = childLogger({ mod: 'job:reindex-channel' });
const CHECKPOINT_EVERY = 25;
// No human confirms an imported duplicate, so only fold near-identical reposts.
const AUTO_FOLD_SIMILARITY = 0.9;

/**
 * A durable, resumable full rescan of a channel. Unlike backfill (import-only), reindex
 * FORCE re-embeds everything and PRUNES content Discord no longer returns — the prune
 * runs only after the full listing completes, so a partial run can never delete
 * not-yet-paged content. Drives the one live-progress message the command/auto-trigger
 * posted.
 */
export async function handleReindexChannel(job: ReindexChannelJob): Promise<void> {
  const db = getDb();
  const rj = await getReindexJob(db, job.reindexJobId);
  if (!rj || rj.status === 'completed') return;
  const cfg = await getGuildConfig(db, rj.guildId);
  const live =
    rj.statusChannelId && rj.statusMessageId
      ? new LiveProgress({ channelId: rj.statusChannelId, messageId: rj.statusMessageId })
      : null;
  const label = `<#${rj.channelId}>`;

  await updateReindexJob(db, rj.id, { status: 'running' });
  try {
    if (rj.kind === 'forum') await reindexForum(rj, cfg, live, label);
    else await reindexTracked(rj, cfg, live, label);
  } catch (err) {
    log.error({ err, jobId: rj.id }, 'reindex failed');
    await updateReindexJob(db, rj.id, { status: 'failed' });
    // failReindex (not markChannelStale): the channel is in 'reindexing' from setReindexing,
    // and markChannelStale deliberately won't overwrite that — which would pin a failed
    // reindex at "re-scanning…" forever. This forces it to 'stale' so it's retryable.
    await failReindex(db, rj.guildId, rj.channelId, 'reindex failed').catch(() => undefined);
    await live?.fail(
      reindexProgressEmbed({
        channelLabel: label,
        kind: rj.kind,
        phase: 'failed',
        error: 'Reindex hit an error.',
      }),
    );
  }
}

async function reindexForum(
  rj: ReindexJob,
  cfg: GuildConfig | undefined,
  live: LiveProgress | null,
  label: string,
): Promise<void> {
  const db = getDb();
  const model = cfg?.embeddingModel ?? getEnv().EMBEDDING_MODEL;
  const storedModelId = embeddingModelId(model);
  const canSpend = embedBudgetGate(rj.guildId);
  const solvedTagId = cfg?.solvedTagId ?? undefined;
  const mode = channelMode(cfg, rj.channelId);
  const limits = await guildLimits(rj.guildId);

  // The KB groups its channel rail by the denormalized name on each row, so a forum
  // imported by the worker (rather than captured live) needs it stamped here too —
  // and a single update repairs rows written before this ran (or after a rename).
  const info = await fetchChannelInfo(rj.channelId);
  const channelName = info?.name ?? null;
  if (channelName) {
    await updateChannelName(db, rj.guildId, rj.channelId, channelName).catch(() => undefined);
  }

  // 1. LIST active + archived threads. Always a full pass (no cursor resume): the prune
  // below relies on `seen` being the COMPLETE set, so a partial listing must never drive
  // it. Re-listing thread metadata on retry is cheap; processedThreadIds (below) still
  // skips the expensive re-embed of already-done threads.
  const all: RawThread[] = [];
  const active = (await fetchActiveGuildThreads(rj.guildId)).filter(
    (t) => t.parent_id === rj.channelId,
  );
  all.push(...active);
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchArchivedPublicThreads(rj.channelId, cursor);
    all.push(...page.threads);
    cursor = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if (page.threads.length === 0 || !page.hasMore || !cursor) break;
  }
  // Oldest first so a duplicate always folds under the older canonical (acyclic).
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  await updateReindexJob(db, rj.id, { total: all.length, phase: 'indexing' });
  live?.update(reindexProgressEmbed({ channelLabel: label, kind: 'forum', phase: 'listing', done: all.length }));

  // 2. INDEX — revisit every thread (not skip-if-present like backfill). The embedding
  //    itself is still chunk-diffed, so an unchanged thread costs no API calls.
  // `seen` = the COMPLETE listing (every thread Discord returned), built up front so the
  // prune in step 3 is correct even if indexing stops early at the cap. Deriving it from
  // the loop instead would omit everything after an early `break` and prune live threads.
  const seen = new Set(all.map((t) => t.id));
  const processed = new Set(rj.processedThreadIds);
  let processedCount = rj.processed;
  let indexed = await countIndexedMessages(db, rj.guildId);
  for (const t of all) {
    if (processed.has(t.id)) continue;
    if (indexed >= limits.indexCap) break;
    try {
      const starter = await fetchStarterMessage(t.id);
      const isSolved = solvedTagId ? (t.applied_tags ?? []).includes(solvedTagId) : false;
      const row = await upsertThread(db, {
        guildId: rj.guildId,
        channelId: rj.channelId,
        channelName: channelName ?? undefined, // never clobber a known name with null
        threadId: t.id,
        title: t.name,
        questionBody: starter?.content ?? '',
        opUserId: starter?.author?.id ?? null,
        status: isSolved ? 'solved' : 'open',
      });
      indexed++;

      const src = {
        title: t.name,
        questionBody: starter?.content ?? '',
        acceptedAnswerText: row.acceptedAnswerText,
        transcript: row.transcript,
      };
      // Chunk-diffed: an unchanged thread costs nothing, a model switch rebuilds it.
      const { primaryVector: vector } = await syncThreadEmbeddings(db, {
        threadRowId: row.id,
        guildId: rj.guildId,
        modelId: storedModelId,
        modelKey: model,
        src,
        canSpend,
        reason: 'reindex',
      });

      // Fold near-duplicate reposts under the older canonical.
      let isDup = !!row.duplicateOfThreadId;
      if (!isDup && vector) {
        const [match] = await semanticSearch(db, {
          guildId: rj.guildId,
          queryVector: vector,
          limit: 1,
          minSimilarity: AUTO_FOLD_SIMILARITY,
          excludeThreadId: t.id,
          solvedOnly: false,
          modelId: storedModelId,
        });
        if (match && match.threadId !== t.id) {
          const matchRow = await getThreadByDiscordId(db, rj.guildId, match.threadId);
          const root = matchRow?.duplicateOfThreadId ?? match.threadId;
          if (root !== t.id && BigInt(root) < BigInt(t.id)) {
            await setDuplicateOf(db, rj.guildId, t.id, root);
            isDup = true;
          }
        }
      }

      if (isDup) {
        await setPublished(db, rj.guildId, t.id, false);
      } else if (mode === 'knowledge' || isSolved) {
        // Auto-publish; open questions stay private until solved.
        await setPublished(db, rj.guildId, t.id, true);
        await enqueueRevalidateKb({ guildId: rj.guildId, threadId: t.id, action: 'publish' }).catch(
          () => undefined,
        );
      }
      processedCount++;
    } catch (err) {
      log.warn({ err, threadId: t.id }, 'reindex: failed thread');
    }
    processed.add(t.id);
    if (processedCount % CHECKPOINT_EVERY === 0) {
      await updateReindexJob(db, rj.id, { processed: processedCount, processedThreadIds: [...processed] });
      live?.update(
        reindexProgressEmbed({ channelLabel: label, kind: 'forum', phase: 'indexing', done: processedCount, total: all.length }),
      );
    }
  }

  // 3. PRUNE threads Discord no longer returns (only after the full listing).
  await updateReindexJob(db, rj.id, { phase: 'pruning', processed: processedCount, processedThreadIds: [...processed] });
  live?.update(reindexProgressEmbed({ channelLabel: label, kind: 'forum', phase: 'pruning' }));
  const dbIds = await listThreadIdsByChannel(db, rj.guildId, rj.channelId);
  const gone = dbIds.filter((id) => !seen.has(id));
  let removed = 0;
  if (gone.length) {
    removed = await deleteThreadsByDiscordIds(db, rj.guildId, gone);
    for (const id of gone) {
      await enqueueRevalidateKb({ guildId: rj.guildId, threadId: id, action: 'unpublish' }).catch(
        () => undefined,
      );
    }
  }

  // 4. DONE
  await updateReindexJob(db, rj.id, { status: 'completed', phase: 'done', removed });
  const count = await countIndexedMessagesInChannel(db, rj.guildId, rj.channelId);
  await completeReindex(db, rj.guildId, rj.channelId, {
    indexedMessageCount: count,
    lastIndexedMessageId: all.at(-1)?.id ?? null,
  });
  await live?.finalize(
    reindexProgressEmbed({ channelLabel: label, kind: 'forum', phase: 'done', done: processedCount, removed }),
  );
  log.info({ jobId: rj.id, processed: processedCount, removed }, 'forum reindex complete');
}

interface SegMsg extends TranscriptMessage {
  messageId: string;
}

function mapRawAttachments(atts: RawChannelMessage['attachments']): {
  attachments: TranscriptAttachment[];
  ingest: IngestAttachmentItem[];
} {
  const attachments: TranscriptAttachment[] = [];
  const ingest: IngestAttachmentItem[] = [];
  for (const a of atts ?? []) {
    const ct = a.content_type ?? undefined;
    const kind = ct?.startsWith('image/') ? 'image' : ct?.startsWith('video/') ? 'video' : 'file';
    attachments.push({
      id: a.id,
      name: a.filename,
      kind,
      contentType: ct,
      size: a.size,
      width: a.width,
      height: a.height,
      url: a.url,
    });
    if (kind === 'image') ingest.push({ id: a.id, url: a.url, name: a.filename, contentType: ct, size: a.size });
  }
  return { attachments, ingest };
}

/** Page a channel's (or thread's) FULL message history via REST, oldest→newest. */
async function pageAllMessages(
  channelId: string,
  onPage?: (count: number) => void,
): Promise<{ msgs: SegMsg[]; images: IngestAttachmentItem[]; pages: number }> {
  const msgs: SegMsg[] = [];
  const images: IngestAttachmentItem[] = [];
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const batch = await fetchChannelMessages(channelId, before);
    pages++;
    if (batch.length === 0) break;
    for (const m of batch) {
      if (m.author?.bot) continue;
      const content = (m.content ?? '').trim();
      const { attachments, ingest } = mapRawAttachments(m.attachments);
      if (!content && attachments.length === 0) continue;
      images.push(...ingest);
      const reactions = (m.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
      msgs.push({
        messageId: m.id,
        authorId: m.author?.id ?? '',
        content,
        createdAt: m.timestamp,
        ...(attachments.length ? { attachments } : {}),
        ...(reactions ? { reactions } : {}),
      });
    }
    before = batch.at(-1)?.id;
    onPage?.(msgs.length);
    // Stop only on a short/empty page (the true last page) — never mid-history.
    if (!before || batch.length < 100) break;
  }
  msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { msgs, images, pages };
}

/** Every thread (active + archived) that lives under a channel. */
async function listChannelThreads(guildId: string, channelId: string): Promise<RawThread[]> {
  const out: RawThread[] = [];
  const active = (await fetchActiveGuildThreads(guildId)).filter((t) => t.parent_id === channelId);
  out.push(...active);
  let cur: string | undefined;
  for (;;) {
    const page = await fetchArchivedPublicThreads(channelId, cur);
    out.push(...page.threads);
    cur = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if (page.threads.length === 0 || !page.hasMore || !cur) break;
  }
  return out;
}

async function reindexTracked(
  rj: ReindexJob,
  cfg: GuildConfig | undefined,
  live: LiveProgress | null,
  label: string,
): Promise<void> {
  const db = getDb();
  const model = cfg?.embeddingModel ?? getEnv().EMBEDDING_MODEL;
  const storedModelId = embeddingModelId(model);
  const canSpend = embedBudgetGate(rj.guildId);
  const limits = await guildLimits(rj.guildId);

  const info = await fetchChannelInfo(rj.channelId);
  const channelName = info?.name ?? null;
  if (channelName) await updateChannelName(db, rj.guildId, rj.channelId, channelName).catch(() => undefined);

  // 1. Page the main channel's FULL history (idempotent on retry).
  const main = await pageAllMessages(rj.channelId, (n) =>
    live?.update(reindexProgressEmbed({ channelLabel: label, kind: 'tracked', phase: 'listing', done: n })),
  );
  await enqueueIngestAttachment({ guildId: rj.guildId, items: main.images }).catch(() => undefined);

  // The channel's threads are sub-conversations captured as their own entries — the
  // live capture indexes them too, so the reindex must as well (a thread-heavy channel
  // has little top-level content and would otherwise look almost empty).
  let threads: RawThread[] = [];
  try {
    threads = await listChannelThreads(rj.guildId, rj.channelId);
  } catch (err) {
    log.warn({ err, channelId: rj.channelId }, 'reindex: failed to list channel threads');
  }

  const segments = segmentByGap(main.msgs).filter((s) => s.length >= MIN_SEGMENT_MSGS);
  const total = segments.length + threads.length;
  await updateReindexJob(db, rj.id, { total, phase: 'indexing' });

  const builtIds = new Set<string>();
  let processedCount = 0;
  let skippedForCap = 0;
  let indexed = await countIndexedMessages(db, rj.guildId);

  // Index one KB entry (a main-channel segment or a whole thread). Cap-aware: existing
  // rows always refresh; new ones stop at the index cap.
  const indexEntry = async (
    threadId: string,
    title: string,
    transcript: TranscriptMessage[],
    opUserId: string | null,
  ): Promise<void> => {
    builtIds.add(threadId);
    if (transcript.length === 0) return;
    const existing = await getThreadByDiscordId(db, rj.guildId, threadId);
    if (!existing && indexed >= limits.indexCap) {
      skippedForCap++;
      return;
    }
    const row = await upsertThread(db, {
      guildId: rj.guildId,
      channelId: rj.channelId,
      channelName,
      kind: 'channel',
      threadId,
      title,
      questionBody: transcript[0]?.content ?? '',
      opUserId,
      status: 'open',
    });
    if (!existing) indexed++;
    if (!row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
      await setPublished(db, rj.guildId, threadId, true).catch(() => undefined);
      await enqueueRevalidateKb({ guildId: rj.guildId, threadId, action: 'publish' }).catch(() => undefined);
    }
    await setTranscript(db, row.id, transcript);
    await syncThreadEmbeddings(db, {
      threadRowId: row.id,
      guildId: rj.guildId,
      modelId: storedModelId,
      modelKey: model,
      src: { title: row.title, questionBody: row.questionBody, transcript },
      canSpend,
      reason: 'reindex',
    });
    processedCount++;
    if (processedCount % CHECKPOINT_EVERY === 0) {
      await updateReindexJob(db, rj.id, { processed: processedCount });
      live?.update(
        reindexProgressEmbed({ channelLabel: label, kind: 'tracked', phase: 'indexing', done: processedCount, total }),
      );
    }
  };

  // 2a. Main-channel conversation segments.
  for (const seg of segments) {
    const first = seg[0];
    if (!first) continue;
    const transcript: TranscriptMessage[] = seg.map(({ messageId, ...rest }) => ({ id: messageId, ...rest }));
    await indexEntry(first.messageId, segmentTitle(first.content), transcript, first.authorId);
  }

  // 2b. Each thread inside the channel → one entry (its whole conversation).
  for (const t of threads) {
    const tm = await pageAllMessages(t.id).catch(() => ({ msgs: [] as SegMsg[], images: [] as IngestAttachmentItem[], pages: 0 }));
    if (tm.images.length) await enqueueIngestAttachment({ guildId: rj.guildId, items: tm.images }).catch(() => undefined);
    const transcript: TranscriptMessage[] = tm.msgs.map(({ messageId, ...rest }) => ({ id: messageId, ...rest }));
    const title = t.name?.trim() || segmentTitle(transcript[0]?.content);
    await indexEntry(t.id, title, transcript, transcript[0]?.authorId ?? null);
  }

  // 3. PRUNE — remove rows we no longer rebuild. SAFE: skip on an empty scan, and never
  // delete content OLDER than the oldest message we actually saw (guards against a
  // partial scan wiping good history).
  await updateReindexJob(db, rj.id, { phase: 'pruning' });
  live?.update(reindexProgressEmbed({ channelLabel: label, kind: 'tracked', phase: 'pruning' }));
  let removed = 0;
  if (main.msgs.length > 0 || threads.length > 0) {
    const oldestId = main.msgs[0]?.messageId;
    const dbIds = await listThreadIdsByChannel(db, rj.guildId, rj.channelId);
    const gone = dbIds.filter((id) => {
      if (builtIds.has(id)) return false;
      if (oldestId && BigInt(id) < BigInt(oldestId)) return false; // older than we scanned → keep
      return true;
    });
    if (gone.length) {
      removed = await deleteThreadsByDiscordIds(db, rj.guildId, gone);
      for (const id of gone) {
        await enqueueRevalidateKb({ guildId: rj.guildId, threadId: id, action: 'unpublish' }).catch(() => undefined);
      }
    }
  }

  // 4. DONE
  await updateReindexJob(db, rj.id, { status: 'completed', phase: 'done', processed: processedCount, removed });
  const count = await countIndexedMessagesInChannel(db, rj.guildId, rj.channelId);
  await completeReindex(db, rj.guildId, rj.channelId, {
    indexedMessageCount: count,
    lastIndexedMessageId: main.msgs.at(-1)?.messageId ?? null,
  });
  await live?.finalize(
    reindexProgressEmbed({
      channelLabel: label,
      kind: 'tracked',
      phase: 'done',
      done: processedCount,
      removed,
      skipped: skippedForCap,
    }),
  );
  log.info(
    {
      jobId: rj.id,
      scannedMessages: main.msgs.length,
      pages: main.pages,
      threads: threads.length,
      segments: segments.length,
      processed: processedCount,
      skippedForCap,
      removed,
    },
    'tracked reindex complete',
  );
}
