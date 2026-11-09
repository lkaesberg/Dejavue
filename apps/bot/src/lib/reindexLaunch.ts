import {
  createReindexJob,
  failReindex,
  getDb,
  type ReindexJob,
  transitionReindexJob,
} from '@dejavue/db';
import { enqueueReindexChannel } from '@dejavue/queue';

export interface ReindexLaunchInput {
  guildId: string;
  channelId: string;
  kind: 'forum' | 'tracked';
  statusChannelId: string | null;
  statusMessageId: string | null;
}

export interface ReindexLaunchDeps {
  createJob: (input: ReindexLaunchInput) => Promise<Pick<ReindexJob, 'id'>>;
  enqueue: (jobId: string) => Promise<unknown>;
  /** pending → failed for a job row that never reached the queue. */
  failPendingJob: (jobId: string) => Promise<unknown>;
  /** Release the channel's 'reindexing' claim (→ stale). */
  releaseClaim: (guildId: string, channelId: string) => Promise<unknown>;
}

const defaultDeps = (): ReindexLaunchDeps => {
  const db = getDb();
  return {
    createJob: (input) => createReindexJob(db, input),
    enqueue: (jobId) => enqueueReindexChannel({ reindexJobId: jobId }),
    failPendingJob: (jobId) => transitionReindexJob(db, jobId, ['pending'], 'failed'),
    releaseClaim: (guildId, channelId) => failReindex(db, guildId, channelId, 'reindex failed'),
  };
};

/**
 * Create + enqueue the job for a channel whose 'reindexing' claim the caller just won
 * (claimReindex). The claim, the job row and the queue message are three separate
 * writes, so if either of the last two fails the earlier ones are rolled back here: the
 * orphan row goes pending → failed (it would otherwise block every future rescan as an
 * "active" job) and the claim is released to 'stale' (it would otherwise pin the channel
 * at "re-scanning…" forever). The original error is rethrown.
 */
export async function launchClaimedReindex(
  input: ReindexLaunchInput,
  deps: ReindexLaunchDeps = defaultDeps(),
): Promise<string> {
  let jobId: string | null = null;
  try {
    jobId = (await deps.createJob(input)).id;
    await deps.enqueue(jobId);
    return jobId;
  } catch (err) {
    if (jobId) await deps.failPendingJob(jobId).catch(() => undefined);
    await deps.releaseClaim(input.guildId, input.channelId).catch(() => undefined);
    throw err;
  }
}
