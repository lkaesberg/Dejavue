import { buildEmbeddingText, embed, embeddingModelId } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import { getDb, getThreadByRowId, upsertEmbedding } from '@dejavue/db';
import type { EmbedThreadJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:embed-thread' });

/** Generate + store the passage embedding for a thread (question + answer context). */
export async function handleEmbedThread(job: EmbedThreadJob): Promise<void> {
  const db = getDb();
  // Prefer the live row (it has the transcript, so we can embed context around the
  // question and answer); fall back to the job payload if the row is gone.
  const row = await getThreadByRowId(db, job.threadRowId);
  const text = buildEmbeddingText(
    row
      ? {
          title: row.title,
          questionBody: row.questionBody,
          acceptedAnswerText: row.acceptedAnswerText,
          transcript: row.transcript,
        }
      : { title: job.title, questionBody: job.question, acceptedAnswerText: job.answer },
  );
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
