import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@dejavue/core';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Sql = ReturnType<typeof postgres>;

let _sql: Sql | undefined;
let _db: Database | undefined;

export function getSql(): Sql {
  if (!_sql) {
    _sql = postgres(getEnv().DATABASE_URL, { max: 10, onnotice: () => {} });
  }
  return _sql;
}

export function getDb(): Database {
  if (!_db) _db = drizzle(getSql(), { schema });
  return _db;
}

/**
 * Resolve once Postgres answers, retrying with backoff (1s, doubling, capped at 30s).
 * It never gives up: after a reboot Docker starts every container at once, so a process
 * can be up before its database — startup work should wait for it, not run and fail.
 */
export async function waitForDatabase(
  opts: {
    ping?: () => Promise<unknown>;
    onRetry?: (attempt: number, err: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const ping = opts.ping ?? (async () => getSql()`select 1`);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1, delay = 1000; ; attempt++, delay = Math.min(delay * 2, 30_000)) {
    try {
      await ping();
      return;
    } catch (err) {
      opts.onRetry?.(attempt, err);
      await sleep(delay);
    }
  }
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = undefined;
    _db = undefined;
  }
}
