import { embed, embeddingModelId } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import { getDb, upsertEmbedding } from '@dejavue/db';
import type { EmbedThreadJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:embed-thread' });

/** Generate + store the passage embedding for a solved thread. */
export async function handleEmbedThread(job: EmbedThreadJob): Promise<void> {
  const text = [job.title, job.question, job.answer ?? '']
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!text) {
    log.warn({ threadRowId: job.threadRowId }, 'nothing to embed, skipping');
    return;
  }
  const [vector] = await embed([text], { mode: 'passage', model: job.modelId });
  if (!vector) return;
  await upsertEmbedding(getDb(), {
    threadRowId: job.threadRowId,
    guildId: job.guildId,
    modelId: embeddingModelId(job.modelId), // the actual active model, not a stale DB default
    vector,
  });
  log.info({ threadRowId: job.threadRowId, guildId: job.guildId }, 'embedded thread');
}
