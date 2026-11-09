-- A public site that is "on" with neither a slug nor a custom domain is unreachable
-- (tenant resolution needs an address) and an illegal state: turn those rows off
-- first, then enforce it. Mostly rows from the era when kb_publish_opt_in defaulted
-- to true (0016, reverted in 0020).
UPDATE "guild_config" SET "kb_publish_opt_in" = false, "updated_at" = now() WHERE "kb_publish_opt_in" AND "kb_slug" IS NULL AND "custom_domain" IS NULL;--> statement-breakpoint
ALTER TABLE "guild_config" ADD CONSTRAINT "guild_config_kb_site_needs_address" CHECK (not "guild_config"."kb_publish_opt_in" or "guild_config"."kb_slug" is not null or "guild_config"."custom_domain" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "guild_config" VALIDATE CONSTRAINT "guild_config_kb_site_needs_address";
