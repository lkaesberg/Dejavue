import type { Database } from '../client';
import { embedding, type Embedding } from '../schema';

export interface UpsertEmbeddingInput {
  threadRowId: string;
  guildId: string;
  modelId: string;
  vector: number[];
  source?: Embedding['source'];
  version?: number;
}

/**
 * Insert or replace an embedding for (thread, source, version). Idempotent so
 * re-embedding (e.g. during backfill) is a no-op-equivalent.
 */
export async function upsertEmbedding(db: Database, input: UpsertEmbeddingInput): Promise<void> {
  const source = input.source ?? 'question';
  const version = input.version ?? 1;
  await db
    .insert(embedding)
    .values({
      threadId: input.threadRowId,
      guildId: input.guildId,
      source,
      modelId: input.modelId,
      embeddingVersion: version,
      vec: input.vector,
    })
    .onConflictDoUpdate({
      target: [embedding.threadId, embedding.source, embedding.embeddingVersion],
      set: { vec: input.vector, modelId: input.modelId },
    });
}
