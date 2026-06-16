import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

let loaded = false;

/**
 * Load the nearest `.env` walking up from the current working directory.
 *
 * `import 'dotenv/config'` only checks `cwd/.env`, which breaks under
 * `pnpm --filter <pkg> <script>` (cwd is the package dir, not the repo root).
 * Call this at the very top of every entrypoint, before any getEnv()/logger().
 */
export function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config(); // fall back to default (harmless if absent)
}
