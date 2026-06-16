import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://dejavue:dejavue@localhost:5432/dejavue';
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  await migrate(db, { migrationsFolder });
  console.log('✓ migrations applied');
} catch (err) {
  console.error('✗ migration failed:', err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
