import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { genProgressEmbed, getEnv } from '@dejavue/core';
import {
  checkQuota,
  generationStatus,
  getDb,
  getFaqEntries,
  getGuildConfig,
  getTopClusters,
  markGenerationStarted,
  recordPurchaseIntent,
} from '@dejavue/db';
import { enqueueClusterGaps, enqueueRegenFaq } from '@dejavue/queue';
import { COLOR, threadUrl } from './embeds';
import { getGuildTier, limitsFor } from './tier';
import { upsellPayload } from './upsell';

/** A generation is re-triggered only if none ran in the last 5 minutes and one isn't
 *  already in flight; an in-flight run "expires" after 5 minutes so a stuck run never
 *  blocks forever. */
export const GEN_OPTS = { throttleMs: 5 * 60_000, maxRunMs: 5 * 60_000 };

/** Slash command or a hub button — both can defer/fetch/edit a reply. */
type Repliable = ChatInputCommandInteraction | ButtonInteraction;

const wrap = (e: { title: string; description: string; color: number }): EmbedBuilder =>
  new EmbedBuilder().setTitle(e.title).setDescription(e.description).setColor(e.color);

/**
 * When the monthly credits are exhausted, reply with a top-up upsell instead of
 * enqueueing a job that would immediately no-op. Returns true when blocked.
 */
async function blockedOnCredits(
  interaction: Repliable,
  guildId: string,
  baseCredits: number,
): Promise<boolean> {
  const quota = await checkQuota(getDb(), guildId, baseCredits);
  if (quota.allowed) return false;
  // One-time purchase → user-owned entitlement; remember the guild before the button.
  const topUpSku = getEnv().SKU_TOPUP;
  if (topUpSku) {
    await recordPurchaseIntent(getDb(), { userId: interaction.user.id, skuId: topUpSku, guildId });
  }
  await interaction.reply({
    ...upsellPayload({
      title: 'Out of AI credits for this month',
      description:
        'This run needs AI credits, and the monthly budget is used up. Credits reset on the 1st (UTC) — or top up to keep going now.',
      skuId: getEnv().SKU_TOPUP,
    }),
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

/**
 * Cluster recurring questions and render the result into ONE live message the worker
 * keeps editing (no "run again"). Shared by `/dejavue insights` and its hub button.
 */
export async function runGaps(interaction: Repliable): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  if (!limits.generative) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Knowledge-gap clustering is a Pro feature',
        description:
          'Group recurring unanswered questions so you know exactly which docs to write. Upgrade to **Pro**.',
        skuId: getEnv().SKU_PRO,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (await blockedOnCredits(interaction, guildId, limits.monthlyCredits)) return;
  await interaction.deferReply();
  const cfg = await getGuildConfig(db, guildId);
  const st = generationStatus(cfg, 'cluster', GEN_OPTS);
  if (!st.inFlight && !st.fresh) {
    await markGenerationStarted(db, guildId, 'cluster');
    const reply = await interaction.fetchReply();
    await enqueueClusterGaps({ guildId, progress: { channelId: reply.channelId, messageId: reply.id } });
    await interaction.editReply({ embeds: [wrap(genProgressEmbed({ kind: 'cluster', phase: 'queued' }))] });
    return;
  }
  const clusters = await getTopClusters(db, guildId, 10);
  const list = clusters
    .map((c) => {
      const first = c.memberThreadIds[0];
      const title = c.label ?? c.representativeText ?? 'topic';
      return first
        ? `• [${title}](${threadUrl(guildId, first)}) — ${c.size} asks`
        : `• ${title} — ${c.size} asks`;
    })
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Knowledge gaps')
    .setDescription(list || '_No clusters yet._');
  if (st.inFlight) embed.setFooter({ text: 'Still refreshing in the background…' });
  await interaction.editReply({ embeds: [embed] });
}

/** Generate/maintain the auto-FAQ, rendered into one live message. */
export async function runFaq(interaction: Repliable): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  if (!limits.generative) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Auto-FAQ is a Pro feature',
        description: 'Dejavue drafts and maintains a FAQ from your recurring questions. Upgrade to **Pro**.',
        skuId: getEnv().SKU_PRO,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (await blockedOnCredits(interaction, guildId, limits.monthlyCredits)) return;
  await interaction.deferReply();
  const cfg = await getGuildConfig(db, guildId);
  const st = generationStatus(cfg, 'faq', GEN_OPTS);
  if (!st.inFlight && !st.fresh) {
    await markGenerationStarted(db, guildId, 'faq');
    const reply = await interaction.fetchReply();
    await enqueueRegenFaq({ guildId, progress: { channelId: reply.channelId, messageId: reply.id } });
    await interaction.editReply({ embeds: [wrap(genProgressEmbed({ kind: 'faq', phase: 'queued' }))] });
    return;
  }
  const faqs = await getFaqEntries(db, guildId);
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Auto-FAQ');
  if (faqs.length === 0) embed.setDescription('_No FAQ entries yet._');
  else for (const f of faqs.slice(0, 8)) embed.addFields({ name: f.question.slice(0, 256), value: f.answer.slice(0, 1024) });
  if (st.inFlight) embed.setFooter({ text: 'Still refreshing in the background…' });
  await interaction.editReply({ embeds: [embed] });
}
