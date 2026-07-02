import {
  ChannelType,
  EmbedBuilder,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { embedContentHash } from '@dejavue/ai';
import {
  childLogger,
  MIN_SEGMENT_MSGS,
  reindexProgressEmbed,
  segmentByGap,
  segmentTitle,
} from '@dejavue/core';
import {
  claimReindex,
  countIndexedMessagesInChannel,
  createReindexJob,
  ensureChannelSync,
  ensureGuildConfig,
  getActiveReindexJob,
  getDb,
  getThreadByDiscordId,
  markChannelStale,
  markChannelSynced,
  setLastEmbedMsgCount,
  setPublished,
  setTranscript,
  type TranscriptMessage,
  upsertThread,
} from '@dejavue/db';
import {
  enqueueEmbedThread,
  enqueueReindexChannel,
  enqueueRevalidateKb,
  type IngestAttachmentItem,
} from '@dejavue/queue';
import { mapAttachments, queueImageRehost } from './attachments';
import { keyedTrailingDebounce } from './debounce';
import { fetchTranscript } from './forum';
import { isReembedDue } from './knowledge';
import { atIndexCap } from './tier';

const log = childLogger({ mod: 'tracked' });

/**
 * Tracking a *normal* (non-forum) channel as a searchable KB. Unlike forum posts
 * there's no thread per topic, so we split the channel's recent messages into
 * conversation segments (a >20-minute silence starts a new one) and index each
 * segment as its own KB entry, keyed by the id of its first message. Segments
 * re-embed when their content changes; everything indexed is auto-published and
 * counts against the guild's single total-message index cap.
 *
 * The live (debounced) capture only scans the most recent window. When that reveals
 * the channel is missing history (a gap), we flip it to "stale" and kick a throttled
 * full reindex (apps/worker/src/jobs/reindexChannel.ts) which rescans everything and
 * prunes deleted content.
 */
const DEBOUNCE_MS = 5000;
const FETCH_LIMIT = 100;
// How far back the live capture pages the MAIN channel. Bounded so a huge channel
// doesn't re-scan forever each run — the full reindex job lifts this bound.
const MAX_MAIN_MESSAGES = 300;
// At most one auto-reindex per channel per hour (locked decision: throttled).
const REINDEX_THROTTLE_MS = 60 * 60 * 1000;

type TrackedChannel = TextChannel | NewsChannel;

interface SegMsg extends TranscriptMessage {
  messageId: string;
}

/**
 * Debounced (trailing-safe) captures: message bursts collapse to one run, and a
 * message landing while a capture is in flight triggers one follow-up run — so
 * the KB never waits for unrelated later activity to show it.
 */
const debouncedChannelCapture = keyedTrailingDebounce<TrackedChannel>(
  DEBOUNCE_MS,
  captureTrackedChannel,
  (err, channel) => log.warn({ err, channelId: channel.id }, 'tracked capture failed'),
);

export function scheduleTrackedCapture(channel: TrackedChannel): void {
  debouncedChannelCapture(channel.id, channel);
}

const debouncedThreadCapture = keyedTrailingDebounce<ThreadChannel>(
  DEBOUNCE_MS,
  captureTrackedThread,
  (err, thread) => log.warn({ err, threadId: thread.id }, 'tracked thread capture failed'),
);

/** Debounced capture of a thread that lives inside a tracked normal channel. */
export function scheduleTrackedThread(thread: ThreadChannel): void {
  debouncedThreadCapture(thread.id, thread);
}

async function fetchRecent(
  channel: TrackedChannel,
): Promise<{ messages: SegMsg[]; images: IngestAttachmentItem[]; hitLimit: boolean; ok: boolean }> {
  const out: SegMsg[] = [];
  const images: IngestAttachmentItem[] = [];
  let before: string | undefined;
  let hitLimit = false;
  let ok = true;
  try {
    // Page back through the main channel so the whole conversation is captured.
    while (out.length < MAX_MAIN_MESSAGES) {
      const batch = await channel.messages.fetch(
        before ? { limit: FETCH_LIMIT, before } : { limit: FETCH_LIMIT },
      );
      if (batch.size === 0) break;
      for (const m of batch.values()) {
        if (m.author?.bot) continue;
        const content = m.content?.trim() ?? '';
        const { attachments, images: imgs } = mapAttachments(m.attachments.values());
        if (!content && attachments.length === 0) continue;
        images.push(...imgs);
        let reactions = 0;
        for (const r of m.reactions.cache.values()) reactions += r.count;
        out.push({
          messageId: m.id,
          authorId: m.author.id,
          content,
          createdAt: new Date(m.createdTimestamp).toISOString(),
          ...(attachments.length ? { attachments } : {}),
          ...(reactions ? { reactions } : {}),
        });
      }
      before = batch.last()?.id; // newest-first, so last() is the oldest in the batch
      if (!before || batch.size < FETCH_LIMIT) break;
      if (out.length >= MAX_MAIN_MESSAGES) {
        hitLimit = true; // stopped at the window cap — there may be older history
        break;
      }
    }
  } catch {
    ok = false; // transient: never prune / never claim a gap on a failed fetch
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { messages: out, images, hitLimit, ok };
}

const toTranscript = (seg: SegMsg[]): TranscriptMessage[] =>
  seg.map(({ messageId, authorId, content, createdAt, attachments, reactions }) => ({
    id: messageId,
    authorId,
    content,
    createdAt,
    ...(attachments?.length ? { attachments } : {}),
    ...(reactions ? { reactions } : {}),
  }));

/** Newer-of two snowflake message ids (monotonic), null-safe. */
function newerId(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

/**
 * Kick a throttled, durable full reindex of a tracked channel and post the single
 * live-progress message the worker will keep editing. No-op if one is already in
 * flight or the per-channel hourly throttle hasn't elapsed.
 */
async function triggerTrackedReindex(channel: TrackedChannel): Promise<void> {
  const db = getDb();
  const guildId = channel.guildId;
  if (await getActiveReindexJob(db, guildId, channel.id)) return;
  await ensureChannelSync(db, guildId, channel.id, 'channel');
  if (!(await claimReindex(db, guildId, channel.id, REINDEX_THROTTLE_MS))) return;

  let statusMessageId: string | null = null;
  try {
    const e = reindexProgressEmbed({
      channelLabel: `<#${channel.id}>`,
      kind: 'tracked',
      phase: 'queued',
      auto: true,
    });
    const msg = await channel.send({
      embeds: [new EmbedBuilder().setTitle(e.title).setDescription(e.description).setColor(e.color)],
    });
    statusMessageId = msg.id;
  } catch {
    /* missing Send Messages — the reindex still runs, just without a live message */
  }
  const job = await createReindexJob(db, {
    guildId,
    channelId: channel.id,
    kind: 'tracked',
    statusChannelId: channel.id,
    statusMessageId,
  });
  await enqueueReindexChannel({ reindexJobId: job.id });
}

async function captureTrackedChannel(channel: TrackedChannel): Promise<void> {
  const db = getDb();
  const guildId = channel.guildId;
  const cfg = await ensureGuildConfig(db, guildId);
  // The channel may have been untracked during the debounce window.
  if (!cfg.trackedChannelIds.includes(channel.id)) return;
  const sync = await ensureChannelSync(db, guildId, channel.id, 'channel');

  const { messages, images, hitLimit, ok } = await fetchRecent(channel);
  // Re-host images while their Discord urls are fresh (deduped in the worker).
  await queueImageRehost(guildId, images);

  // Also capture the channel's threads (sub-conversations) as their own KB entries.
  try {
    const active = await channel.threads.fetchActive();
    for (const t of active.threads.values()) scheduleTrackedThread(t);
  } catch {
    /* needs Read Message History on threads; best effort */
  }

  const segments = segmentByGap(messages).filter((s) => s.length >= MIN_SEGMENT_MSGS);

  // Stop indexing NEW content once at the unified index cap (existing rows keep
  // updating). Computed once per run (a guild-wide transcript sum is not free).
  const atCap = await atIndexCap(guildId);
  let cappedOut = false;

  for (const seg of segments) {
    const first = seg[0];
    if (!first) continue;
    const threadId = first.messageId;
    const existing = await getThreadByDiscordId(db, guildId, threadId);

    if (!existing && atCap) {
      cappedOut = true;
      continue;
    }

    const row = await upsertThread(db, {
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      kind: 'channel',
      threadId,
      title: segmentTitle(first.content),
      questionBody: first.content,
      opUserId: first.authorId,
      status: 'open',
    });

    // Everything indexed is online (auto-publish). The public site itself is still
    // gated by kbPublishOptIn + the passphrase, but the row is always marked published.
    if (!row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
      await setPublished(db, guildId, threadId, true).catch(() => undefined);
      await enqueueRevalidateKb({ guildId, threadId, action: 'publish' }).catch(() => undefined);
    }

    // The KB page must always show every message: re-capture the segment each run.
    const transcript = toTranscript(seg);
    await setTranscript(db, row.id, transcript).catch(() => undefined);

    // Re-embed when the embed-source text changed since the last embed (edit/delete),
    // or on the growth backoff while the segment is still forming.
    const dirty =
      row.embedContentHash !==
      embedContentHash({ title: row.title, questionBody: row.questionBody, transcript });
    if (!isReembedDue(seg.length, row.lastEmbedMsgCount, dirty)) continue;
    let queued = false;
    try {
      await enqueueEmbedThread({
        threadRowId: row.id,
        guildId,
        modelId: cfg.embeddingModel,
        title: row.title,
        question: row.questionBody,
        answer: null,
      });
      queued = true;
    } catch (err) {
      log.warn({ err, threadId }, 'tracked embed enqueue failed');
    }
    if (queued) await setLastEmbedMsgCount(db, row.id, Math.max(seg.length, 1));
  }

  // Update freshness. A transient fetch failure must not move the watermark or claim
  // a gap (mirrors the reconcile 10003-only safety invariant).
  if (!ok) return;
  const newestId = messages.at(-1)?.messageId ?? null;
  const oldestId = messages[0]?.messageId ?? null;
  const count = await countIndexedMessagesInChannel(db, guildId, channel.id);

  // Gap = we're missing history between our watermark and what we just fetched, OR
  // this is the first index of a channel with more history than one window.
  let hasGap = false;
  if (sync.lastIndexedMessageId == null) hasGap = hitLimit;
  else if (oldestId && BigInt(oldestId) > BigInt(sync.lastIndexedMessageId)) hasGap = true;

  if (cappedOut) {
    await markChannelStale(db, guildId, channel.id, 'channel', 'cap');
  } else if (hasGap) {
    await markChannelStale(db, guildId, channel.id, 'channel', 'gap');
    await triggerTrackedReindex(channel);
  } else {
    await markChannelSynced(
      db,
      guildId,
      channel.id,
      'channel',
      newerId(newestId, sync.lastIndexedMessageId),
      count,
    );
  }
}

/**
 * Capture one thread that lives inside a tracked normal channel as a single KB
 * entry — its whole conversation — grouped under the parent channel's category.
 */
async function captureTrackedThread(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  const guildId = thread.guildId;
  const parent = thread.parent;
  if (
    !parent ||
    (parent.type !== ChannelType.GuildText && parent.type !== ChannelType.GuildAnnouncement)
  ) {
    return;
  }
  const cfg = await ensureGuildConfig(db, guildId);
  if (!cfg.trackedChannelIds.includes(parent.id)) return; // untracked during debounce

  const threadId = thread.id;
  const existing = await getThreadByDiscordId(db, guildId, threadId);
  // Stop indexing NEW content at the unified index cap (existing rows keep updating).
  if (!existing && (await atIndexCap(guildId))) return;

  // fetchTranscript also re-hosts any images posted in the thread.
  const transcript = await fetchTranscript(thread);
  const first = transcript[0];
  const title = thread.name?.trim() || segmentTitle(first?.content);

  const row = await upsertThread(db, {
    guildId,
    channelId: parent.id, // group under the parent channel, like the main-channel segments
    channelName: parent.name,
    kind: 'channel',
    threadId,
    title,
    questionBody: first?.content ?? '',
    opUserId: thread.ownerId ?? first?.authorId ?? null,
    status: 'open',
  });

  if (!row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
    await setPublished(db, guildId, threadId, true).catch(() => undefined);
    await enqueueRevalidateKb({ guildId, threadId, action: 'publish' }).catch(() => undefined);
  }

  if (transcript.length > 0) await setTranscript(db, row.id, transcript).catch(() => undefined);

  const msgCount = transcript.length;
  const dirty =
    row.embedContentHash !==
    embedContentHash({ title: row.title, questionBody: row.questionBody, transcript });
  if (!isReembedDue(msgCount, row.lastEmbedMsgCount, dirty)) return;
  let queued = false;
  try {
    await enqueueEmbedThread({
      threadRowId: row.id,
      guildId,
      modelId: cfg.embeddingModel,
      title: row.title,
      question: row.questionBody,
      answer: null,
    });
    queued = true;
  } catch (err) {
    log.warn({ err, threadId }, 'tracked thread embed enqueue failed');
  }
  if (queued) await setLastEmbedMsgCount(db, row.id, Math.max(msgCount, 1));
}
