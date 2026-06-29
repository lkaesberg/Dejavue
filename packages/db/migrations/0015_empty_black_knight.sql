CREATE TYPE "public"."channel_sync_state" AS ENUM('never', 'synced', 'stale', 'reindexing');--> statement-breakpoint
CREATE TABLE "channel_sync" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" "channel_sync_state" DEFAULT 'never' NOT NULL,
	"last_indexed_message_id" text,
	"indexed_message_count" integer DEFAULT 0 NOT NULL,
	"last_reindex_at" timestamp with time zone,
	"last_reindex_through" text,
	"stale_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reindex_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "backfill_status" DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'listing' NOT NULL,
	"cursor" text,
	"processed_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"status_channel_id" text,
	"status_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "remove_solved_prompt" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "embed_content_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sync_guild_channel_idx" ON "channel_sync" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "channel_sync_guild_idx" ON "channel_sync" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "reindex_guild_status_idx" ON "reindex_job" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "reindex_guild_channel_idx" ON "reindex_job" USING btree ("guild_id","channel_id");--> statement-breakpoint
-- Auto-publish everything online (one cap replaces the old archive/page/tracked caps).
-- Knowledge-channel threads and tracked-channel segments publish unconditionally; question
-- threads only once solved (an unanswered question isn't "knowledge"). Duplicates and
-- do-not-publish rows stay excluded.
UPDATE "thread" t SET "published_to_kb" = true, "updated_at" = now()
FROM "guild_config" g
WHERE t."guild_id" = g."guild_id"
  AND t."do_not_publish" = false
  AND t."duplicate_of_thread_id" IS NULL
  AND (t."kind" = 'channel' OR t."status" = 'solved'
       OR (g."channel_modes" ->> t."channel_id") = 'knowledge');--> statement-breakpoint
-- Seed channel_sync from existing threads — assume current content is in sync at migrate
-- time. indexed_message_count mirrors countIndexedMessages: online (published) threads,
-- each worth max(transcript length, 1). Runs after the auto-publish UPDATE above.
INSERT INTO "channel_sync" ("guild_id", "channel_id", "kind", "state", "indexed_message_count", "updated_at")
SELECT t."guild_id", t."channel_id", min(t."kind"), 'synced',
       COALESCE(SUM(GREATEST(CASE WHEN jsonb_typeof(t."transcript") = 'array'
                                  THEN jsonb_array_length(t."transcript") ELSE 0 END, 1))
                FILTER (WHERE t."published_to_kb" = true), 0),
       now()
FROM "thread" t
GROUP BY t."guild_id", t."channel_id"
ON CONFLICT ("guild_id", "channel_id") DO NOTHING;