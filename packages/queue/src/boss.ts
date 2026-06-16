import { PgBoss } from 'pg-boss';
import { childLogger, getEnv } from '@dejavue/core';
import { QUEUES } from './jobs';

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

async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    try {
      await boss.createQueue(name);
    } catch (err) {
      // createQueue is effectively idempotent; ignore "already exists".
      log.debug({ err, name }, 'createQueue noop');
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
