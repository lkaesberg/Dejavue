-- Point existing guilds at the current model.
--
-- The default only applies to NEW rows, and every existing guild still carries the old
-- 384-d id. On a 768-d schema that combination makes every embedding insert fail, so
-- the rows have to be migrated too — the app-side guard in resolveModel covers rows
-- this misses (a guild that had explicitly chosen a model), but the stored value is
-- what the setup message shows, so it should be correct rather than merely overridden.
ALTER TABLE "guild_config" ALTER COLUMN "embedding_model" SET DEFAULT 'embeddinggemma-300m';--> statement-breakpoint
UPDATE "guild_config"
SET "embedding_model" = 'embeddinggemma-300m'
WHERE "embedding_model" IN ('bge-small-en-v1.5', 'multilingual-e5-small')
   OR "embedding_model" LIKE '%/%';
