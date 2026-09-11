/**
 * The event vocabulary, and the ONLY property keys that may ever leave this process.
 *
 * Dejavue's public privacy commitment is that we do not profile visitors and never
 * process message content for analytics. That promise is enforced here rather than by
 * discipline at each call site: `capture` drops any key not on {@link ALLOWED_PROPS},
 * and rejects values that aren't short scalars. Adding a key here is therefore a
 * deliberate act with a privacy consequence — think before you do it.
 *
 * Rules for anything added below:
 *  - counts, durations, enums, ids of *servers/channels/SKUs* — fine
 *  - message text, thread titles, search queries, user ids, usernames — never
 */
export const EVENTS = [
  // Lifecycle / growth
  'guild_joined',
  'guild_left',
  'setup_completed',
  'demo_created',
  // Core loop
  'thread_indexed',
  'thread_solved',
  'dedup_shown',
  'dedup_accepted',
  'dedup_dismissed',
  'thread_moved',
  'search_performed',
  'command_used',
  // Cost meters
  'embedding_batch',
  'generation',
  'index_cap_reached',
  'credits_exhausted',
  // Monetization
  'upsell_shown',
  'entitlement_created',
  'entitlement_updated',
  'entitlement_deleted',
  'topup_granted',
  // Daily rollup
  'stats_snapshot',
] as const;

export type DejavueEvent = (typeof EVENTS)[number];

/**
 * Every property key the pipeline will emit. Anything else is silently dropped.
 * Deliberately contains no free-text field — there is nowhere for content to hide.
 */
export const ALLOWED_PROPS = new Set([
  'tier',
  'member_count',
  'channel_kind',
  'mode',
  'kind',
  'chunks',
  'tokens',
  'reembedded',
  'model_id',
  'provider',
  'reason',
  'via',
  'match_count',
  'top_similarity',
  'result_count',
  'subcommand',
  'feature',
  'prompt_tokens',
  'completion_tokens',
  'success',
  'cap',
  'gate',
  'sku_id',
  'product_label',
  'credits',
  'guilds_installed',
  'guilds_free',
  'guilds_plus',
  'guilds_pro',
  'guilds_max',
  'threads_indexed',
  'messages_indexed',
  'threads_solved',
  'embedding_tokens_30d',
  'credits_used_30d',
  'mrr',
]);

/** Longest string value allowed. Enum-sized on purpose: free text cannot fit. */
export const MAX_STRING_LEN = 64;
