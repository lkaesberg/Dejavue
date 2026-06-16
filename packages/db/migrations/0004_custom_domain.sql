ALTER TABLE "guild_config" ADD COLUMN "custom_domain" text;--> statement-breakpoint
ALTER TABLE "guild_config" ADD CONSTRAINT "guild_config_custom_domain_unique" UNIQUE("custom_domain");