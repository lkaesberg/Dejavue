import { capture } from '@dejavue/analytics';
import { buildEmbeddingChunks, type EmbedChunk, embedBatch, embedContentHash } from '@dejavue/ai';
import { getEnv } from '@dejavue/core';
import {
  type Database,
  deleteEmbeddingChunksNotIn,
  getThreadChunkHashes,
  recordEmbeddingUsage,
  setEmbedContentHash,
  upsertEmbedding,
} from '@dejavue/db';

export interface SyncThreadEmbeddingsInput {
  threadRowId: string;
  guildId: string;
  /** The resolved active model id (already through embeddingModelId). */
  modelId: string;
  /** Model key handed to the embedding backend (may be a per-guild override). */
  modelKey?: string;
  src: Parameters<typeof buildEmbeddingChunks>[0];
  /** Where this sync came from, for cost attribution: live | backfill | reindex. */
  reason?: 'live' | 'backfill' | 'reindex';
  /**
   * Budget gate, consulted lazily and only when there is stale work to pay for — so an
   * up-to-date thread costs no quota lookup. Returning false skips embedding AND leaves
   * the thread's content hash unstamped, so it is retried once the window resets rather
   * than being silently treated as indexed.
   */
  canSpend?: () => Promise<boolean>;
}

export interface SyncThreadEmbeddingsResult {
  chunks: EmbedChunk[];
  /** True when embedding was skipped because the guild is over its token ceiling. */
  blocked?: boolean;
  /** How many chunks actually had to be sent to the embedding backend. */
  reembedded: number;
  /** Embedding tokens billed for this sync (0 when nothing was stale). */
  tokens: number;
  /** Chunk 0's vector when it was (re)computed — the auto-fold paths need it. */
  primaryVector?: number[];
}

/**
 * Bring a thread's chunk embeddings up to date, embedding only what changed.
 *
 * Shared by the live embed job and the bulk reindex so both agree on chunk numbering
 * and on what "already up to date" means. The hash comparison is what makes a reindex
 * cheap: re-running it over an unchanged channel sends nothing to the backend, while a
 * model switch invalidates every chunk (hashes are looked up per model) and rebuilds.
 */
export async function syncThreadEmbeddings(
  db: Database,
  input: SyncThreadEmbeddingsInput,
): Promise<SyncThreadEmbeddingsResult> {
  const chunks = buildEmbeddingChunks(input.src);
  if (chunks.length === 0) {
    await deleteEmbeddingChunksNotIn(db, input.threadRowId, []).catch(() => undefined);
    return { chunks, reembedded: 0, tokens: 0 };
  }

  const stored = await getThreadChunkHashes(db, input.threadRowId, input.modelId);
  const stale = chunks.filter((c) => stored.get(c.index) !== c.hash);
  let primaryVector: number[] | undefined;

  if (stale.length > 0 && input.canSpend && !(await input.canSpend())) {
    return { chunks, reembedded: 0, tokens: 0, blocked: true };
  }

  const batchSize = getEnv().EMBED_BATCH_SIZE;
  let tokens = 0;
  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    const { vectors, tokens: spent } = await embedBatch(
      batch.map((c) => c.text),
      { mode: 'passage', model: input.modelKey },
    );
    tokens += spent;
    for (const [n, chunk] of batch.entries()) {
      const vector = vectors[n];
      if (!vector) continue;
      if (chunk.index === 0) primaryVector = vector;
      await upsertEmbedding(db, {
        threadRowId: input.threadRowId,
        guildId: input.guildId,
        modelId: input.modelId,
        chunkIndex: chunk.index,
        chunkHash: chunk.hash,
        vector,
      });
    }
  }

  // Drop slots the thread no longer has (messages deleted, or a cap now applies).
  await deleteEmbeddingChunksNotIn(
    db,
    input.threadRowId,
    chunks.map((c) => c.index),
  ).catch(() => undefined);

  // Record what indexing this thread actually cost. Best-effort: losing a ledger row
  // must never fail the embed itself.
  if (tokens > 0) {
    await recordEmbeddingUsage(db, {
      guildId: input.guildId,
      model: input.modelId,
      tokens,
      threadId: input.threadRowId,
    }).catch(() => undefined);
    capture('embedding_batch', input.guildId, {
      tokens,
      chunks: stale.length,
      model_id: input.modelId,
      reason: input.reason ?? 'live',
    });
  }

  await setEmbedContentHash(db, input.threadRowId, embedContentHash(input.src)).catch(
    () => undefined,
  );
  return { chunks, reembedded: stale.length, tokens, primaryVector };
}
