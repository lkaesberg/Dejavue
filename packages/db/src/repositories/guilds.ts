import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { guildConfig, type GuildConfig, type NewGuildConfig } from '../schema';

export type ChannelMode = 'question' | 'knowledge';

/**
 * Resolve a forum channel's mode. 'knowledge' channels are a pure archive (every
 * thread published, no answer-prompting/dedup); everything else is 'question'
 * (the classic Q&A workflow). Defaults to 'question' when unset.
 */
export function channelMode(
  cfg: Pick<GuildConfig, 'channelModes'> | null | undefined,
  channelId: string,
): ChannelMode {
  return cfg?.channelModes?.[channelId] === 'knowledge' ? 'knowledge' : 'question';
}

export async function getGuildConfig(
  db: Database,
  guildId: string,
): Promise<GuildConfig | undefined> {
  const [row] = await db
    .select()
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .limit(1);
  return row;
}

/** Get-or-create the config row for a guild. */
export async function ensureGuildConfig(db: Database, guildId: string): Promise<GuildConfig> {
  const [inserted] = await db
    .insert(guildConfig)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const existing = await getGuildConfig(db, guildId);
  if (!existing) throw new Error(`failed to ensure guild config for ${guildId}`);
  return existing;
}

export async function updateGuildConfig(
  db: Database,
  guildId: string,
  patch: Partial<Omit<NewGuildConfig, 'guildId' | 'createdAt'>>,
): Promise<GuildConfig | undefined> {
  const [row] = await db
    .update(guildConfig)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(guildConfig.guildId, guildId))
    .returning();
  return row;
}
