import { sql } from 'drizzle-orm';
import {
  boolean,
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

/**
 * Embedding dimensionality. Both supported CPU models (bge-small-en-v1.5 and
 * multilingual-e5-small) are 384-dim, so model swaps never touch the schema.
 * Changing this is a destructive migration (reindex + re-embed).
 */
export const EMBEDDING_DIM = 384;

/** One human message in a thread's archived transcript (bot messages excluded). */
export interface TranscriptMessage {
  authorId: string;
  content: string;
  createdAt: string;
}

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

const emptyTextArray = sql`'{}'::text[]`;

// ---------------------------------------------------------------------------
// Per-guild configuration
// ---------------------------------------------------------------------------
export const guildConfig = pgTable('guild_config', {
  guildId: text('guild_id').primaryKey(),
  forumChannelIds: text('forum_channel_ids').array().notNull().default(emptyTextArray),
  // Per-guild forum tag snowflakes — never hardcoded constants.
  solvedTagId: text('solved_tag_id'),
  unsolvedTagId: text('unsolved_tag_id'),
  embeddingModel: text('embedding_model').notNull().default('bge-small-en-v1.5'),
  // Stale-question nudges (Plus+)
  nudgeEnabled: boolean('nudge_enabled').notNull().default(false),
  nudgeAfterHours: integer('nudge_after_hours').notNull().default(24),
  nudgeHelperRoleId: text('nudge_helper_role_id'),
  // Public web KB
  kbPublishOptIn: boolean('kb_publish_opt_in').notNull().default(false),
  kbSlug: text('kb_slug').unique(),
  // Custom domain for the public KB (one-time purchase). e.g. help.acme.com
  customDomain: text('custom_domain').unique(),
  // "powered by Dejavue" branding (forced on for Free tier regardless of this flag)
  brandingEnabled: boolean('branding_enabled').notNull().default(true),
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
    channelId: text('channel_id').notNull(), // parent forum channel
    channelName: text('channel_name'), // denormalized for KB category grouping
    threadId: text('thread_id').notNull(), // discord thread id (== starter message id)
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

export type GuildConfig = typeof guildConfig.$inferSelect;
export type NewGuildConfig = typeof guildConfig.$inferInsert;
export type Entitlement = typeof entitlement.$inferSelect;
export type NewEntitlement = typeof entitlement.$inferInsert;
export type Thread = typeof thread.$inferSelect;
export type NewThread = typeof thread.$inferInsert;
export type Embedding = typeof embedding.$inferSelect;
export type NewEmbedding = typeof embedding.$inferInsert;
export type GenerationEvent = typeof generationEvent.$inferSelect;
export type FaqEntry = typeof faqEntry.$inferSelect;
export type KnowledgeGapCluster = typeof knowledgeGapCluster.$inferSelect;
export type BackfillJob = typeof backfillJob.$inferSelect;
