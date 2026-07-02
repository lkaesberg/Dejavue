import { PgBoss } from 'pg-boss';
import { childLogger, getEnv } from '@dejavue/core';
import { type QueueName, QUEUES } from './jobs';

const log = childLogger({ mod: 'queue' });

let _boss: PgBoss | undefined;
let started = false;

export function getBoss(): PgBoss {
  if (!_boss) {
    _boss = new PgBoss({ connectionString: getEnv().DATABASE_URL });
    _boss.on('error', (err: unknown) => log.error({ err }, 'pg-boss error'));
  }
  return _boss;
}

interface QueuePolicy {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds?: number;
}

// Retries always back off (retryDelay is the base, in seconds) — pg-boss's
// default of retryDelay 0 means an immediate retry, which is exactly wrong for
// the transient failures these jobs hit (Discord 429s, OpenRouter blips).
const DEFAULT_POLICY: QueuePolicy = { retryLimit: 3, retryDelay: 30, retryBackoff: true };

// Backfill/reindex paginate a channel's full history in one invocation and can
// legitimately run for hours; pg-boss's default 15-minute expiry would mark
// them failed and start a retry WHILE the original is still running. Both
// handlers checkpoint to their own job rows, so a post-crash retry resumes.
const LONG_RUNNING_EXPIRE = 6 * 3600;
// LLM jobs wait on OpenRouter; give them headroom past the 15-minute default.
const LLM_EXPIRE = 1800;

/** Per-queue delivery policy, applied on startup (create + update). */
export const QUEUE_POLICIES: Record<QueueName, QueuePolicy> = {
  [QUEUES.EMBED_THREAD]: DEFAULT_POLICY,
  [QUEUES.SUMMARIZE_THREAD]: { ...DEFAULT_POLICY, expireInSeconds: LLM_EXPIRE },
  [QUEUES.NUDGE_STALE]: { ...DEFAULT_POLICY, expireInSeconds: LLM_EXPIRE },
  [QUEUES.CLUSTER_GAPS]: { ...DEFAULT_POLICY, expireInSeconds: LLM_EXPIRE },
  [QUEUES.REGEN_FAQ]: { ...DEFAULT_POLICY, expireInSeconds: LLM_EXPIRE },
  [QUEUES.RECONCILE_ENTITLEMENTS]: DEFAULT_POLICY,
  [QUEUES.BACKFILL_FORUM]: { ...DEFAULT_POLICY, expireInSeconds: LONG_RUNNING_EXPIRE },
  [QUEUES.REVALIDATE_KB]: DEFAULT_POLICY,
  [QUEUES.INGEST_ATTACHMENT]: DEFAULT_POLICY,
  [QUEUES.REINDEX_CHANNEL]: { ...DEFAULT_POLICY, expireInSeconds: LONG_RUNNING_EXPIRE },
};

async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    const policy = QUEUE_POLICIES[name];
    try {
      await boss.createQueue(name, policy);
    } catch (err) {
      // createQueue is effectively idempotent; ignore "already exists".
      log.debug({ err, name }, 'createQueue noop');
    }
    try {
      // Retrofit policy changes onto queues that already exist in deployed DBs.
      await boss.updateQueue(name, policy);
    } catch (err) {
      log.warn({ err, name }, 'updateQueue failed');
    }
  }
}

/** Start (idempotently) the shared pg-boss instance and ensure all queues exist. */
export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  if (!started) {
    await boss.start();
    started = true;
    await ensureQueues(boss);
    log.info('pg-boss started');
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (_boss && started) {
    await _boss.stop();
    started = false;
  }
}
