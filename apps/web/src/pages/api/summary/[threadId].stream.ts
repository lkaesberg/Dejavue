import { tierLimits } from '@dejavue/core';
import { getDb, getPublishedThread } from '@dejavue/db';
import { enqueueSummarize } from '@dejavue/queue';
import type { APIRoute } from 'astro';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
};

const frame = (obj: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;
const DONE = frame({}, 'done');

/**
 * Server-Sent Events stream for a thread's AI summary.
 *
 * Summaries stay *lazy* — we only ever summarize a thread someone actually opened, so a
 * guild never pays to summarize threads nobody reads. What this route must not do is
 * *generate* inline: it is reachable by anything that speaks HTTP, so calling the model
 * from here made crawler traffic an uncapped inference bill on the web tier.
 *
 * So: a stored summary is returned immediately; a missing one enqueues the worker job
 * (pg-boss throttles to one per thread per 180s) and ends the stream. The worker checks
 * the guild's credit quota before spending anything, which is the intended meter. The
 * page falls back to the raw accepted answer and picks the summary up on a later view.
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const { tenant, tier } = locals;
  const threadId = params.threadId;
  const sse = (body: string) => new Response(body, { status: 200, headers: SSE_HEADERS });

  if (!tenant || !threadId || !tierLimits(tier).generative) return sse(DONE);

  const db = getDb();
  const thread = await getPublishedThread(db, tenant.guildId, threadId);
  if (!thread) return sse(DONE);

  // Already generated → hand it over in one frame.
  if (thread.canonicalSummary) return sse(frame({ delta: thread.canonicalSummary }) + DONE);

  // Nothing to summarize → don't queue work that would no-op in the worker.
  if (!thread.acceptedAnswerText && !thread.questionBody) return sse(DONE);

  // Queue it out-of-band, then tell the client to fall back for now.
  try {
    await enqueueSummarize({
      threadRowId: thread.id,
      guildId: tenant.guildId,
      question: thread.questionBody ?? '',
      answer: thread.acceptedAnswerText ?? '',
    });
  } catch {
    /* queue unavailable — the page still renders the raw answer */
  }
  return sse(frame({}, 'pending') + DONE);
};
