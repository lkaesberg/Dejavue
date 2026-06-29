import { buildEmbeddingText, embed, embedContentHash, embeddingModelId } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import { getDb, getThreadByRowId, setEmbedContentHash, upsertEmbedding } from '@dejavue/db';
import type { EmbedThreadJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:embed-thread' });

/** Generate + store the passage embedding for a thread (question + answer context). */
export async function handleEmbedThread(job: EmbedThreadJob): Promise<void> {
  const db = getDb();
  // Prefer the live row (it has the transcript, so we can embed context around the
  // question and answer); fall back to the job payload if the row is gone.
  const row = await getThreadByRowId(db, job.threadRowId);
  const src = row
    ? {
        title: row.title,
        questionBody: row.questionBody,
        acceptedAnswerText: row.acceptedAnswerText,
        transcript: row.transcript,
      }
    : { title: job.title, questionBody: job.question, acceptedAnswerText: job.answer };
  const text = buildEmbeddingText(src);
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
  // Stamp the content hash so the next capture only re-embeds on a real change.
  await setEmbedContentHash(db, job.threadRowId, embedContentHash(src)).catch(() => undefined);
  log.info({ threadRowId: job.threadRowId, guildId: job.guildId }, 'embedded thread');
}
