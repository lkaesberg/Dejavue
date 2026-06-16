// Side-effect module: load the root .env as the very first thing an entrypoint
// does. Import this BEFORE any other module (`import '@dejavue/core/env-preload'`)
// so env is populated before any top-level getEnv()/logger() memoizes it.
import { loadEnvFile } from './dotenv';

loadEnvFile();
