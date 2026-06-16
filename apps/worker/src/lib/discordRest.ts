import { REST } from 'discord.js';
import { requireEnv } from '@dejavue/core';

// REST-only Discord access for the worker (no gateway). Used by backfill to
// paginate forum history and fetch starter messages. discord.js's REST queue
// handles 429s / Retry-After.
let _rest: REST | undefined;

function rest(): REST {
  if (!_rest) _rest = new REST({ version: '10' }).setToken(requireEnv('DISCORD_TOKEN'));
  return _rest;
}

export interface RawThread {
  id: string;
  name: string;
  parent_id?: string;
  thread_metadata?: { archive_timestamp?: string };
  applied_tags?: string[];
}

export async function fetchActiveGuildThreads(guildId: string): Promise<RawThread[]> {
  const res = (await rest().get(`/guilds/${guildId}/threads/active`)) as { threads?: RawThread[] };
  return res.threads ?? [];
}

export async function fetchArchivedPublicThreads(
  channelId: string,
  before?: string,
): Promise<{ threads: RawThread[]; hasMore: boolean }> {
  const query = new URLSearchParams({ limit: '100' });
  if (before) query.set('before', before);
  const res = (await rest().get(`/channels/${channelId}/threads/archived/public`, { query })) as {
    threads?: RawThread[];
    has_more?: boolean;
  };
  return { threads: res.threads ?? [], hasMore: res.has_more ?? false };
}

export interface RawMessage {
  id: string;
  content: string;
  author?: { id: string };
}

/** A forum post's starter message shares the thread's id. */
export async function fetchStarterMessage(threadId: string): Promise<RawMessage | null> {
  try {
    return (await rest().get(`/channels/${threadId}/messages/${threadId}`)) as RawMessage;
  } catch {
    return null;
  }
}

export async function postMessage(channelId: string, content: string): Promise<void> {
  await rest().post(`/channels/${channelId}/messages`, { body: { content } });
}
