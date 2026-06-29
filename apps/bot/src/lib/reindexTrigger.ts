import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { reindexProgressEmbed } from '@dejavue/core';
import {
  createReindexJob,
  ensureChannelSync,
  getActiveReindexJob,
  getDb,
  setReindexing,
} from '@dejavue/db';
import { enqueueReindexChannel } from '@dejavue/queue';

export type ReindexTarget = { id: string; kind: 'forum' | 'tracked' };

/**
 * Kick a durable reindex for each target and post the single live-progress message the
 * worker keeps editing. Shared by `/dejavue rescan` and the setup hub's "Reindex all"
 * button. Returns the channels actually started + skipped (already running).
 */
export async function startReindex(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  targets: ReindexTarget[],
): Promise<{ started: string[]; skipped: string[] }> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const channel = interaction.channel;
  const started: string[] = [];
  const skipped: string[] = [];

  for (const t of targets) {
    if (await getActiveReindexJob(db, guildId, t.id)) {
      skipped.push(`<#${t.id}>`);
      continue;
    }
    const syncKind = t.kind === 'forum' ? ('forum' as const) : ('channel' as const);
    await ensureChannelSync(db, guildId, t.id, syncKind);
    await setReindexing(db, guildId, t.id, syncKind);

    let statusChannelId: string | null = null;
    let statusMessageId: string | null = null;
    try {
      if (channel?.isSendable()) {
        const e = reindexProgressEmbed({ channelLabel: `<#${t.id}>`, kind: t.kind, phase: 'queued' });
        const msg = await channel.send({
          embeds: [new EmbedBuilder().setTitle(e.title).setDescription(e.description).setColor(e.color)],
        });
        statusChannelId = msg.channelId;
        statusMessageId = msg.id;
      }
    } catch {
      /* no send perms — reindex still runs without a live message */
    }
    const job = await createReindexJob(db, {
      guildId,
      channelId: t.id,
      kind: t.kind,
      statusChannelId,
      statusMessageId,
    });
    await enqueueReindexChannel({ reindexJobId: job.id });
    started.push(`<#${t.id}>`);
  }
  return { started, skipped };
}

/** All monitored channels as reindex targets (forums + tracked text channels). */
export function allTargets(cfg: {
  forumChannelIds: string[];
  trackedChannelIds: string[];
}): ReindexTarget[] {
  return [
    ...cfg.forumChannelIds.map((id) => ({ id, kind: 'forum' as const })),
    ...cfg.trackedChannelIds.map((id) => ({ id, kind: 'tracked' as const })),
  ];
}
