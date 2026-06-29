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

/** Fetch a channel's basic info (used to keep the denormalized channel name current). */
export async function fetchChannelInfo(channelId: string): Promise<{ name?: string } | null> {
  try {
    return (await rest().get(`/channels/${channelId}`)) as { name?: string };
  } catch {
    return null;
  }
}

export async function postMessage(channelId: string, content: string): Promise<string | null> {
  const res = (await rest().post(`/channels/${channelId}/messages`, { body: { content } })) as {
    id?: string;
  };
  return res?.id ?? null;
}

/** Discord message embed (raw REST shape). */
export interface RawEmbed {
  title?: string;
  description?: string;
  color?: number;
}

/**
 * Edit a message we previously posted — the live-progress mechanism. REST works
 * past the 15-minute interaction-token window, so a long reindex can keep updating
 * one message. Best-effort: a 404 (user deleted it) is the caller's to swallow.
 */
export async function patchMessage(
  channelId: string,
  messageId: string,
  body: { content?: string; embeds?: RawEmbed[] },
): Promise<void> {
  await rest().patch(`/channels/${channelId}/messages/${messageId}`, { body });
}

export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  await rest().delete(`/channels/${channelId}/messages/${messageId}`);
}

export interface RawChannelMessage {
  id: string;
  content: string;
  author?: { id: string; bot?: boolean };
  timestamp: string;
  attachments?: {
    id: string;
    url: string;
    filename: string;
    content_type?: string;
    size?: number;
    width?: number;
    height?: number;
  }[];
  reactions?: { count: number }[];
}

/**
 * Page a normal text channel's history (newest-first, 100 at a time). Mirrors the
 * bot's channel.messages.fetch loop but over REST so the worker can rescan a tracked
 * channel's FULL history without a gateway.
 */
export async function fetchChannelMessages(
  channelId: string,
  before?: string,
): Promise<RawChannelMessage[]> {
  const query = new URLSearchParams({ limit: '100' });
  if (before) query.set('before', before);
  const res = (await rest().get(`/channels/${channelId}/messages`, {
    query,
  })) as RawChannelMessage[];
  return res ?? [];
}
