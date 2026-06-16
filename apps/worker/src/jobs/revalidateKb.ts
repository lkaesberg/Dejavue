import { childLogger } from '@dejavue/core';
import type { RevalidateKbJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:revalidate-kb' });

/**
 * The Astro KB renders SSR (live from the DB), so pages are always fresh and no
 * explicit invalidation is required today. This hook exists so that when a CDN /
 * edge cache is placed in front of the web app, the worker can POST to a secured
 * revalidation route (KB_REVALIDATE_SECRET) on solve / unsolve / delete.
 */
export async function handleRevalidateKb(job: RevalidateKbJob): Promise<void> {
  log.info({ guildId: job.guildId, threadId: job.threadId, action: job.action }, 'kb revalidate (ssr: live, noop)');
}
