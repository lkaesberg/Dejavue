DROP INDEX "embedding_thread_source_ver_idx";--> statement-breakpoint
ALTER TABLE "embedding" ADD COLUMN "chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "embedding" ADD COLUMN "chunk_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_thread_source_ver_chunk_idx" ON "embedding" USING btree ("thread_id","source","embedding_version","chunk_index");--> statement-breakpoint
CREATE INDEX "embedding_thread_model_idx" ON "embedding" USING btree ("thread_id","model_id");