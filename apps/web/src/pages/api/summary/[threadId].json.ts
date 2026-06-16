import { getDb, getPublishedThread } from '@dejavue/db';
import type { APIRoute } from 'astro';

// Polled by the thread page while an AI summary is being generated in the
// background. Returns the canonical summary once the worker has written it.
export const GET: APIRoute = async ({ locals, params }) => {
  const tenant = locals.tenant;
  const threadId = params.threadId;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  if (!tenant || !threadId) return json({ ready: false, summary: '' }, 404);

  const thread = await getPublishedThread(getDb(), tenant.guildId, threadId);
  const summary = thread?.canonicalSummary ?? '';
  return json({ ready: !!summary, summary });
};
