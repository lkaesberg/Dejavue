CREATE TABLE "channel_topic" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"model_id" text NOT NULL,
	"text" text NOT NULL,
	"vec" vector(384) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "channel_fit_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_topic_guild_channel_model_idx" ON "channel_topic" USING btree ("guild_id","channel_id","model_id");--> statement-breakpoint
CREATE INDEX "channel_topic_guild_idx" ON "channel_topic" USING btree ("guild_id");