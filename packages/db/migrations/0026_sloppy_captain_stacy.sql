-- Move the vector columns from 384-d (bge-small) to 768-d (EmbeddingGemma-300m).
--
-- Existing vectors can't come along: they are 384-d, produced by a different model,
-- and pgvector cannot cast between dimensions. They're deleted here, and the bot's
-- startup reconcile re-embeds everything under the new model id on the next boot —
-- the same path that already handles a provider switch.
--
-- The HNSW index has to go before the type change and be rebuilt after: an index can't
-- survive its column changing dimension. Rebuilding on an empty table is instant, which
-- is why the delete comes first.
DROP INDEX IF EXISTS "embedding_vec_hnsw_idx";--> statement-breakpoint
DELETE FROM "embedding";--> statement-breakpoint
DELETE FROM "channel_topic";--> statement-breakpoint
ALTER TABLE "channel_topic" ALTER COLUMN "vec" SET DATA TYPE vector(768);--> statement-breakpoint
ALTER TABLE "embedding" ALTER COLUMN "vec" SET DATA TYPE vector(768);--> statement-breakpoint
-- Same parameters as 0000_init (m=16 / ef_construction=64, cosine ops); recall is
-- tuned per query at runtime with `SET LOCAL hnsw.ef_search`.
CREATE INDEX "embedding_vec_hnsw_idx" ON "embedding" USING hnsw ("vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
-- Threads keep their rows and transcripts; only the vectors are gone. Clearing the
-- content hash marks every thread as never-embedded so none is mistaken for fresh.
UPDATE "thread" SET "embed_content_hash" = NULL;
