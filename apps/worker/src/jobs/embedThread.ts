import { capture } from '@dejavue/analytics';
import { embeddingModelId } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import { getDb, getThreadByRowId } from '@dejavue/db';
import type { EmbedThreadJob } from '@dejavue/queue';
import { syncThreadEmbeddings } from '../lib/embedChunks';
import { canEmbed } from '../lib/quota';

const log = childLogger({ mod: 'job:embed-thread' });

/**
 * (Re-)embed a thread as a set of chunks covering its whole transcript.
 *
 * This is a diff, not a rebuild: syncThreadEmbeddings compares each chunk's hash against
 * what is stored for the active model and only sends the ones that moved. Appending a
 * reply or editing a message therefore costs one or two chunks rather than the entire
 * thread, which is what makes full-transcript coverage affordable on a paid API.
 */
export async function handleEmbedThread(job: EmbedThreadJob): Promise<void> {
  const db = getDb();
  // Prefer the live row (it has the transcript, so we can chunk the whole conversation);
  // fall back to the job payload if the row is gone.
  const row = await getThreadByRowId(db, job.threadRowId);
  const src = row
    ? {
        title: row.title,
        questionBody: row.questionBody,
        acceptedAnswerText: row.acceptedAnswerText,
        transcript: row.transcript,
      }
    : { title: job.title, questionBody: job.question, acceptedAnswerText: job.answer };

  const { chunks, reembedded, blocked } = await syncThreadEmbeddings(db, {
    threadRowId: job.threadRowId,
    guildId: job.guildId,
    modelId: embeddingModelId(job.modelId), // the active model, not a stale DB default
    modelKey: job.modelId,
    src,
    canSpend: () => canEmbed(job.guildId),
  });

  if (chunks.length === 0) {
    log.warn({ threadRowId: job.threadRowId }, 'nothing to embed, skipping');
    return;
  }
  if (blocked) {
    log.warn({ threadRowId: job.threadRowId, guildId: job.guildId }, 'over embedding ceiling; skipped');
    return;
  }
  capture('thread_indexed', job.guildId, { chunks: chunks.length, reembedded });
  log.info(
    { threadRowId: job.threadRowId, guildId: job.guildId, chunks: chunks.length, reembedded },
    'embedded thread',
  );
}
