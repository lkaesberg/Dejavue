import { getDb, getPublishedThread } from '@dejavue/db';
import type { APIRoute } from 'astro';
import { extractThreadId, threadPath } from '../../lib/slug';

/**
 * Legacy thread urls — `/t/{id}` and the short-lived `/t/{slug}-{id}` form —
 * permanently redirect to the canonical `/c/{channel}/{slug}-{id}` path, so
 * indexed links and old Discord messages keep working.
 */
export const GET: APIRoute = async ({ locals, params, redirect }) => {
  const tenant = locals.tenant;
  const threadId = extractThreadId(params.threadId ?? '');
  if (!tenant || !threadId) return new Response('Not found', { status: 404 });
  const thread = await getPublishedThread(getDb(), tenant.guildId, threadId);
  if (!thread) return new Response('Not found', { status: 404 });
  return redirect(threadPath(thread), 301);
};
