import {
  ChannelType,
  type Message,
  type NewsChannel,
  type PartialMessage,
  type ReadonlyCollection,
  type Snowflake,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  deleteThreadByDiscordId,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  markChannelStale,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import { forumParent } from '../lib/forum';
import { scheduleKnowledgeArchive } from '../lib/knowledge';
import { scheduleQuestionArchive } from '../lib/solve';
import { monitoredForum } from '../lib/tier';
import { scheduleTrackedCapture, scheduleTrackedThread } from '../lib/trackedChannel';

const log = childLogger({ mod: 'event:messageMutations' });

type AnyChannel = Message['channel'];

/**
 * If a deleted message was a tracked segment's head (segments are keyed by their first
 * message id), its row is now orphaned — drop it. The follow-up capture recreates the
 * segment under its new first message. Thread/forum ids never collide with parent-channel
 * message ids, so this match is exact and can't touch a thread-inside or forum row.
 */
async function dropOrphanSegment(guildId: string, messageId: string): Promise<void> {
  const db = getDb();
  const existing = await getThreadByDiscordId(db, guildId, messageId);
  if (existing && existing.kind === 'channel') {
    await deleteThreadByDiscordId(db, guildId, messageId);
    await enqueueRevalidateKb({ guildId, threadId: messageId, action: 'unpublish' }).catch(
      () => undefined,
    );
  }
}

/**
 * A message in a monitored channel was edited or deleted. Re-capture so the change
 * propagates: the transcript is rebuilt from live Discord (deleted/edited text drops
 * in/out) and the embedding is refreshed (the content-hash dirty check fires). Marking
 * the channel stale surfaces it in the /dejavue setup hub until the debounced capture lands.
 */
async function recapture(channel: AnyChannel | null | undefined, reason: string): Promise<void> {
  if (!channel || !('guildId' in channel) || !channel.guildId) return;
  const guildId = channel.guildId;
  const db = getDb();

  // Tracked normal (text/announcement) channel.
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg?.trackedChannelIds?.includes(channel.id)) return;
    await markChannelStale(db, guildId, channel.id, 'channel', reason).catch(() => undefined);
    scheduleTrackedCapture(channel as TextChannel | NewsChannel);
    return;
  }

  if (!channel.isThread()) return;
  const thread = channel as ThreadChannel;

  // Thread inside a tracked normal channel.
  const parent = thread.parent;
  if (
    parent &&
    (parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildAnnouncement)
  ) {
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg?.trackedChannelIds?.includes(parent.id)) return;
    await markChannelStale(db, guildId, parent.id, 'channel', reason).catch(() => undefined);
    scheduleTrackedThread(thread);
    return;
  }

  // Forum thread (knowledge or question).
  const forum = forumParent(thread);
  if (!forum) return;
  const cfg = await getGuildConfig(db, guildId);
  if (!(await monitoredForum(guildId, cfg, forum.id))) return;
  if (channelMode(cfg, forum.id) === 'knowledge') {
    await markChannelStale(db, guildId, forum.id, 'forum', reason).catch(() => undefined);
    scheduleKnowledgeArchive(thread);
  } else {
    // Question thread: capture refreshes the transcript and re-embeds if solved+changed.
    scheduleQuestionArchive(thread);
  }
}

export async function onMessageUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
): Promise<void> {
  try {
    if (newMessage.author?.bot) return;
    // Ignore edits that didn't touch content (pins, embeds, reactions). When the old
    // message is a partial we can't compare, so we conservatively re-capture.
    if (oldMessage.content != null && oldMessage.content === newMessage.content) return;
    await recapture(newMessage.channel, 'edit');
  } catch (err) {
    log.warn({ err, id: newMessage.id }, 'messageUpdate handling failed');
  }
}

export async function onMessageDelete(message: Message | PartialMessage): Promise<void> {
  try {
    const guildId = message.guildId ?? (message.channel as { guildId?: string })?.guildId;
    if (guildId) await dropOrphanSegment(guildId, message.id);
    await recapture(message.channel, 'delete');
  } catch (err) {
    log.warn({ err, id: message.id }, 'messageDelete handling failed');
  }
}

export async function onMessageDeleteBulk(
  messages: ReadonlyCollection<Snowflake, Message | PartialMessage>,
  channel: AnyChannel,
): Promise<void> {
  try {
    const guildId = (channel as { guildId?: string })?.guildId;
    if (guildId) {
      for (const id of messages.keys()) await dropOrphanSegment(guildId, id);
    }
    await recapture(channel, 'delete');
  } catch (err) {
    log.warn({ err }, 'messageDeleteBulk handling failed');
  }
}
