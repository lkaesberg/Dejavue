/** All background queue names. Created on startup; producers + consumers share these. */
export const QUEUES = {
  /** Embed a solved thread's text into a vector (passage). Heavy → worker only. */
  EMBED_THREAD: 'embed-thread',
  /** Summarize a solved thread into a canonical KB answer (Pro, quota-metered). */
  SUMMARIZE_THREAD: 'summarize-thread',
  /** Ping helpers about stale unanswered posts (Plus). */
  NUDGE_STALE: 'nudge-stale',
  /** Cluster recurring unanswered questions into knowledge gaps (Pro). */
  CLUSTER_GAPS: 'cluster-gaps',
  /** Regenerate / maintain the auto-FAQ (Pro). */
  REGEN_FAQ: 'regen-faq',
  /** Reconcile entitlements against Discord's LIST endpoint. */
  RECONCILE_ENTITLEMENTS: 'reconcile-entitlements',
  /** Import a server's existing forum history (durable OTP). */
  BACKFILL_FORUM: 'backfill-forum',
  /** Revalidate a public KB page after solve / edit / unsolve / delete. */
  REVALIDATE_KB: 'revalidate-kb',
  /** Download + re-host message attachments while the Discord CDN url is still fresh. */
  INGEST_ATTACHMENT: 'ingest-attachment',
  /** Full rescan of a channel: re-embed everything + prune deleted content (durable). */
  REINDEX_CHANNEL: 'reindex-channel',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EmbedThreadJob {
  threadRowId: string;
  guildId: string;
  modelId: string;
  title: string;
  question: string;
  answer?: string | null;
}

export interface SummarizeThreadJob {
  threadRowId: string;
  guildId: string;
  question: string;
  answer: string;
}

export interface NudgeStaleJob {
  /** Omitted for the scheduled sweep (all nudge-enabled guilds). */
  guildId?: string;
}

/** Points at the one live message a worker continuously edits with progress. */
export interface ProgressTarget {
  channelId: string;
  messageId: string;
}

export interface ClusterGapsJob {
  guildId: string;
  /** When set, the worker renders progress + the final list into this message. */
  progress?: ProgressTarget;
}

export interface RegenFaqJob {
  guildId: string;
  progress?: ProgressTarget;
}

/** All mutable state lives in the reindex_job row; the payload just points at it. */
export interface ReindexChannelJob {
  reindexJobId: string;
}

export interface BackfillForumJob {
  backfillJobId: string;
}

export interface RevalidateKbJob {
  guildId: string;
  threadId: string;
  action: 'publish' | 'unpublish';
}

/** One attachment to re-host (the Discord url is fresh at enqueue time). */
export interface IngestAttachmentItem {
  id: string;
  url: string;
  name: string;
  contentType?: string | null;
  size?: number | null;
}

export interface IngestAttachmentJob {
  guildId: string;
  items: IngestAttachmentItem[];
}
