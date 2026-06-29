import { tierLimits } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getPublishedThread,
  setCanonicalSummary,
} from '@dejavue/db';
import type { APIRoute } from 'astro';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
};

const enc = new TextEncoder();
const frame = (obj: unknown, event?: string): Uint8Array =>
  enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`);

/**
 * Server-Sent Events stream for a thread's AI summary. Streams the recap token-by-token
 * as the model writes it (Pro/Max), then persists it + meters the generation so later
 * views are served the stored summary instantly. If a summary already exists it is sent
 * in one frame. Always ends with a `done` event.
 */
export const GET: APIRoute = async ({ locals, params }) => {
  const { tenant, tier } = locals;
  const threadId = params.threadId;
  const endNow = () => new Response('event: done\ndata: {}\n\n', { status: 200, headers: SSE_HEADERS });

  if (!tenant || !threadId || !tierLimits(tier).generative) return endNow();

  const db = getDb();
  const thread = await getPublishedThread(db, tenant.guildId, threadId);
  if (!thread) return endNow();
  const guildId = tenant.guildId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown, event?: string): void => {
        try {
          controller.enqueue(frame(obj, event));
        } catch {
          /* client disconnected */
        }
      };
      const done = (): void => {
        send({}, 'done');
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        // Already generated → stream it in one frame.
        if (thread.canonicalSummary) {
          send({ delta: thread.canonicalSummary });
          return done();
        }
        const hasContent = !!(thread.acceptedAnswerText || thread.questionBody);
        if (!hasContent) return done();

        const baseQuota = tierLimits(tier).monthlyGenerationQuota;
        const quota = await checkQuota(db, guildId, baseQuota);
        if (!quota.allowed) return done();

        const { buildSummaryContext, summarizeThreadStream } = await import('@dejavue/ai');
        const context = buildSummaryContext({
          title: thread.title,
          questionBody: thread.questionBody,
          acceptedAnswerText: thread.acceptedAnswerText,
          transcript: thread.transcript,
        });
        if (!context.trim()) return done();

        const result = await summarizeThreadStream({ context }, (delta) => send({ delta }));
        const summary = result.text.trim();

        // Persist + meter — unless a concurrent first-viewer already did (avoid double count).
        if (summary) {
          const fresh = await getPublishedThread(db, guildId, threadId);
          if (!fresh?.canonicalSummary) {
            await setCanonicalSummary(db, thread.id, summary);
            await commitGeneration(db, {
              guildId,
              feature: 'summary',
              model: result.model,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
              threadId: thread.id,
              usedBefore: quota.used,
              baseQuota,
            });
          }
        }
        done();
      } catch {
        done();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
};
