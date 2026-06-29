import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/** Postgres bytea ⇄ Node Buffer, for re-hosted attachment bytes. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Embedding dimensionality. Both supported CPU models (bge-small-en-v1.5 and
 * multilingual-e5-small) are 384-dim, so model swaps never touch the schema.
 * Changing this is a destructive migration (reindex + re-embed).
 */
export const EMBEDDING_DIM = 384;

/** An attachment reference stored on a transcript message. */
export interface TranscriptAttachment {
  /** Discord attachment id — for images, also the key into the `attachment` table (/a/<id>). */
  id: string;
  name: string;
  /** image → re-hosted (served from /a/<id>); video/file → linked out to `url`. */
  kind: 'image' | 'video' | 'file';
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
  /** Discord CDN url, kept only for video/file chips that link out (images use /a/<id>). */
  url?: string;
}

/** One human message in a thread's archived transcript (bot messages excluded). */
export interface TranscriptMessage {
  /** Discord message id — lets the KB mark the accepted-answer message in the log. */
  id?: string;
  authorId: string;
  content: string;
  createdAt: string;
  /** Images/files posted with the message, re-hosted and served from /a/<id>. */
  attachments?: TranscriptAttachment[];
  /** Total reaction count — high-reaction messages are prioritized for embedding. */
  reactions?: number;
}

/** Public KB appearance, set by the admin via `/dejavue customize` (Plus+). */
export type KbTheme = 'light' | 'dark';
export type KbAccent = 'indigo' | 'blue' | 'teal' | 'violet' | 'amber';
export type KbCorners = 'rounded' | 'sharp';
export type KbHeadingFont = 'grotesk' | 'sans' | 'serif';

/** Off-topic guard sensitivity → how readily a post is judged wrong-channel. */
export type GuardSensitivity = 'low' | 'medium' | 'high';

/** Imprint fields rendered on the public KB's legal page. */
export interface KbImprint {
  operator?: string;
  contact?: string;
  representedBy?: string;
  responsible?: string;
}

/** Whether a thread came from a forum post or a tracked normal channel (separate quotas). */
export type ThreadKind = 'forum' | 'channel';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const threadStatus = pgEnum('thread_status', ['open', 'solved', 'unsolved']);
export const embeddingSource = pgEnum('embedding_source', ['question', 'answer', 'summary']);
export const entitlementType = pgEnum('entitlement_type', [
  'guild_subscription',
  'user_subscription',
  'durable',
  'consumable',
  'unknown',
]);
export const generationFeature = pgEnum('generation_feature', [
  'draft',
  'summary',
  'faq',
  'cluster_label',
]);
export const backfillStatus = pgEnum('backfill_status', [
  'pending',
  'running',
  'completed',
  'failed',
]);
export const clusterStatus = pgEnum('cluster_status', ['open', 'resolved', 'dismissed']);
// Per-channel index freshness. 'never' = not yet indexed; 'synced' = up to date;
// 'stale' = known to be behind reality (a gap/edit/delete/cap); 'reindexing' = a
// full rescan is in flight.
export const channelSyncState = pgEnum('channel_sync_state', [
  'never',
  'synced',
  'stale',
  'reindexing',
]);

const emptyTextArray = sql`'{}'::text[]`;

// ---------------------------------------------------------------------------
// Per-guild configuration
// ---------------------------------------------------------------------------
export const guildConfig = pgTable('guild_config', {
  guildId: text('guild_id').primaryKey(),
  forumChannelIds: text('forum_channel_ids').array().notNull().default(emptyTextArray),
  // Per-channel mode: a sparse map of forum channel id -> 'knowledge'. Absent
  // means 'question' (the classic Q&A workflow). 'knowledge' channels are pure
  // archive: every thread is published, with no answer-prompting or dedup.
  channelModes: jsonb('channel_modes')
    .$type<Record<string, 'knowledge' | 'question'>>()
    .notNull()
    .default({}),
  // Forum "post guidelines" (the channel topic) per channel id, kept in sync with
  // Discord and shown beneath the channel name on the public KB.
  channelGuidelines: jsonb('channel_guidelines')
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  // Per-guild generative run state (epoch ms), keyed by feature ('cluster' | 'faq').
  // Lets commands dedupe in-flight runs and show "still working" + freshness.
  genRuns: jsonb('gen_runs')
    .$type<Record<string, { started?: number; finished?: number }>>()
    .notNull()
    .default({}),
  // Last tier we acted on — a change-detection marker for auto-backfill on upgrade.
  // NOT a source of truth: gating always derives the tier from entitlement rows.
  lastTier: text('last_tier'),
  // Per-guild forum tag snowflakes — never hardcoded constants.
  solvedTagId: text('solved_tag_id'),
  unsolvedTagId: text('unsolved_tag_id'),
  embeddingModel: text('embedding_model').notNull().default('bge-small-en-v1.5'),
  // Stale-question nudges (Plus+)
  nudgeEnabled: boolean('nudge_enabled').notNull().default(false),
  nudgeAfterHours: integer('nudge_after_hours').notNull().default(24),
  nudgeHelperRoleId: text('nudge_helper_role_id'),
  // Public web KB — on by default; set a slug in /dejavue customize to go live, or turn
  // it off / add a passphrase there. Everything indexed is auto-published within it.
  kbPublishOptIn: boolean('kb_publish_opt_in').notNull().default(true),
  kbSlug: text('kb_slug').unique(),
  // Custom domain for the public KB (one-time purchase). e.g. help.acme.com
  customDomain: text('custom_domain').unique(),
  // "powered by Dejavue" branding (forced on for Free tier regardless of this flag)
  brandingEnabled: boolean('branding_enabled').notNull().default(true),
  // Channel-fit check (Plus+): embed each monitored channel's name + description and,
  // when a new question is posted, suggest a better-fitting channel if one scores
  // notably higher. See the channel_topic table for the stored topic vectors.
  channelFitCheck: boolean('channel_fit_check').notNull().default(false),
  // ---- Off-topic guard (Plus+): the channel-fit check, escalated. When a post is
  // clearly off-topic it's warned about; with auto-close on, it's tagged
  // "wrong-channel" and the thread is closed. Sensitivity tunes the confidence bar.
  guardEnabled: boolean('guard_enabled').notNull().default(false),
  guardAutoClose: boolean('guard_auto_close').notNull().default(false),
  guardSensitivity: text('guard_sensitivity').$type<GuardSensitivity>().notNull().default('medium'),
  wrongChannelTagId: text('wrong_channel_tag_id'),
  // How readily a new post is suggested as a duplicate of an existing one (semantic
  // dedup, Plus+). Maps to a cosine-similarity bar — see apps/bot/src/lib/dedup.ts.
  dedupSensitivity: text('dedup_sensitivity').$type<GuardSensitivity>().notNull().default('medium'),
  // When a question is solved, delete the bot's control/prompt message (declutter)
  // instead of editing it into a "solved" notice. Default on.
  removeSolvedPrompt: boolean('remove_solved_prompt').notNull().default(true),
  // ---- Tracked normal (non-forum) channels: indexed as searchable KB content with
  // a quota separate from the forum archive. A flat list of text/announcement channel ids.
  trackedChannelIds: text('tracked_channel_ids').array().notNull().default(emptyTextArray),
  // ---- Public KB customization (`/dejavue customize`). Appearance is Plus+; brand /
  // slug / passphrase work on any tier.
  brandName: text('brand_name'),
  kbTheme: text('kb_theme').$type<KbTheme>().notNull().default('light'),
  kbAccent: text('kb_accent').$type<KbAccent>().notNull().default('indigo'),
  kbCorners: text('kb_corners').$type<KbCorners>().notNull().default('rounded'),
  kbHeadingFont: text('kb_heading_font').$type<KbHeadingFont>().notNull().default('grotesk'),
  kbLogoUrl: text('kb_logo_url'),
  // A shared passphrase gate for a private KB (salted hash; null = public).
  kbPassphraseHash: text('kb_passphrase_hash'),
  kbImprint: jsonb('kb_imprint').$type<KbImprint>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Entitlements — a raw mirror of Discord entitlement objects.
// Tier is computed *over* these rows (see @dejavue/core deriveTier); never stored.
// ---------------------------------------------------------------------------
export const entitlement = pgTable(
  'entitlement',
  {
    id: text('id').primaryKey(), // Discord entitlement id
    skuId: text('sku_id').notNull(),
    guildId: text('guild_id'),
    userId: text('user_id'),
    type: entitlementType('type').notNull().default('unknown'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    deleted: boolean('deleted').notNull().default(false),
    consumed: boolean('consumed').notNull().default(false),
    raw: jsonb('raw'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('entitlement_guild_idx').on(t.guildId), index('entitlement_sku_idx').on(t.skuId)],
);

// ---------------------------------------------------------------------------
// Threads (archived forum posts)
// ---------------------------------------------------------------------------
export const thread = pgTable(
  'thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(), // parent forum channel (or tracked text channel)
    channelName: text('channel_name'), // denormalized for KB category grouping
    // 'forum' = a real forum post; 'channel' = a conversation segment captured from a
    // tracked normal channel. Counted against separate quotas.
    kind: text('kind').$type<ThreadKind>().notNull().default('forum'),
    // User/mod-applied forum tags (custom labels), excluding our managed
    // solved/unsolved/duplicate/wrong-channel tags. Shown on the KB and filterable.
    labels: text('labels').array().notNull().default(emptyTextArray),
    threadId: text('thread_id').notNull(), // discord thread id (== starter message id), or synthetic segment id
    // If set, this thread is a duplicate of another (canonical) thread — folded
    // under it in the KB rather than listed on its own.
    duplicateOfThreadId: text('duplicate_of_thread_id'),
    title: text('title').notNull(),
    questionBody: text('question_body').notNull().default(''),
    opUserId: text('op_user_id'),
    status: threadStatus('status').notNull().default('open'),
    acceptedAnswerMessageId: text('accepted_answer_message_id'),
    acceptedAnswerText: text('accepted_answer_text'),
    acceptedAnswerAuthorId: text('accepted_answer_author_id'),
    // Pro: AI-summarized canonical answer (raw answer is shown on Free/Plus KB pages).
    canonicalSummary: text('canonical_summary'),
    // Full human conversation, captured on solve, for the public KB page.
    transcript: jsonb('transcript').$type<TranscriptMessage[]>(),
    // Thread message count at the last (re-)embed of a knowledge thread. Knowledge
    // channels have no solve point, so they re-embed on a doubling schedule keyed
    // off this — frequent early, then exponentially rarer as the topic settles.
    lastEmbedMsgCount: integer('last_embed_msg_count'),
    // Hash of the embed-source text (buildEmbeddingText output) at the last successful
    // embed. When the recomputed hash differs (edit/delete/answer change), the vector is
    // stale and a re-embed is forced regardless of the count backoff. NULL = never embedded
    // (treated as dirty).
    embedContentHash: text('embed_content_hash'),
    publishedToKb: boolean('published_to_kb').notNull().default(false),
    doNotPublish: boolean('do_not_publish').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    solvedAt: timestamp('solved_at', { withTimezone: true }),
    lastNudgedAt: timestamp('last_nudged_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('thread_guild_thread_idx').on(t.guildId, t.threadId),
    index('thread_guild_status_idx').on(t.guildId, t.status),
    index('thread_guild_published_idx').on(t.guildId, t.publishedToKb),
    index('thread_guild_kind_idx').on(t.guildId, t.kind),
  ],
);

// ---------------------------------------------------------------------------
// Embeddings — carry their producing model so swaps/upgrades are non-destructive.
// The HNSW index is created in a hand-written migration (drizzle-kit #5792).
// ---------------------------------------------------------------------------
export const embedding = pgTable(
  'embedding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    guildId: text('guild_id').notNull(),
    source: embeddingSource('source').notNull().default('question'),
    modelId: text('model_id').notNull(),
    embeddingVersion: integer('embedding_version').notNull().default(1),
    vec: vector('vec', { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('embedding_thread_source_ver_idx').on(t.threadId, t.source, t.embeddingVersion),
    index('embedding_guild_idx').on(t.guildId),
  ],
);

// ---------------------------------------------------------------------------
// Channel topic embeddings — one per monitored channel, built from its name +
// description. Used (Plus+, opt-in) to score how well a new question fits the
// channel it landed in. Only a handful of rows per guild, so no HNSW index — a
// sequential scan with the cosine operator is plenty.
// ---------------------------------------------------------------------------
export const channelTopic = pgTable(
  'channel_topic',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    modelId: text('model_id').notNull(),
    // The source text the vector was built from (name + description) — provenance.
    text: text('text').notNull(),
    vec: vector('vec', { dimensions: EMBEDDING_DIM }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_topic_guild_channel_model_idx').on(t.guildId, t.channelId, t.modelId),
    index('channel_topic_guild_idx').on(t.guildId),
  ],
);

// ---------------------------------------------------------------------------
// Per-channel index freshness — one row per monitored forum / tracked normal
// channel. Powers "is this up to date?" in /dejavue status, gap detection, and the
// once-per-hour auto-reindex throttle. The watermark (lastIndexedMessageId) is the
// newest Discord message id we've folded in; snowflakes are monotonic so freshness
// is a BigInt compare.
// ---------------------------------------------------------------------------
export const channelSync = pgTable(
  'channel_sync',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    kind: text('kind').$type<ThreadKind>().notNull(),
    state: channelSyncState('state').notNull().default('never'),
    lastIndexedMessageId: text('last_indexed_message_id'),
    // Cached sum of this channel's indexed transcript message counts (feeds status +
    // the unified index cap without scanning every transcript on hot paths).
    indexedMessageCount: integer('indexed_message_count').notNull().default(0),
    lastReindexAt: timestamp('last_reindex_at', { withTimezone: true }),
    // Newest message id the last reindex run actually covered (proves "up to date").
    lastReindexThrough: text('last_reindex_through'),
    // 'gap' | 'edit' | 'delete' | 'cap' — why we last marked it stale.
    staleReason: text('stale_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_sync_guild_channel_idx').on(t.guildId, t.channelId),
    index('channel_sync_guild_idx').on(t.guildId),
  ],
);

// ---------------------------------------------------------------------------
// Generation quota ledger (Pro). Usage = aggregate over the current window.
// Never store a mutable "remaining" counter.
// ---------------------------------------------------------------------------
export const generationEvent = pgTable(
  'generation_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    feature: generationFeature('feature').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    success: boolean('success').notNull().default(true),
    topUpCreditsConsumed: integer('top_up_credits_consumed').notNull().default(0),
    threadId: uuid('thread_id').references(() => thread.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('genevent_guild_created_idx').on(t.guildId, t.createdAt)],
);

/** Consumable top-up grants (extra generations), modeled as ledger credits. */
export const topUpGrant = pgTable(
  'top_up_grant',
  {
    id: text('id').primaryKey(), // entitlement id of the consumable
    guildId: text('guild_id').notNull(),
    credits: integer('credits').notNull(),
    creditsRemaining: integer('credits_remaining').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('topup_guild_idx').on(t.guildId)],
);

// ---------------------------------------------------------------------------
// Knowledge-gap clusters (Pro)
// ---------------------------------------------------------------------------
export const knowledgeGapCluster = pgTable(
  'knowledge_gap_cluster',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    label: text('label'),
    representativeText: text('representative_text'),
    medoidThreadId: uuid('medoid_thread_id').references(() => thread.id, { onDelete: 'set null' }),
    memberThreadIds: text('member_thread_ids').array().notNull().default(emptyTextArray),
    size: integer('size').notNull().default(0),
    status: clusterStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cluster_guild_status_idx').on(t.guildId, t.status)],
);

// ---------------------------------------------------------------------------
// Auto-FAQ entries (Pro)
// ---------------------------------------------------------------------------
export const faqEntry = pgTable(
  'faq_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sourceThreadIds: text('source_thread_ids').array().notNull().default(emptyTextArray),
    clusterId: uuid('cluster_id').references(() => knowledgeGapCluster.id, { onDelete: 'set null' }),
    published: boolean('published').notNull().default(true),
    // A human edit sets this so the next auto-regen won't clobber it.
    manualOverride: boolean('manual_override').notNull().default(false),
    lastRegeneratedAt: timestamp('last_regenerated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('faq_guild_idx').on(t.guildId)],
);

// ---------------------------------------------------------------------------
// Backfill jobs (durable one-time purchase)
// ---------------------------------------------------------------------------
export const backfillJob = pgTable(
  'backfill_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    entitlementId: text('entitlement_id'),
    status: backfillStatus('status').notNull().default('pending'),
    cursor: text('cursor'), // last archived-thread pagination cursor
    processedThreadIds: text('processed_thread_ids').array().notNull().default(emptyTextArray),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    statusMessageId: text('status_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('backfill_guild_status_idx').on(t.guildId, t.status)],
);

// ---------------------------------------------------------------------------
// Reindex jobs — a durable, resumable full rescan of a channel that (unlike
// backfill, which only imports) also RE-EMBEDS everything and PRUNES content
// Discord no longer returns. Triggered by /dejavue reindex and by auto gap
// detection. statusChannelId/statusMessageId point at the one live progress
// message the worker continuously edits.
// ---------------------------------------------------------------------------
export const reindexJob = pgTable(
  'reindex_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    // 'forum' = a monitored forum channel; 'tracked' = a tracked normal text channel.
    kind: text('kind').$type<'forum' | 'tracked'>().notNull(),
    status: backfillStatus('status').notNull().default('pending'),
    // Prune is only safe after the full listing completes, so the phase is tracked.
    phase: text('phase')
      .$type<'listing' | 'indexing' | 'pruning' | 'done'>()
      .notNull()
      .default('listing'),
    cursor: text('cursor'), // archived-thread (forum) or message (tracked) pagination cursor
    processedThreadIds: text('processed_thread_ids').array().notNull().default(emptyTextArray),
    total: integer('total').notNull().default(0),
    processed: integer('processed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    removed: integer('removed').notNull().default(0),
    statusChannelId: text('status_channel_id'),
    statusMessageId: text('status_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reindex_guild_status_idx').on(t.guildId, t.status),
    index('reindex_guild_channel_idx').on(t.guildId, t.channelId),
  ],
);

// ---------------------------------------------------------------------------
// Re-hosted attachments — bytes for images/files posted in tracked threads, so the
// public KB keeps showing them after Discord's signed CDN URLs expire. Keyed by the
// Discord attachment id; scoped by guild so the serve route never crosses tenants.
// ---------------------------------------------------------------------------
export const attachment = pgTable(
  'attachment',
  {
    id: text('id').primaryKey(), // Discord attachment id
    guildId: text('guild_id').notNull(),
    name: text('name').notNull(),
    contentType: text('content_type'),
    size: integer('size'),
    data: bytea('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachment_guild_idx').on(t.guildId)],
);

export type GuildConfig = typeof guildConfig.$inferSelect;
export type NewGuildConfig = typeof guildConfig.$inferInsert;
export type Entitlement = typeof entitlement.$inferSelect;
export type NewEntitlement = typeof entitlement.$inferInsert;
export type Thread = typeof thread.$inferSelect;
export type NewThread = typeof thread.$inferInsert;
export type Embedding = typeof embedding.$inferSelect;
export type NewEmbedding = typeof embedding.$inferInsert;
export type ChannelTopic = typeof channelTopic.$inferSelect;
export type NewChannelTopic = typeof channelTopic.$inferInsert;
export type GenerationEvent = typeof generationEvent.$inferSelect;
export type FaqEntry = typeof faqEntry.$inferSelect;
export type KnowledgeGapCluster = typeof knowledgeGapCluster.$inferSelect;
export type BackfillJob = typeof backfillJob.$inferSelect;
export type ReindexJob = typeof reindexJob.$inferSelect;
export type NewReindexJob = typeof reindexJob.$inferInsert;
export type ChannelSync = typeof channelSync.$inferSelect;
export type NewChannelSync = typeof channelSync.$inferInsert;
export type Attachment = typeof attachment.$inferSelect;
export type NewAttachment = typeof attachment.$inferInsert;
