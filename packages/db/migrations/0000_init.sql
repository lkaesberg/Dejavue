-- pgvector extension must exist before any vector(384) column is created.
-- drizzle-kit does not emit this (drizzle-orm #5792); added by hand.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."backfill_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cluster_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."embedding_source" AS ENUM('question', 'answer', 'summary');--> statement-breakpoint
CREATE TYPE "public"."entitlement_type" AS ENUM('guild_subscription', 'user_subscription', 'durable', 'consumable', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."generation_feature" AS ENUM('draft', 'summary', 'faq', 'cluster_label');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('open', 'solved', 'unsolved');--> statement-breakpoint
CREATE TABLE "backfill_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"entitlement_id" text,
	"status" "backfill_status" DEFAULT 'pending' NOT NULL,
	"cursor" text,
	"processed_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"status_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"source" "embedding_source" DEFAULT 'question' NOT NULL,
	"model_id" text NOT NULL,
	"embedding_version" integer DEFAULT 1 NOT NULL,
	"vec" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement" (
	"id" text PRIMARY KEY NOT NULL,
	"sku_id" text NOT NULL,
	"guild_id" text,
	"user_id" text,
	"type" "entitlement_type" DEFAULT 'unknown' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"deleted" boolean DEFAULT false NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "faq_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cluster_id" uuid,
	"published" boolean DEFAULT true NOT NULL,
	"manual_override" boolean DEFAULT false NOT NULL,
	"last_regenerated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"feature" "generation_feature" NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"top_up_credits_consumed" integer DEFAULT 0 NOT NULL,
	"thread_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_config" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"forum_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"solved_tag_id" text,
	"unsolved_tag_id" text,
	"embedding_model" text DEFAULT 'bge-small-en-v1.5' NOT NULL,
	"nudge_enabled" boolean DEFAULT false NOT NULL,
	"nudge_after_hours" integer DEFAULT 24 NOT NULL,
	"nudge_helper_role_id" text,
	"kb_publish_opt_in" boolean DEFAULT false NOT NULL,
	"kb_slug" text,
	"branding_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_config_kb_slug_unique" UNIQUE("kb_slug")
);
--> statement-breakpoint
CREATE TABLE "knowledge_gap_cluster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"label" text,
	"representative_text" text,
	"medoid_thread_id" uuid,
	"member_thread_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"status" "cluster_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"question_body" text DEFAULT '' NOT NULL,
	"op_user_id" text,
	"status" "thread_status" DEFAULT 'open' NOT NULL,
	"accepted_answer_message_id" text,
	"accepted_answer_text" text,
	"accepted_answer_author_id" text,
	"canonical_summary" text,
	"published_to_kb" boolean DEFAULT false NOT NULL,
	"do_not_publish" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"solved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_up_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"credits" integer NOT NULL,
	"credits_remaining" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faq_entry" ADD CONSTRAINT "faq_entry_cluster_id_knowledge_gap_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."knowledge_gap_cluster"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_event" ADD CONSTRAINT "generation_event_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gap_cluster" ADD CONSTRAINT "knowledge_gap_cluster_medoid_thread_id_thread_id_fk" FOREIGN KEY ("medoid_thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backfill_guild_status_idx" ON "backfill_job" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_thread_source_ver_idx" ON "embedding" USING btree ("thread_id","source","embedding_version");--> statement-breakpoint
CREATE INDEX "embedding_guild_idx" ON "embedding" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "entitlement_guild_idx" ON "entitlement" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "entitlement_sku_idx" ON "entitlement" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "faq_guild_idx" ON "faq_entry" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "genevent_guild_created_idx" ON "generation_event" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "cluster_guild_status_idx" ON "knowledge_gap_cluster" USING btree ("guild_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_guild_thread_idx" ON "thread" USING btree ("guild_id","thread_id");--> statement-breakpoint
CREATE INDEX "thread_guild_status_idx" ON "thread" USING btree ("guild_id","status");--> statement-breakpoint
CREATE INDEX "thread_guild_published_idx" ON "thread" USING btree ("guild_id","published_to_kb");--> statement-breakpoint
CREATE INDEX "topup_guild_idx" ON "top_up_grant" USING btree ("guild_id");--> statement-breakpoint
-- HNSW vector index, hand-written: drizzle-kit cannot emit the operator class
-- (drizzle-orm #5792). Build after bulk loads, not before. Tune recall at query
-- time with `SET LOCAL hnsw.ef_search`.
CREATE INDEX "embedding_vec_hnsw_idx" ON "embedding" USING hnsw ("vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64);