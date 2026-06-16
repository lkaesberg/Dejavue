import { pino, type Logger } from 'pino';
import { getEnv } from './env';

function build(): Logger {
  const env = getEnv();
  const pretty = env.NODE_ENV === 'development';
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
