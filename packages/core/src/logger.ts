import { pino, type Logger } from 'pino';
import { getEnv } from './env';

function build(): Logger {
  const env = getEnv();
  // pino-pretty runs as a worker-thread transport that doesn't survive bundling
  // (e.g. the Astro SSR build), so keep it opt-in via LOG_PRETTY=1. Everywhere
  // else (incl. the web app and production) logs as plain JSON.
  const pretty = process.env.LOG_PRETTY === '1';
  return pino({
    level: env.LOG_LEVEL,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

let _logger: Logger | undefined;

/** Lazily-built root logger (so dotenv is loaded before we read LOG_LEVEL). */
export function logger(): Logger {
  if (!_logger) _logger = build();
  return _logger;
}

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger().child(bindings);
}
