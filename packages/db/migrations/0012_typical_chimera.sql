ALTER TABLE "guild_config" ADD COLUMN "guard_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "guard_auto_close" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "guard_sensitivity" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "wrong_channel_tag_id" text;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "tracked_channel_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "brand_name" text;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_theme" text DEFAULT 'light' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_accent" text DEFAULT 'indigo' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_corners" text DEFAULT 'rounded' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_heading_font" text DEFAULT 'grotesk' NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_logo_url" text;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_passphrase_hash" text;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "kb_imprint" jsonb;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "kind" text DEFAULT 'forum' NOT NULL;--> statement-breakpoint
CREATE INDEX "thread_guild_kind_idx" ON "thread" USING btree ("guild_id","kind");