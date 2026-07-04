import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  type RoleSelectMenuInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  activeForumChannels,
  APPROX_CREDITS_PER_FEATURE,
  customSimilarity,
  dedupSettingLabel,
  getEnv,
} from '@dejavue/core';
import {
  type ChannelSync,
  channelMode,
  checkQuota,
  type QuotaStatus,
  countByStatus,
  countIndexedMessages,
  deleteChannelSync,
  deleteChannelTopic,
  ensureGuildConfig,
  getDb,
  getGuildConfig,
  listActiveReindexJobs,
  listChannelSync,
  recordPurchaseIntent,
  resolutionStats,
  topHelpers,
  getTopClusters,
  updateGuildConfig,
} from '@dejavue/db';
import { refreshAllChannelTopics } from './channelFit';
import { COLOR } from './embeds';
import { runFaq, runGaps } from './generate';
import { imprintComplete, isPubliclyLive } from './kbGate';
import { eph } from './reply';
import { allTargets, startReindex } from './reindexTrigger';
import { getGuildTier, limitsFor } from './tier';
import { upsellPayload } from './upsell';

const PREFIX = 'dv:';
export const isHubInteraction = (id: string): boolean => id.startsWith(PREFIX);

const ID = {
  // settings hub
  nudges: 'dv:set:nudges',
  fit: 'dv:set:fit',
  guard: 'dv:set:guard',
  guardac: 'dv:set:guardac',
  gsens: 'dv:set:gsens',
  dedup: 'dv:set:dedup',
  dedupModal: 'dv:set:dedupmodal',
  nudgehours: 'dv:set:nudgehours',
  nudgerole: 'dv:set:nudgerole',
  // setup (channel) hub
  reindexAll: 'dv:setup:reindex',
  demo: 'dv:setup:demo',
  remove: 'dv:setup:remove',
  // insights
  gaps: 'dv:ins:gaps',
  faq: 'dv:ins:faq',
} as const;

const isAdmin = (i: { memberPermissions?: { has(p: bigint): boolean } | null }): boolean =>
  !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

const sinceLabel = (ms: number): string => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

// ---------------------------------------------------------------------------
// Settings hub — stale nudges, channel-fit, off-topic guard (all Plus)
// ---------------------------------------------------------------------------

function toggleBtn(id: string, label: string, on: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
}

export async function renderSettingsHub(guildId: string): Promise<BaseMessageOptions> {
  const cfg = await ensureGuildConfig(getDb(), guildId);
  const onOff = (b: boolean): string => (b ? 'on' : 'off');
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue settings')
    .setDescription('Automated helpers for your channels. These are **Plus** features.')
    .addFields(
      {
        name: 'Stale-question nudges',
        value: cfg.nudgeEnabled
          ? `on · after ${cfg.nudgeAfterHours}h${cfg.nudgeHelperRoleId ? ` → <@&${cfg.nudgeHelperRoleId}>` : ''}`
          : 'off',
      },
      { name: 'Channel-fit suggestions', value: onOff(cfg.channelFitCheck), inline: true },
      {
        name: 'Off-topic guard',
        value: cfg.guardEnabled
          ? `on · ${cfg.guardAutoClose ? 'auto-close · ' : ''}${cfg.guardSensitivity}`
          : 'off',
        inline: true,
      },
      { name: 'Duplicate suggestions', value: dedupSettingLabel(cfg.dedupSensitivity), inline: true },
    );
  const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
    toggleBtn(ID.nudges, `Nudges: ${onOff(cfg.nudgeEnabled)}`, cfg.nudgeEnabled),
    toggleBtn(ID.fit, `Fit-check: ${onOff(cfg.channelFitCheck)}`, cfg.channelFitCheck),
    toggleBtn(ID.guard, `Guard: ${onOff(cfg.guardEnabled)}`, cfg.guardEnabled),
    toggleBtn(ID.guardac, `Auto-close: ${onOff(cfg.guardAutoClose)}`, cfg.guardAutoClose),
  );
  const sens = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(ID.gsens)
      .setPlaceholder(`Guard sensitivity: ${cfg.guardSensitivity}`)
      .addOptions(
        { label: 'Guard: low — only the most obvious', value: 'low', default: cfg.guardSensitivity === 'low' },
        { label: 'Guard: medium — balanced', value: 'medium', default: cfg.guardSensitivity === 'medium' },
        { label: 'Guard: high — flag aggressively', value: 'high', default: cfg.guardSensitivity === 'high' },
      ),
  );
  const dedupIsCustom = customSimilarity(cfg.dedupSensitivity) !== undefined;
  const dedup = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(ID.dedup)
      .setPlaceholder(`Duplicate suggestions: ${dedupSettingLabel(cfg.dedupSensitivity)}`)
      .addOptions(
        { label: 'Duplicates: low — only near-identical reposts', value: 'low', default: cfg.dedupSensitivity === 'low' },
        { label: 'Duplicates: medium — balanced', value: 'medium', default: cfg.dedupSensitivity === 'medium' },
        { label: 'Duplicates: high — also flag loosely-related', value: 'high', default: cfg.dedupSensitivity === 'high' },
        {
          label: dedupIsCustom
            ? `Duplicates: ${dedupSettingLabel(cfg.dedupSensitivity)} — change…`
            : 'Duplicates: custom — type an exact match %…',
          value: 'custom',
          default: dedupIsCustom,
        },
      ),
  );
  const hours = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(ID.nudgehours)
      .setPlaceholder(`Nudge after: ${cfg.nudgeAfterHours}h`)
      .addOptions(
        [6, 12, 24, 48, 72].map((h) => ({
          label: `Nudge after ${h}h`,
          value: String(h),
          default: cfg.nudgeAfterHours === h,
        })),
      ),
  );
  const role = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(ID.nudgerole)
      .setPlaceholder('Helper role to ping (clear = none)')
      .setMinValues(0)
      .setMaxValues(1),
  );
  return { embeds: [embed], components: [toggles, sens, dedup, hours, role] };
}

/** `/dejavue settings` entry. */
export async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change settings.'));
    return;
  }
  const limits = limitsFor(await getGuildTier(interaction.guildId!));
  if (!limits.semanticSearch) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Settings are Plus features',
        description:
          'Stale-question nudges, channel-fit suggestions and the off-topic guard are part of **Plus**.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ ...(await renderSettingsHub(interaction.guildId!)), flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Setup (channel) hub — status + per-channel freshness + remove / reindex / demo
// ---------------------------------------------------------------------------

function staleReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'cap':
      return 'index full';
    case 'gap':
      return 'catching up';
    case 'delete':
    case 'edit':
      return 'syncing changes';
    default:
      return 'behind';
  }
}

function channelSyncDisplay(
  sync: ChannelSync | undefined,
  live: { processed: number; total: number } | undefined,
): string {
  if (live) {
    const pct = live.total > 0 ? ` ${Math.round((live.processed / live.total) * 100)}%` : '';
    return `⏳ reindexing…${pct}`;
  }
  if (!sync || sync.state === 'never') return '⛔ not yet indexed';
  if (sync.state === 'reindexing') return '⏳ reindexing…';
  if (sync.state === 'stale') return `⚠️ ${staleReasonLabel(sync.staleReason)}`;
  const when = sync.lastReindexAt ? `, reindexed ${sinceLabel(sync.lastReindexAt.getTime())} ago` : '';
  return `✅ up to date · ${sync.indexedMessageCount.toLocaleString()} msgs${when}`;
}

export async function renderSetupHub(guild: Guild): Promise<BaseMessageOptions> {
  const db = getDb();
  const guildId = guild.id;
  const env = getEnv();
  const cfg = await getGuildConfig(db, guildId);
  const tier = await getGuildTier(guildId);
  const limits = limitsFor(tier);
  const counts = await countByStatus(db, guildId);
  const indexed = await countIndexedMessages(db, guildId);
  const indexCap = limits.indexCap;
  const atCap = Number.isFinite(indexCap) && indexed >= indexCap;
  const kbUrl = cfg?.kbSlug ? `https://${cfg.kbSlug}.${env.KB_BASE_DOMAIN}` : null;
  const channelCap = Number.isFinite(limits.maxForumChannels) ? String(limits.maxForumChannels) : '∞';
  // Legacy KBs that went public before the imprint gate existed get a nag here.
  const imprintWarn =
    cfg && isPubliclyLive(cfg) && !imprintComplete(cfg.kbImprint)
      ? '\n⚠️ **Imprint incomplete** — public sites must name an operator and contact. Add them in `/dejavue customize`.'
      : '';

  const syncMap = new Map((await listChannelSync(db, guildId)).map((r) => [r.channelId, r]));
  const liveMap = new Map(
    (await listActiveReindexJobs(db, guildId)).map((j) => [j.channelId, { processed: j.processed, total: j.total }]),
  );
  const line = (id: string, suffix = ''): string =>
    `${channelSyncDisplay(syncMap.get(id), liveMap.get(id))}\n<#${id}>${suffix}`;
  // Channels past the tier's cap (e.g. after a downgrade) stay configured but
  // inactive — the same first-N rule the event guards enforce (isMonitoredForum).
  const activeForums = new Set(
    activeForumChannels(cfg?.forumChannelIds ?? [], limits.maxForumChannels),
  );
  const forumLine = (id: string): string => {
    if (!activeForums.has(id)) return `💤 inactive — over the **${tier}** channel cap\n<#${id}>`;
    return line(id, channelMode(cfg, id) === 'knowledge' ? ' _(knowledge)_' : '');
  };

  const indexValue = `${indexed.toLocaleString()} / ${Number.isFinite(indexCap) ? indexCap.toLocaleString() : '∞'} messages${atCap ? '\n⚠️ **Index full** — reindex or remove a channel to free space.' : ''}`;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue — channels & status')
    .addFields(
      { name: 'Tier', value: tier, inline: true },
      { name: 'Indexed', value: indexValue, inline: true },
      { name: 'Embedding model', value: cfg?.embeddingModel ?? 'bge-small-en-v1.5', inline: true },
      ...((limits.aiDrafts || limits.generative)
        ? [
            {
              name: 'AI credits (month)',
              value: creditUsageField(await checkQuota(db, guildId, limits.monthlyCredits)),
              inline: false,
            },
          ]
        : []),
      {
        name: `Forums (${cfg?.forumChannelIds.length ?? 0} / ${channelCap})`,
        value: cfg?.forumChannelIds.length
          ? cfg.forumChannelIds.map(forumLine).join('\n')
          : '_none — `/dejavue setup #forum mode`_',
      },
      {
        name: `Tracked channels (${cfg?.trackedChannelIds.length ?? 0})`,
        value: cfg?.trackedChannelIds.length
          ? cfg.trackedChannelIds.map((id) => line(id)).join('\n')
          : '_none — `/dejavue setup #channel`_',
      },
      {
        name: 'Public site',
        value: cfg?.kbPublishOptIn && kbUrl ? `on — ${kbUrl}${imprintWarn}` : cfg?.kbPublishOptIn ? `on — _set a slug in_ \`/dejavue customize\`${imprintWarn}` : 'off — _turn on in_ `/dejavue customize`',
      },
    );
  if (limits.mcp && kbUrl) embed.addFields({ name: 'MCP (Max)', value: `\`${kbUrl}/mcp\`` });
  embed.setFooter({ text: 'Add: /dejavue setup #channel · Re-scan one: /dejavue rescan #channel' });

  const monitored = [...(cfg?.forumChannelIds ?? []), ...(cfg?.trackedChannelIds ?? [])];
  const removeRows =
    monitored.length > 0
      ? [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(ID.remove)
              .setPlaceholder('Remove a channel…')
              .addOptions(
                monitored.slice(0, 25).map((id) => {
                  const ch = guild.channels.cache.get(id) as GuildBasedChannel | undefined;
                  return {
                    label: (ch?.name ?? id).slice(0, 100),
                    value: id,
                    description: 'Stop monitoring this channel',
                  };
                }),
              ),
          ),
        ]
      : [];
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ID.reindexAll).setLabel('Reindex all').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID.demo).setLabel('Create demo').setEmoji('✨').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [...removeRows, actionRow] };
}

// ---------------------------------------------------------------------------
// Insights — stats + analytics + buttons to build gaps / FAQ
// ---------------------------------------------------------------------------

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const h = seconds / 3600;
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

export async function handleInsights(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  const counts = await countByStatus(db, guildId);
  const total = counts.open + counts.solved + counts.unsolved;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue insights')
    .addFields(
      { name: 'Solved / total', value: `${counts.solved} / ${total}`, inline: true },
      { name: 'Open', value: String(counts.open), inline: true },
      { name: 'Unsolved', value: String(counts.unsolved), inline: true },
    );

  if (limits.analytics === 'full') {
    const [stats, helpers] = await Promise.all([resolutionStats(db, guildId), topHelpers(db, guildId, 5)]);
    embed.addFields(
      { name: 'Resolution rate', value: `${Math.round(stats.rate * 100)}% (${stats.solved}/${stats.total})`, inline: true },
      { name: 'Avg time to resolve', value: formatDuration(stats.avgTtrSeconds), inline: true },
      { name: 'Top helpers', value: helpers.length ? helpers.map((h) => `<@${h.userId}> — ${h.solved}`).join('\n') : '—' },
    );
  } else {
    embed.addFields({ name: 'Analytics', value: 'Resolution rate, top helpers & most-asked topics are a **Plus** feature.' });
  }
  let quota: QuotaStatus | undefined;
  if (limits.aiDrafts || limits.generative) {
    quota = await checkQuota(db, guildId, limits.monthlyCredits);
    embed.addFields({ name: 'AI credits (month)', value: creditUsageField(quota), inline: false });
    if (!quota.allowed) {
      embed.addFields({
        name: '⛔ Out of AI credits',
        value: 'AI features pause until the reset on the 1st (UTC). Top up below to keep going.',
      });
    } else if (quota.limitCredits > 0 && quota.usedCredits / quota.limitCredits >= 0.8) {
      embed.addFields({
        name: '⚠️ Running low',
        value: `${quota.remainingCredits} credits left — they reset on the 1st (UTC).`,
      });
    }
  }
  if (limits.generative) {
    const top = await getTopClusters(db, guildId, 5);
    if (top.length)
      embed.addFields({ name: 'Most-asked topics', value: top.map((c) => `• ${c.label ?? c.representativeText ?? 'topic'} (${c.size})`).join('\n') });
  }
  if (!limits.removeBranding) embed.setFooter({ text: 'Powered by Dejavue' });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (limits.generative) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ID.gaps).setLabel('Knowledge gaps').setEmoji('🧩').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.faq).setLabel('Auto-FAQ').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  // Out of credits → native Premium buttons: top-up, and Max for non-Max guilds.
  if (quota && !quota.allowed) {
    const env = getEnv();
    // One-time purchase → user-owned entitlement; remember the guild before the button.
    if (env.SKU_TOPUP) {
      await recordPurchaseIntent(db, { userId: interaction.user.id, skuId: env.SKU_TOPUP, guildId });
    }
    const skus = [env.SKU_TOPUP, limits.mcp ? undefined : env.SKU_MAX].filter(
      (s): s is string => Boolean(s),
    );
    if (skus.length > 0) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          skus.map((sku) => new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(sku)),
        ),
      );
    }
  }
  await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
}

/** Render `▰▰▰▰▰▰▱▱▱▱ 620 / 1,000 credits (+250 top-up) · ≈ 470 drafts left`. */
function creditUsageField(q: QuotaStatus): string {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const pct = q.limitCredits > 0 ? Math.min(1, q.usedCredits / q.limitCredits) : 1;
  const filled = Math.round(pct * 10);
  const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);
  const topUp = q.topUpCredits > 0 ? ` (+${fmt(q.topUpCredits)} top-up)` : '';
  const draftsLeft = Math.floor(q.remainingCredits / APPROX_CREDITS_PER_FEATURE.draft);
  return `${bar} ${fmt(q.usedCredits)} / ${fmt(q.limitCredits)} credits${topUp} · ≈ ${fmt(draftsLeft)} drafted answers left`;
}

// ---------------------------------------------------------------------------
// Interaction routing (buttons / string selects / role selects)
// ---------------------------------------------------------------------------

async function refreshTopics(interaction: ButtonInteraction): Promise<void> {
  const cfg = await getGuildConfig(getDb(), interaction.guildId!);
  if (cfg && interaction.guild) await refreshAllChannelTopics(interaction.guild, cfg).catch(() => undefined);
}

export async function handleHubButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  const guildId = interaction.guildId!;
  const db = getDb();

  // Insights generation buttons (Pro-gated inside runGaps/runFaq).
  if (id === ID.gaps) return void (await runGaps(interaction));
  if (id === ID.faq) return void (await runFaq(interaction));

  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }

  // Settings toggles → flip + re-render the hub in place.
  const cfg = await ensureGuildConfig(db, guildId);
  if (id === ID.nudges) {
    await updateGuildConfig(db, guildId, { nudgeEnabled: !cfg.nudgeEnabled });
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.fit) {
    const next = !cfg.channelFitCheck;
    await updateGuildConfig(db, guildId, { channelFitCheck: next });
    if (next) await refreshTopics(interaction);
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.guard) {
    const next = !cfg.guardEnabled;
    await updateGuildConfig(db, guildId, { guardEnabled: next });
    if (next) await refreshTopics(interaction);
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.guardac) {
    await updateGuildConfig(db, guildId, { guardAutoClose: !cfg.guardAutoClose });
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }

  // Setup hub actions.
  if (id === ID.reindexAll) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targets = allTargets({ forumChannelIds: cfg.forumChannelIds, trackedChannelIds: cfg.trackedChannelIds });
    if (targets.length === 0) {
      await interaction.editReply('Nothing to reindex yet.');
      return;
    }
    const { started, skipped } = await startReindex(interaction, targets);
    const lines = [];
    if (started.length) lines.push(`🔄 Reindexing ${started.join(', ')} — watch the live messages here.`);
    if (skipped.length) lines.push(`⏭️ Already running: ${skipped.join(', ')}.`);
    await interaction.editReply(lines.join('\n') || 'Nothing to reindex.');
    return;
  }
  if (id === ID.demo) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guild) {
      await interaction.editReply('Run this in a server.');
      return;
    }
    try {
      const { runDemo } = await import('./demo');
      const res = await runDemo(interaction.guild);
      await interaction.editReply(
        `✅ Created <#${res.forumId}> with **${res.solved}** solved examples and **${res.fresh}** fresh questions.`,
      );
    } catch {
      await interaction.editReply('Demo failed — I need permission to create a forum channel.');
    }
    return;
  }
}

export async function handleHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }
  const id = interaction.customId;
  const guildId = interaction.guildId!;
  const db = getDb();
  const value = interaction.values[0];

  if (id === ID.gsens && value) {
    await updateGuildConfig(db, guildId, { guardSensitivity: value as 'low' | 'medium' | 'high' });
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.dedup && value) {
    if (value === 'custom') {
      // Ask for the exact minimum match % in a modal instead of storing 'custom'.
      const cfg = await getGuildConfig(db, guildId);
      const current = customSimilarity(cfg?.dedupSensitivity);
      const input = new TextInputBuilder()
        .setCustomId('threshold')
        .setLabel('Minimum match % (0–100)')
        .setPlaceholder('e.g. 65 — only suggest duplicates at least 65% similar')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3);
      if (current !== undefined) input.setValue(String(Math.round(current * 100)));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(ID.dedupModal)
          .setTitle('Custom duplicate threshold')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      );
      return;
    }
    await updateGuildConfig(db, guildId, { dedupSensitivity: value as 'low' | 'medium' | 'high' });
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.nudgehours && value) {
    await updateGuildConfig(db, guildId, { nudgeAfterHours: Number(value) });
    return void (await interaction.update(await renderSettingsHub(guildId)));
  }
  if (id === ID.remove && value) {
    const cfg = await getGuildConfig(db, guildId);
    if (cfg?.trackedChannelIds.includes(value)) {
      await updateGuildConfig(db, guildId, {
        trackedChannelIds: cfg.trackedChannelIds.filter((c) => c !== value),
      });
    } else if (cfg?.forumChannelIds.includes(value)) {
      const channelModes = { ...(cfg.channelModes ?? {}) };
      delete channelModes[value];
      await updateGuildConfig(db, guildId, {
        forumChannelIds: cfg.forumChannelIds.filter((c) => c !== value),
        channelModes,
      });
      await deleteChannelTopic(db, guildId, value).catch(() => undefined);
    }
    await deleteChannelSync(db, guildId, value).catch(() => undefined);
    if (interaction.guild) await interaction.update(await renderSetupHub(interaction.guild));
  }
}

/** Modal submits from the settings hub (currently: the custom dedup threshold). */
export async function handleHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== ID.dedupModal) return;
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }
  const raw = interaction.fields.getTextInputValue('threshold').trim();
  const similarity = customSimilarity(raw);
  if (similarity === undefined) {
    await interaction.reply(eph(`\`${raw}\` isn't a valid threshold — enter a whole number from 0 to 100.`));
    return;
  }
  const guildId = interaction.guildId!;
  await updateGuildConfig(getDb(), guildId, {
    dedupSensitivity: String(Math.round(similarity * 100)),
  });
  // The modal came from the settings-hub select, so refresh that message in place.
  if (interaction.isFromMessage()) {
    await interaction.update(await renderSettingsHub(guildId));
  } else {
    await interaction.reply(eph(`✅ Duplicate suggestions now require ≥${Math.round(similarity * 100)}% match.`));
  }
}

export async function handleHubRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== ID.nudgerole) return;
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }
  const roleId = interaction.values[0] ?? null;
  await updateGuildConfig(getDb(), interaction.guildId!, { nudgeHelperRoleId: roleId });
  await interaction.update(await renderSettingsHub(interaction.guildId!));
}
