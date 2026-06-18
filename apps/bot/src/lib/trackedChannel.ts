import type { NewsChannel, TextChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  countTracked,
  ensureGuildConfig,
  getDb,
  getThreadByDiscordId,
  setLastEmbedMsgCount,
  setPublished,
  setTranscript,
  type TranscriptMessage,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { isReembedDue } from './knowledge';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'tracked' });

/**
 * Tracking a *normal* (non-forum) channel as a searchable KB. Unlike forum posts
 * there's no thread per topic, so we split the channel's recent messages into
 * conversation segments (a >20-minute silence starts a new one) and index each
 * segment as its own KB entry, keyed by the id of its first message. Segments
 * re-embed on the same growth backoff as knowledge threads, and count against a
 * tracked-docs quota that is separate from the forum archive.
 */
const DEBOUNCE_MS = 5000;
const SEGMENT_GAP_MS = 20 * 60 * 1000;
const MIN_SEGMENT_MSGS = 2; // skip one-off chatter
const FETCH_LIMIT = 100;

type TrackedChannel = TextChannel | NewsChannel;

interface SegMsg extends TranscriptMessage {
  messageId: string;
}

const scheduled = new Set<string>();

/** Debounced, idempotent-per-channel capture (collapses message bursts to one run). */
export function scheduleTrackedCapture(channel: TrackedChannel): void {
  if (scheduled.has(channel.id)) return;
  scheduled.add(channel.id);
  const timer = setTimeout(() => {
    void captureTrackedChannel(channel)
      .catch((err) => log.warn({ err, channelId: channel.id }, 'tracked capture failed'))
      .finally(() => scheduled.delete(channel.id));
  }, DEBOUNCE_MS);
  timer.unref();
}

async function fetchRecent(channel: TrackedChannel): Promise<SegMsg[]> {
  const out: SegMsg[] = [];
  try {
    const batch = await channel.messages.fetch({ limit: FETCH_LIMIT });
    for (const m of batch.values()) {
      if (m.author?.bot) continue;
      const content = m.content?.trim();
      if (!content) continue;
      out.push({
        messageId: m.id,
        authorId: m.author.id,
        content,
        createdAt: new Date(m.createdTimestamp).toISOString(),
      });
    }
  } catch {
    /* best effort */
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

function segmentByGap(msgs: SegMsg[]): SegMsg[][] {
  const segments: SegMsg[][] = [];
  let current: SegMsg[] = [];
  let lastTs = 0;
  for (const m of msgs) {
    const ts = Date.parse(m.createdAt);
    if (current.length && ts - lastTs > SEGMENT_GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(m);
    lastTs = ts;
  }
  if (current.length) segments.push(current);
  return segments;
}

function titleOf(seg: SegMsg[]): string {
  const first = (seg[0]?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return 'Conversation';
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

const stripIds = (seg: SegMsg[]): TranscriptMessage[] =>
  seg.map(({ authorId, content, createdAt }) => ({ authorId, content, createdAt }));

async function captureTrackedChannel(channel: TrackedChannel): Promise<void> {
  const db = getDb();
  const guildId = channel.guildId;
  const cfg = await ensureGuildConfig(db, guildId);
  // The channel may have been untracked during the debounce window.
  if (!cfg.trackedChannelIds.includes(channel.id)) return;
  const limits = limitsFor(await getGuildTier(guildId));

  const segments = segmentByGap(await fetchRecent(channel)).filter((s) => s.length >= MIN_SEGMENT_MSGS);
  if (segments.length === 0) return;

  for (const seg of segments) {
    const first = seg[0];
    if (!first) continue;
    const threadId = first.messageId;
    const existing = await getThreadByDiscordId(db, guildId, threadId);

    // Quota: only the *creation* of new segments is capped (existing rows keep updating).
    if (
      !existing &&
      Number.isFinite(limits.trackedDocCap) &&
      (await countTracked(db, guildId)) >= limits.trackedDocCap
    ) {
      continue;
    }

    const row = await upsertThread(db, {
      guildId,
      channelId: channel.id,
      channelName: channel.name,
      kind: 'channel',
      threadId,
      title: titleOf(seg),
      questionBody: first.content,
      opUserId: first.authorId,
      status: 'open',
    });

    // Publish to the public KB (opt-in). The tracked quota is enforced at creation above.
    if (cfg.kbPublishOptIn && !row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
      await setPublished(db, guildId, threadId, true).catch(() => undefined);
      await enqueueRevalidateKb({ guildId, threadId, action: 'publish' }).catch(() => undefined);
    }

    // The KB page must always show every message: re-capture the segment each run.
    await setTranscript(db, row.id, stripIds(seg)).catch(() => undefined);

    // Re-index for search on the quadrupling backoff (frequent while the segment is
    // small, rare once it's large and the topic has settled).
    if (!isReembedDue(seg.length, row.lastEmbedMsgCount)) continue;
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
}
