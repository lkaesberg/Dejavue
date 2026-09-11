-- Adds the 'dedup' vector kind: one per thread, covering only the asked question,
-- embedded with the model's symmetric similarity prompt (see embeddingSource).
--
-- Existing threads already carry retrieval vectors but no dedup vector, and the
-- "needs embedding" reconcile can't tell the difference (it joins on model id, not
-- source). Clearing the content hashes marks every thread stale so the next bot
-- startup re-embeds it and writes both kinds. Cheap: the archive is being rebuilt
-- under EmbeddingGemma anyway.
--
-- NOTE: ADD VALUE is safe inside this transaction on PG12+ only because nothing here
-- *uses* the new value — the first write happens later, from the app.
ALTER TYPE "public"."embedding_source" ADD VALUE 'dedup';--> statement-breakpoint
UPDATE "thread" SET "embed_content_hash" = NULL;
