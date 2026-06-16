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

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = undefined;
    _db = undefined;
  }
}
