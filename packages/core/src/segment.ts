/**
 * Conversation segmentation for tracked normal channels. A normal channel has no
 * thread-per-topic, so we split its messages into segments on a silence gap and index
 * each as its own KB entry. These helpers are pure so the bot (live capture) and the
 * worker (full reindex) segment identically.
 */

/** A >20-minute silence starts a new conversation segment. */
export const SEGMENT_GAP_MS = 20 * 60 * 1000;
/**
 * Minimum messages for a segment to be indexed. 1: a standalone message IS the
 * conversation in sparse/announcement channels. (This was 2 to skip one-off
 * chatter, but it made sparse tracked channels index NOTHING at setup/rescan —
 * content only appeared once a second message landed within the gap window,
 * which read as "old messages never import".)
 */
export const MIN_SEGMENT_MSGS = 1;

/** Split chronologically-sorted messages into segments on a silence gap. */
export function segmentByGap<T extends { createdAt: string }>(
  msgs: T[],
  gapMs = SEGMENT_GAP_MS,
): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  let lastTs = 0;
  for (const m of msgs) {
    const ts = Date.parse(m.createdAt);
    if (current.length && ts - lastTs > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(m);
    lastTs = ts;
  }
  if (current.length) segments.push(current);
  return segments;
}

/** A short title for a segment, derived from its first message's content. */
export function segmentTitle(firstContent: string | undefined): string {
  const first = (firstContent ?? '').replace(/\s+/g, ' ').trim();
  if (!first) return 'Conversation';
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}
