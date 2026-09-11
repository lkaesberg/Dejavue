import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Database } from '../client';
import { type Embedding, type EmbeddingSource, embedding, RETRIEVAL_SOURCES } from '../schema';

export interface UpsertEmbeddingInput {
  threadRowId: string;
  guildId: string;
  modelId: string;
  vector: number[];
  /** Position within the thread; 0 is the canonical Q&A chunk. */
  chunkIndex?: number;
  /** FNV-1a of the chunk text this vector was built from. */
  chunkHash?: string;
  source?: Embedding['source'];
  version?: number;
}

/**
 * Insert or replace the embedding for (thread, source, version, chunk). Idempotent, so
 * re-embedding is a no-op-equivalent. The conflict target deliberately excludes model_id:
 * there is one row per chunk slot, and switching models replaces the vector in place
 * rather than accumulating a second geometry alongside it.
 */
export async function upsertEmbedding(db: Database, input: UpsertEmbeddingInput): Promise<void> {
  const source = input.source ?? 'question';
  const version = input.version ?? 1;
  const chunkIndex = input.chunkIndex ?? 0;
  await db
    .insert(embedding)
    .values({
      threadId: input.threadRowId,
      guildId: input.guildId,
      source,
      modelId: input.modelId,
      embeddingVersion: version,
      chunkIndex,
      chunkHash: input.chunkHash ?? null,
      vec: input.vector,
    })
    .onConflictDoUpdate({
      target: [
        embedding.threadId,
        embedding.source,
        embedding.embeddingVersion,
        embedding.chunkIndex,
      ],
      set: {
        vec: input.vector,
        modelId: input.modelId,
        chunkHash: input.chunkHash ?? null,
        createdAt: new Date(),
      },
    });
}

/**
 * The chunk hashes currently stored for a thread under a given model, keyed by chunk
 * index. Scoped to the model on purpose: vectors from a different model have different
 * geometry, so on a model switch every chunk reads as missing and is rebuilt.
 *
 * A NULL `chunk_hash` (written before chunking existed) is reported as missing, so
 * pre-existing rows re-chunk on their next pass.
 */
export async function getThreadChunkHashes(
  db: Database,
  threadRowId: string,
  modelId: string,
  sources: readonly EmbeddingSource[] = RETRIEVAL_SOURCES,
): Promise<Map<number, string>> {
  const rows = await db
    .select({ chunkIndex: embedding.chunkIndex, chunkHash: embedding.chunkHash })
    .from(embedding)
    .where(
      and(
        eq(embedding.threadId, threadRowId),
        eq(embedding.modelId, modelId),
        // Scoped by kind: the 'dedup' vector also lives at chunk 0, and letting it into
        // this map would make chunk 0 look permanently stale (or wrongly fresh).
        inArray(embedding.source, [...sources]),
      ),
    );
  const out = new Map<number, string>();
  for (const r of rows) if (r.chunkHash) out.set(r.chunkIndex, r.chunkHash);
  return out;
}

/**
 * Drop chunk rows the thread no longer has (it shrank, or messages were deleted).
 * Not scoped by model: a stale slot must go regardless of which model wrote it.
 * Passing an empty list removes every chunk for the thread.
 */
export async function deleteEmbeddingChunksNotIn(
  db: Database,
  threadRowId: string,
  keepIndices: number[],
): Promise<void> {
  // Retrieval chunks only — the single 'dedup' vector is not part of this numbering and
  // must survive a thread whose transcript chunks all disappeared.
  const retrieval = inArray(embedding.source, [...RETRIEVAL_SOURCES]);
  await db
    .delete(embedding)
    .where(
      keepIndices.length === 0
        ? and(eq(embedding.threadId, threadRowId), retrieval)
        : and(
            eq(embedding.threadId, threadRowId),
            retrieval,
            notInArray(embedding.chunkIndex, keepIndices),
          ),
    );
}
