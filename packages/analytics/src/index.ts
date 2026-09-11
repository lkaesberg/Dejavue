import { childLogger, getEnv } from '@dejavue/core';
import { PostHog } from 'posthog-node';
import { ALLOWED_PROPS, type DejavueEvent, MAX_STRING_LEN } from './events';

export * from './events';

const log = childLogger({ mod: 'analytics' });

/** Property values we are willing to transmit. Objects and arrays are never sent. */
export type PropValue = string | number | boolean | null | undefined;
export type EventProps = Record<string, PropValue>;

let client: PostHog | null = null;
let initialized = false;

/**
 * The PostHog client, or null when analytics is switched off.
 *
 * Absent `POSTHOG_API_KEY` this is a hard no-op: self-hosted instances send nothing at
 * all, which is what the README promises. Resolved lazily so importing this package
 * never has a side effect.
 */
function getClient(): PostHog | null {
  if (initialized) return client;
  initialized = true;
  const env = getEnv();
  if (!env.POSTHOG_API_KEY) return null;
  client = new PostHog(env.POSTHOG_API_KEY, {
    host: env.POSTHOG_HOST,
    // Batch, but don't sit on events for long — these are low-volume server events.
    flushAt: 20,
    flushInterval: 10_000,
  });
  log.info({ host: env.POSTHOG_HOST }, 'analytics enabled');
  return client;
}

/**
 * Strip anything not explicitly allowed.
 *
 * This is the privacy boundary, not a formatting nicety: it is what makes it structurally
 * impossible for a call site to leak message content, a thread title, a search query, or
 * a Discord user id — an unlisted key is dropped, and a listed key holding a long or
 * non-scalar value is dropped too.
 */
export function sanitize(props: EventProps | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED_PROPS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.length <= MAX_STRING_LEN) out[key] = value;
  }
  return out;
}

/**
 * Record one server-scoped product event.
 *
 * `distinct_id` is the Discord **guild** id — never a user id. Fire-and-forget: analytics
 * must never fail, slow, or throw into a bot event handler.
 */
export function capture(event: DejavueEvent, guildId: string, props?: EventProps): void {
  const ph = getClient();
  if (!ph || !guildId) return;
  try {
    ph.capture({
      distinctId: guildId,
      event,
      properties: { ...sanitize(props), $groups: { guild: guildId } },
      groups: { guild: guildId },
    });
  } catch (err) {
    log.warn({ err, event }, 'analytics capture failed');
  }
}

/** Flush pending events and stop the client. Call from the graceful-shutdown path. */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    log.warn({ err }, 'analytics shutdown failed');
  }
}
