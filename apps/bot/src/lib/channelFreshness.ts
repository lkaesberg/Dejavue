import {
  countIndexedMessagesInChannel,
  ensureChannelSync,
  getActiveBackfillJob,
  getDb,
  markChannelSynced,
} from '@dejavue/db';

/**
 * Re-confirm a forum's freshness after a live capture. When nothing else owns the
 * channel state (no reindex, no first-setup import in flight), the newest message has
 * been folded in on top of already-indexed history — flip the /dejavue setup hub back
 * to "✅ up to date". Watermark stays null: forum watermarks only advance on full
 * scans (markChannelSynced keeps the existing one when null).
 */
export async function refreshForumFreshness(guildId: string, forumId: string): Promise<void> {
  const db = getDb();
  const sync = await ensureChannelSync(db, guildId, forumId, 'forum');
  if (sync.state === 'reindexing') return; // the reindex owns the final state
  // Don't paper over an "index full" warning — capturing one more message doesn't
  // free space; it persists until a rescan or upgrade resolves it.
  if (sync.state === 'stale' && sync.staleReason === 'cap') return;
  if (await getActiveBackfillJob(db, guildId, forumId)) return; // the import owns it
  const count = await countIndexedMessagesInChannel(db, guildId, forumId);
  await markChannelSynced(db, guildId, forumId, 'forum', null, count);
}
