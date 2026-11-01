CREATE TABLE "user_opt_out" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guild_config" ADD COLUMN "purged_at" timestamp with time zone;