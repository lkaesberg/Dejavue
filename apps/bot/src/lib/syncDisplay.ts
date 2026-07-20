import type { ChannelSync } from '@dejavue/db';

/** A live backfill (first-setup import) or reindex job overlaid on the status line. */
export interface LiveJobDisplay {
  processed: number;
  total: number;
  flavor: 'import' | 'rescan';
}

/** "5s" / "3m" / "2h" since a timestamp (now injectable for tests). */
export function sinceLabel(ms: number, now = Date.now()): string {
  const s = Math.max(1, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function staleReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'cap':
      return 'index full — upgrade or free space';
    case 'gap':
      return 'catching up on missed messages';
    case 'delete':
    case 'edit':
      return 'syncing recent changes';
    default:
      return 'needs a re-scan — `/dejavue rescan`';
  }
}

// Discord caps an embed field value at 1024 chars; with many channels the joined
// status lines can blow past it and discord.js throws, taking down the whole hub.
const FIELD_LIMIT = 1024;
const OVERFLOW_BUDGET = 48; // room reserved for the "…and N more" footer line

/**
 * Join per-channel status blocks with newlines, keeping the result within Discord's
 * embed-field limit. If they don't all fit, keep as many whole blocks as possible and
 * append "…and N more channels" so a large guild's hub renders instead of crashing.
 */
export function joinChannelLines(blocks: string[], limit = FIELD_LIMIT): string {
  const full = blocks.join('\n');
  if (full.length <= limit) return full;
  const kept: string[] = [];
  let len = 0;
  for (const block of blocks) {
    const add = (kept.length > 0 ? 1 : 0) + block.length;
    if (len + add > limit - OVERFLOW_BUDGET) break;
    kept.push(block);
    len += add;
  }
  kept.push(`…and ${blocks.length - kept.length} more channels`);
  return kept.join('\n');
}

/** The one-line freshness status shown per channel in the /dejavue setup hub. */
export function channelSyncDisplay(
  sync: ChannelSync | undefined,
  live: LiveJobDisplay | undefined,
  now = Date.now(),
): string {
  if (live) {
    const pct = live.total > 0 ? ` ${Math.round((live.processed / live.total) * 100)}%` : '';
    return live.flavor === 'import' ? `📥 importing history…${pct}` : `🔄 re-scanning…${pct}`;
  }
  if (!sync || sync.state === 'never') return '⚪ not indexed yet — run `/dejavue rescan`';
  if (sync.state === 'reindexing') return '🔄 re-scanning…';
  if (sync.state === 'stale') return `⚠️ ${staleReasonLabel(sync.staleReason)}`;
  const when = sync.lastReindexAt ? ` · scanned ${sinceLabel(sync.lastReindexAt.getTime(), now)} ago` : '';
  return `✅ up to date · ${sync.indexedMessageCount.toLocaleString()} msgs${when}`;
}
