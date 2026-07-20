import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { backfillProgressEmbed, type ProgressEmbed, reindexProgressEmbed } from '@dejavue/core';
import {
  createBackfillJob,
  createReindexJob,
  ensureChannelSync,
  getActiveBackfillJob,
  getActiveReindexJob,
  getDb,
  setReindexing,
} from '@dejavue/db';
import { enqueueBackfill, enqueueReindexChannel } from '@dejavue/queue';

export type ReindexTarget = { id: string; kind: 'forum' | 'tracked' };

/** Post the initial "queued" embed the worker will keep editing (null ids when not sendable). */
async function postProgressMessage(
  channel: (ChatInputCommandInteraction | ButtonInteraction)['channel'],
  embed: ProgressEmbed,
): Promise<{ statusChannelId: string | null; statusMessageId: string | null }> {
  try {
    if (channel?.isSendable()) {
      const msg = await channel.send({
        embeds: [new EmbedBuilder().setTitle(embed.title).setDescription(embed.description).setColor(embed.color)],
      });
      return { statusChannelId: msg.channelId, statusMessageId: msg.id };
    }
  } catch {
    /* no send perms — the job still runs without a live message */
  }
  return { statusChannelId: null, statusMessageId: null };
}

/**
 * Kick the automatic first-setup history import for a forum, with a live progress
 * message in the channel the admin ran /dejavue setup from (the setup reply itself is
 * ephemeral, which the worker can't edit). Skips when an import is already running.
 */
export async function startForumImport(
  interaction: ChatInputCommandInteraction,
  forumId: string,
): Promise<{ resumed: boolean; posted: boolean }> {
  const db = getDb();
  const guildId = interaction.guildId!;
  if (await getActiveBackfillJob(db, guildId, forumId)) return { resumed: true, posted: false };

  const { statusChannelId, statusMessageId } = await postProgressMessage(
    interaction.channel,
    backfillProgressEmbed({ channelLabel: `<#${forumId}>`, phase: 'queued' }),
  );
  const job = await createBackfillJob(db, {
    guildId,
    channelId: forumId,
    entitlementId: null,
    statusChannelId,
    statusMessageId,
  });
  await enqueueBackfill({ backfillJobId: job.id });
  return { resumed: false, posted: statusMessageId != null };
}

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

    const { statusChannelId, statusMessageId } = await postProgressMessage(
      channel,
      reindexProgressEmbed({ channelLabel: `<#${t.id}>`, kind: t.kind, phase: 'queued' }),
    );
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
