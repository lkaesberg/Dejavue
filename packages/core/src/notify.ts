import { getEnv } from './env';
import { logger } from './logger';

/**
 * Operational alerts to a Discord webhook (DISCORD_WEBHOOK_URL): service
 * startup, subscription changes, and crashes.
 *
 * Design rules — a monitoring channel must never become a liability:
 *  - No-op when the webhook is unset, so dev/CI/test stay silent.
 *  - Never throws and never awaits into a hot path by default (see notifyAsync).
 *  - A failed post is logged, never re-notified — no alert-about-the-alert loops.
 */

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

/** Discord embed accent colours per severity. */
const COLORS: Record<NotifyLevel, number> = {
  info: 0x5865f2, // blurple
  success: 0x2ecc71, // green
  warning: 0xf1c40f, // amber
  error: 0xed4245, // red
};

export interface NotifyField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyOptions {
  level?: NotifyLevel;
  title: string;
  description?: string;
  fields?: NotifyField[];
  /** Overrides the name shown for the webhook post. Defaults to "Dejavue". */
  username?: string;
}

const TIMEOUT_MS = 5_000;

const log = logger().child({ mod: 'notify' });

/**
 * Post an operational event to the ops webhook. Awaitable, but resolves even on
 * failure (logs a warning). Use in exit paths where the post must flush before
 * the process dies; use {@link notifyAsync} on hot paths.
 */
export async function notify(opts: NotifyOptions): Promise<void> {
  const url = getEnv().DISCORD_WEBHOOK_URL;
  if (!url) return;

  const level = opts.level ?? 'info';
  const embed = {
    title: opts.title.slice(0, 256),
    ...(opts.description ? { description: opts.description.slice(0, 4096) } : {}),
    color: COLORS[level],
    ...(opts.fields?.length
      ? {
          fields: opts.fields.slice(0, 25).map((f) => ({
            name: f.name.slice(0, 256),
            value: (f.value || '—').slice(0, 1024),
            inline: f.inline ?? true,
          })),
        }
      : {}),
    timestamp: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: opts.username ?? 'Dejavue', embeds: [embed] }),
      signal: controller.signal,
    });
    if (!res.ok) log.warn({ status: res.status, title: opts.title }, 'ops webhook returned non-2xx');
  } catch (err) {
    // Swallow: an alert channel that's down must not break the caller, and this
    // must never itself trigger another notify().
    log.warn({ err, title: opts.title }, 'ops webhook post failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget: schedule a notify without awaiting or surfacing errors. */
export function notifyAsync(opts: NotifyOptions): void {
  void notify(opts);
}

/**
 * Register process-level crash handlers that alert (best effort) and then exit
 * non-zero. Matches Node's default "terminate on fatal error" behaviour while
 * turning each crash into an ops alert. Call once, early, in an entrypoint.
 */
export function installCrashHandlers(service: string): void {
  const onFatal = (kind: 'uncaughtException' | 'unhandledRejection') => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.fatal({ err, kind }, `${service}: ${kind}`);
    // Best-effort alert with the 5s timeout, then exit regardless of outcome.
    void notify({
      level: 'error',
      title: `🔴 ${service}: ${kind}`,
      description: detail.slice(0, 4000),
    }).finally(() => process.exit(1));
  };
  process.on('uncaughtException', onFatal('uncaughtException'));
  process.on('unhandledRejection', onFatal('unhandledRejection'));
}
