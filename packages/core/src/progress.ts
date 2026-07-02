/**
 * Pure renderers for the single live-progress message that the worker continuously
 * edits (reindex, FAQ, clustering). Kept in core so the bot (initial paint) and the
 * worker (updates) produce identical copy without sharing app code. Each returns a
 * plain object the caller wraps in an EmbedBuilder (bot) or raw REST embed (worker).
 */

export interface ProgressEmbed {
  title: string;
  description: string;
  color: number;
}

const COLOR_PROGRESS = 0x5865f2; // blurple — working
const COLOR_DONE = 0x57f287; // green — finished
const COLOR_FAIL = 0xed4245; // red — failed

/** A compact filled/empty bar: renderProgressBar(3, 10) → "███░░░░░░░░░░ 30%". */
export function renderProgressBar(done: number, total: number, width = 12): string {
  if (!Number.isFinite(total) || total <= 0) {
    return done > 0 ? `${done.toLocaleString()} scanned` : 'starting…';
  }
  const pct = Math.min(1, done / total);
  const filled = Math.round(pct * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(pct * 100)}%`;
}

export type ReindexPhase = 'queued' | 'listing' | 'indexing' | 'pruning' | 'done' | 'failed';

export interface ReindexProgressState {
  channelLabel: string; // e.g. "#general" — caller formats the mention/name
  kind: 'forum' | 'tracked';
  phase: ReindexPhase;
  done?: number;
  total?: number;
  removed?: number;
  /** Entries not indexed because the index cap was hit. */
  skipped?: number;
  error?: string;
  /** Set on the auto-reindex (gap) path so the copy says why it kicked off. */
  auto?: boolean;
}

export function reindexProgressEmbed(s: ReindexProgressState): ProgressEmbed {
  const unit = s.kind === 'forum' ? 'posts' : 'segments';
  const head = s.auto ? `🔄 Catching up on ${s.channelLabel}` : `🔄 Re-scanning ${s.channelLabel}`;
  switch (s.phase) {
    case 'queued':
      return {
        title: head,
        description: 'Queued — starting shortly. This message updates automatically.',
        color: COLOR_PROGRESS,
      };
    case 'listing':
      return {
        title: head,
        description: `Scanning history… ${(s.done ?? 0).toLocaleString()} ${
          s.kind === 'forum' ? 'threads' : 'messages'
        } found.`,
        color: COLOR_PROGRESS,
      };
    case 'indexing':
      return {
        title: head,
        description: `Indexing ${unit}… ${renderProgressBar(s.done ?? 0, s.total ?? 0)}\n${(
          s.done ?? 0
        ).toLocaleString()} / ${(s.total ?? 0).toLocaleString()}`,
        color: COLOR_PROGRESS,
      };
    case 'pruning':
      return {
        title: head,
        description: 'Cleaning up deleted content…',
        color: COLOR_PROGRESS,
      };
    case 'done': {
      const parts = [`Indexed ${(s.done ?? 0).toLocaleString()} ${unit}.`];
      if (s.removed && s.removed > 0) parts.push(`Removed ${s.removed.toLocaleString()} deleted.`);
      if (s.skipped && s.skipped > 0) {
        parts.push(`⚠️ ${s.skipped.toLocaleString()} not indexed — index full (upgrade or free space).`);
      }
      parts.push('Up to date ✅');
      return { title: `✅ ${s.channelLabel} is up to date`, description: parts.join(' '), color: COLOR_DONE };
    }
    case 'failed':
      return {
        title: `⚠️ Re-scan of ${s.channelLabel} hit a snag`,
        description: `${s.error ?? 'Something went wrong.'}\nProgress is saved — run \`/dejavue rescan\` again to resume.`,
        color: COLOR_FAIL,
      };
  }
}

export type GenKind = 'faq' | 'cluster';
export type GenPhase = 'queued' | 'working' | 'done' | 'failed';

export interface GenProgressState {
  kind: GenKind;
  phase: GenPhase;
  /** Short note: progress while working, or a caveat on the final render. */
  note?: string;
  /** The final rendered list (markdown), shown when phase === 'done'. */
  body?: string;
  error?: string;
}

export function genProgressEmbed(s: GenProgressState): ProgressEmbed {
  const title = s.kind === 'faq' ? 'Auto-FAQ' : 'Knowledge gaps';
  switch (s.phase) {
    case 'queued':
      return {
        title,
        description: "Building this now — this message updates automatically.",
        color: COLOR_PROGRESS,
      };
    case 'working':
      return {
        title,
        description: `⏳ Working on it…${s.note ? ` ${s.note}` : ''}`,
        color: COLOR_PROGRESS,
      };
    case 'done':
      return {
        title,
        description: `${s.body && s.body.trim() ? s.body : '_Nothing to show yet._'}${
          s.note ? `\n\n⚠️ ${s.note}` : ''
        }\n\n_Updated just now._`,
        color: COLOR_DONE,
      };
    case 'failed':
      return {
        title,
        description: `⚠️ ${s.error ?? 'Generation failed.'} Try again in a moment.`,
        color: COLOR_FAIL,
      };
  }
}
