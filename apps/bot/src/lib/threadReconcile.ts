import {
  ChannelType,
  type Client,
  DiscordAPIError,
  type Guild,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  deleteThreadsByChannel,
  deleteThreadsByDiscordIds,
  getDb,
  getGuildConfig,
  listChannelIdsForGuild,
  listThreadIdsByChannel,
  listThreadLabelsByChannel,
  setChannelGuidelines,
  setThreadLabels,
  updateChannelName,
  updateGuildConfig,
} from '@dejavue/db';
import { ensureForumTags, forumParent, threadLabels } from './forum';
import { scheduleTrackedCapture } from './trackedChannel';

const sameLabels = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

const log = childLogger({ mod: 'thread-reconcile' });

const UNKNOWN_CHANNEL = 10003; // Discord API error: the channel/thread no longer exists
const MAX_THREAD_CHECKS = 5000; // per channel per run — bound API usage on huge forums

type Existence = 'exists' | 'missing' | 'transient';

/**
 * Does this channel / thread still exist on Discord? We fetch via the global
 * channel manager (which resolves threads too).
 *
 * CRITICAL SAFETY INVARIANT: only a definitive "Unknown Channel" (10003) maps to
 * 'missing'. Every other outcome — a null result, a permissions error (50001), a
 * rate limit (429), a network blip — maps to 'transient', and callers NEVER delete
 * on 'transient'. So no glitch can wipe the index; the worst case is a ghost
 * lingering until the next sweep.
 */
async function existence(guild: Guild, id: string): Promise<Existence> {
  try {
    const ch = await guild.client.channels.fetch(id);
    return ch ? 'exists' : 'transient'; // null should not happen for a bad id (it throws), but be safe
  } catch (err) {
    if (err instanceof DiscordAPIError && Number(err.code) === UNKNOWN_CHANNEL) return 'missing';
    return 'transient';
  }
}

async function reconcileGuild(guild: Guild): Promise<void> {
  const db = getDb();
  const cfg = await getGuildConfig(db, guild.id);
  if (!cfg) return;

  const tracked = new Set(cfg.forumChannelIds);
  // Check tracked channels AND any channel we still have threads for — catches a
  // channel that was deleted and already dropped from config (delete-and-recreate).
  const candidates = new Set<string>([
    ...cfg.forumChannelIds,
    ...cfg.trackedChannelIds,
    ...(await listChannelIdsForGuild(db, guild.id)),
  ]);

  const trackedNormal = new Set(cfg.trackedChannelIds);
  let configChanged = false;
  let forumChannelIds = [...cfg.forumChannelIds];
  let trackedChannelIds = [...cfg.trackedChannelIds];
  const channelModes = { ...(cfg.channelModes ?? {}) };

  for (const channelId of candidates) {
    const state = await existence(guild, channelId);
    if (state === 'transient') continue; // uncertain → leave everything as-is

    if (state === 'missing') {
      const removed = await deleteThreadsByChannel(db, guild.id, channelId);
      if (tracked.has(channelId)) {
        forumChannelIds = forumChannelIds.filter((id) => id !== channelId);
        delete channelModes[channelId];
        configChanged = true;
      }
      if (trackedNormal.has(channelId)) {
        trackedChannelIds = trackedChannelIds.filter((id) => id !== channelId);
        configChanged = true;
      }
      if (removed > 0 || tracked.has(channelId) || trackedNormal.has(channelId)) {
        log.info({ guildId: guild.id, channelId, removed }, 'reconcile: purged deleted channel');
      }
      continue;
    }

    // Channel exists. Only prune threads for channels we actively monitor; an
    // existing-but-untracked channel keeps its archived answers (untrack semantics).
    if (!tracked.has(channelId)) {
      // Tracked normal (text/announcement) channel: heal its name + description so
      // the KB reflects an offline rename. No tags or per-thread checks here.
      if (trackedNormal.has(channelId)) {
        try {
          const ch = await guild.channels.fetch(channelId);
          if (
            ch &&
            (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
          ) {
            await updateChannelName(db, guild.id, channelId, ch.name);
            await setChannelGuidelines(db, guild.id, channelId, ch.topic ?? null);
            // Re-capture so edits/deletes that happened while offline drop out of the
            // index (rebuilds transcripts from live Discord; gap detection handles
            // deeper history by kicking a reindex). Debounced + idempotent-per-channel.
            scheduleTrackedCapture(ch as TextChannel | NewsChannel);
          }
        } catch {
          /* best effort */
        }
      }
      continue;
    }

    // Keep tags, the channel name, and post-guidelines current on tracked forums
    // (heals renames / guideline edits that happened while we were offline).
    try {
      const ch = await guild.channels.fetch(channelId);
      if (ch?.type === ChannelType.GuildForum) {
        await ensureForumTags(ch);
        await updateChannelName(db, guild.id, channelId, ch.name);
        await setChannelGuidelines(db, guild.id, channelId, ch.topic ?? null);
      }
    } catch {
      /* needs Manage Channels; best effort */
    }

    // Verify each indexed thread individually — a thread is deleted ONLY on its
    // own 10003, so a partial/failed listing can never mass-prune a live channel.
    // We fetch each thread once and reuse that fetch to also heal custom labels
    // (forum tags) edited while the bot was offline.
    const dbIds = await listThreadIdsByChannel(db, guild.id, channelId);
    const storedLabels = new Map(
      (await listThreadLabelsByChannel(db, guild.id, channelId)).map((r) => [r.threadId, r.labels]),
    );
    const stale: string[] = [];
    let checked = 0;
    for (const threadId of dbIds) {
      if (checked >= MAX_THREAD_CHECKS) {
        log.warn({ guildId: guild.id, channelId, dbIds: dbIds.length }, 'thread-check cap hit; rest next run');
        break;
      }
      checked++;
      let ch;
      try {
        ch = await guild.client.channels.fetch(threadId);
      } catch (err) {
        // Delete ONLY on a definitive Unknown Channel; every other error is transient.
        if (err instanceof DiscordAPIError && Number(err.code) === UNKNOWN_CHANNEL) stale.push(threadId);
        continue;
      }
      if (!ch || !ch.isThread()) continue;
      // Heal labels — only when the forum parent resolves, so a missing parent can't
      // wrongly clear a thread's labels to empty.
      if (forumParent(ch)) {
        const after = threadLabels(ch);
        if (!sameLabels(storedLabels.get(threadId) ?? [], after)) {
          await setThreadLabels(db, guild.id, threadId, after).catch(() => undefined);
        }
      }
    }
    if (stale.length > 0) {
      const removed = await deleteThreadsByDiscordIds(db, guild.id, stale);
      log.info({ guildId: guild.id, channelId, removed }, 'reconcile: purged deleted threads');
    }
  }

  if (configChanged) {
    await updateGuildConfig(db, guild.id, { forumChannelIds, trackedChannelIds, channelModes });
  }
}

/**
 * Reconcile the index with Discord reality across every guild — purging threads
 * and channels deleted in Discord (including while the bot was offline). Safe to
 * run repeatedly; only ever deletes on a definitive 10003 for that exact id.
 */
export async function reconcileDeletions(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await reconcileGuild(guild);
    } catch (err) {
      log.warn({ err, guildId: guild.id }, 'deletion reconcile failed for guild');
    }
  }
}
