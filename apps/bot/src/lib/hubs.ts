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
  getEnv,
} from '@dejavue/core';
import {
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
  listActiveBackfillJobs,
  listActiveReindexJobs,
  listChannelSync,
  resolutionStats,
  topHelpers,
  getTopClusters,
  updateGuildConfig,
} from '@dejavue/db';
import { embeddingModelId } from '@dejavue/ai';
import { refreshAllChannelTopics } from './channelFit';
import { showBrandingFor } from './branding';
import { COLOR } from './embeds';
import { runFaq, runGaps } from './generate';
import { assertRowBudget, type HubCtx, hubCtx, type HubId, isHubAdmin, navRow } from './hubNav';
import { imprintComplete, isPubliclyLive } from './kbGate';
import { eph } from './reply';
import { allTargets, startReindex } from './reindexTrigger';
import {
  ctrl,
  DEFAULT_PAGE,
  isSettingsInteraction,
  PAGER_ID,
  pageOf,
  pagerRow,
  type SettingsPageId,
  settingsPage,
} from './settingsPages';
import { channelSyncDisplay, joinChannelLines, type LiveJobDisplay } from './syncDisplay';
import { getGuildTier, limitsFor } from './tier';
import { prepareTopUpSkus } from './topUp';
import { premiumButtonRows } from './upsell';

const PREFIX = 'dv:';
export const isHubInteraction = (id: string): boolean => id.startsWith(PREFIX);

/** Dashboard and insights controls. Settings ids are built by `ctrl()`. */
const ID = {
  // dashboard
  rescanAll: 'dv:d:rescan',
  demo: 'dv:d:demo',
  remove: 'dv:d:remove',
  // insights
  gaps: 'dv:i:gaps',
  faq: 'dv:i:faq',
} as const;

/** The custom dedup threshold modal. Carries its page so the hub re-renders in place. */
const DEDUP_MODAL_ID = ctrl('duplicates', 'custommodal');

const isAdmin = isHubAdmin;

export { hubCtx, type HubCtx };

// ---------------------------------------------------------------------------
// Settings hub — one page per feature, each explaining itself
// ---------------------------------------------------------------------------

export async function renderSettingsHub(
  guildId: string,
  page: SettingsPageId,
  ctx: HubCtx,
): Promise<BaseMessageOptions> {
  const cfg = await ensureGuildConfig(getDb(), guildId);
  const limits = limitsFor(await getGuildTier(guildId));
  const pageCtx = { brandingLocked: !limits.removeBranding };
  const def = settingsPage(page);

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${def.emoji} ${def.title}`)
    .setDescription(def.explain)
    .addFields(def.fields(cfg, pageCtx));

  const components = assertRowBudget(
    [pagerRow(page), ...def.rows(cfg, pageCtx), navRow('settings', { admin: ctx.admin })],
    `settings:${page}`,
  );
  return { embeds: [embed], components };
}

/** `/dejavue settings` entry. */
export async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change settings.'));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(
    await renderSettingsHub(interaction.guildId!, DEFAULT_PAGE, hubCtx(interaction)),
  );
}

// ---------------------------------------------------------------------------
// Dashboard — status + per-channel freshness + remove / re-scan / demo
// ---------------------------------------------------------------------------

export async function renderDashboard(guild: Guild, ctx: HubCtx): Promise<BaseMessageOptions> {
  const db = getDb();
  const guildId = guild.id;
  const env = getEnv();
  const cfg = await getGuildConfig(db, guildId);
  const tier = await getGuildTier(guildId);
  const limits = limitsFor(tier);
  const indexed = await countIndexedMessages(db, guildId);
  const indexCap = limits.indexCap;
  const atCap = Number.isFinite(indexCap) && indexed >= indexCap;
  const kbUrl = cfg?.kbSlug ? `https://${cfg.kbSlug}.${env.KB_BASE_DOMAIN}` : null;
  const channelCap = Number.isFinite(limits.maxForumChannels) ? String(limits.maxForumChannels) : '∞';
  // Legacy KBs that went public before the imprint gate existed get a nag here.
  const imprintWarn =
    cfg && isPubliclyLive(cfg) && !imprintComplete(cfg.kbImprint)
      ? '\n⚠️ **Imprint incomplete** — public sites must name an operator and contact. Add them in `/dejavue website`.'
      : '';

  const syncMap = new Map((await listChannelSync(db, guildId)).map((r) => [r.channelId, r]));
  // Live overlay: a running first-setup import or re-scan beats the stored sync state.
  const liveMap = new Map<string, LiveJobDisplay>();
  for (const j of await listActiveBackfillJobs(db, guildId)) {
    liveMap.set(j.channelId, { processed: j.processed, total: j.total, flavor: 'import' });
  }
  for (const j of await listActiveReindexJobs(db, guildId)) {
    liveMap.set(j.channelId, { processed: j.processed, total: j.total, flavor: 'rescan' });
  }
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

  const indexValue = `${indexed.toLocaleString()} / ${Number.isFinite(indexCap) ? indexCap.toLocaleString() : '∞'} messages${atCap ? '\n⚠️ **Index full** — re-scan or remove a channel to free space.' : ''}`;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏠 Dejavue — channels & status')
    .setDescription(
      'Everything I am watching in this server. Add a channel with `/dejavue setup #channel`, or use the buttons below to go anywhere else.',
    )
    .addFields(
      { name: 'Plan', value: tier, inline: true },
      { name: 'Indexed', value: indexValue, inline: true },
      // The RESOLVED model, not the stored override: those differ whenever a guild row
      // predates a model change, and showing the stale value is how this went unnoticed.
      { name: 'Embedding model', value: embeddingModelId(cfg?.embeddingModel), inline: true },
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
          ? joinChannelLines(cfg.forumChannelIds.map(forumLine))
          : '_none yet — `/dejavue setup #forum`_',
      },
      {
        name: `Tracked channels (${cfg?.trackedChannelIds.length ?? 0})`,
        value: cfg?.trackedChannelIds.length
          ? joinChannelLines(cfg.trackedChannelIds.map((id) => line(id)))
          : '_none yet — `/dejavue setup #channel`_',
      },
      {
        name: 'Public site',
        value: cfg?.kbPublishOptIn && kbUrl ? `on — ${kbUrl}${imprintWarn}` : cfg?.kbPublishOptIn ? `on — _set an address in_ \`/dejavue website\`${imprintWarn}` : 'off — _turn it on in_ `/dejavue website`',
      },
    );
  if (limits.mcp && kbUrl) embed.addFields({ name: 'MCP (Pro & Max)', value: `\`${kbUrl}/mcp\`` });
  embed.setFooter({ text: 'Add a channel: /dejavue setup #channel · Re-scan one: /dejavue rescan #channel' });

  const monitored = [...(cfg?.forumChannelIds ?? []), ...(cfg?.trackedChannelIds ?? [])];
  const removeRows =
    monitored.length > 0
      ? [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(ID.remove)
              .setPlaceholder('Stop watching a channel…')
              .addOptions(
                monitored.slice(0, 25).map((id) => {
                  const ch = guild.channels.cache.get(id) as GuildBasedChannel | undefined;
                  return {
                    label: (ch?.name ?? id).slice(0, 100),
                    value: id,
                    description: 'Remove it from the knowledge base',
                  };
                }),
              ),
          ),
        ]
      : [];
  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ID.rescanAll).setLabel('Re-scan all').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID.demo).setLabel('Create demo').setEmoji('✨').setStyle(ButtonStyle.Secondary),
  );
  return {
    embeds: [embed],
    components: assertRowBudget(
      [...removeRows, actionRow, navRow('dashboard', { admin: ctx.admin })],
      'dashboard',
    ),
  };
}

/** `/dejavue dashboard` entry. */
export async function handleDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to see the dashboard.'));
    return;
  }
  if (!interaction.guild) {
    await interaction.reply(eph('Run this in a server.'));
    return;
  }
  // Defer first: renderDashboard does several DB round-trips and could otherwise
  // blow Discord's 3s window into a hard "did not respond".
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(await renderDashboard(interaction.guild, hubCtx(interaction)));
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

export async function renderInsights(
  guildId: string,
  userId: string,
  ctx: HubCtx,
): Promise<BaseMessageOptions> {
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  const counts = await countByStatus(db, guildId);
  const total = counts.open + counts.solved + counts.unsolved;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('📈 Dejavue insights')
    .addFields(
      { name: 'Solved / total', value: `${counts.solved} / ${total}`, inline: true },
      { name: 'Open', value: String(counts.open), inline: true },
      { name: 'Unsolved', value: String(counts.unsolved), inline: true },
    );
  if (total === 0) {
    embed.setDescription(
      'No questions tracked yet — add a help channel with `/dejavue setup #channel`, or open `/dejavue dashboard` and hit **Create demo** to try it out.',
    );
  }

  // Analytics are aggregates over rows we already store — no per-guild cost, so every
  // tier gets them.
  const [stats, helpers] = await Promise.all([resolutionStats(db, guildId), topHelpers(db, guildId, 5)]);
  embed.addFields(
    { name: 'Resolution rate', value: `${Math.round(stats.rate * 100)}% (${stats.solved}/${stats.total})`, inline: true },
    { name: 'Avg time to resolve', value: formatDuration(stats.avgTtrSeconds), inline: true },
    { name: 'Top helpers', value: helpers.length ? helpers.map((h) => `<@${h.userId}> — ${h.solved}`).join('\n') : '—' },
  );
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
  if (await showBrandingFor(guildId)) embed.setFooter({ text: 'Powered by Dejavue' });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (limits.generative) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ID.gaps).setLabel('Knowledge gaps').setEmoji('🧩').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.faq).setLabel('Auto-FAQ').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  // Out of credits → native Premium buttons: the top-up ladder, plus Max for non-Max guilds.
  if (quota && !quota.allowed) {
    const env = getEnv();
    // One-time purchases are user-owned; remember the guild before showing the buttons.
    const topUpSkus = await prepareTopUpSkus(userId, guildId);
    const maxSku = limits.mcp ? undefined : env.SKU_MAX;
    const skus = [...topUpSkus, ...(maxSku ? [maxSku] : [])];
    if (skus.length > 0) components.push(...premiumButtonRows(skus));
  }
  components.push(navRow('insights', { admin: ctx.admin }));
  return { embeds: [embed], components: assertRowBudget(components, 'insights') };
}

export async function handleInsights(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(
    await renderInsights(interaction.guildId!, interaction.user.id, hubCtx(interaction)),
  );
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
// Stale components from an older deploy
// ---------------------------------------------------------------------------

/**
 * An admin can be holding an ephemeral hub built by the previous release. Its
 * custom ids no longer match anything, and a handler that just falls through
 * without acknowledging leaves Discord showing "This interaction failed" after
 * three seconds.
 *
 * Every handler below ends here instead. Ids from a known old hub re-render that
 * hub in place; anything else gets an ephemeral pointer. Keep this — it retires
 * the whole class of problem for every future id change, not just this one.
 */
const LEGACY_HUB: readonly [string, HubId][] = [
  ['dv:set:', 'settings'],
  ['dv:setup:', 'dashboard'],
  ['dv:ins:', 'insights'],
];

const isLegacyId = (customId: string): boolean =>
  LEGACY_HUB.some(([prefix]) => customId.startsWith(prefix));

type HubComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ModalSubmitInteraction;

/**
 * Edit the message the component sits on. A modal submitted from a standalone
 * modal has no message to edit, which is the one case this can't do.
 */
async function updateInPlace(
  interaction: HubComponentInteraction,
  payload: BaseMessageOptions & { content?: string },
): Promise<boolean> {
  if (interaction.isModalSubmit()) {
    if (!interaction.isFromMessage()) return false;
    await interaction.update(payload);
    return true;
  }
  await interaction.update(payload);
  return true;
}

async function handleStale(interaction: HubComponentInteraction): Promise<void> {
  const hub = LEGACY_HUB.find(([p]) => interaction.customId.startsWith(p))?.[1];
  const ctx = hubCtx(interaction);
  const guildId = interaction.guildId;

  if (hub && guildId) {
    // Only rebuild a hub this viewer is allowed to open — a member holding a
    // stale settings panel gets the pointer, not someone else's settings.
    const payload =
      hub === 'insights'
        ? await renderInsights(guildId, interaction.user.id, ctx)
        : !ctx.admin
          ? null
          : hub === 'settings'
            ? await renderSettingsHub(guildId, DEFAULT_PAGE, ctx)
            : interaction.guild
              ? await renderDashboard(interaction.guild, ctx)
              : null;
    if (
      payload &&
      (await updateInPlace(interaction, {
        ...payload,
        content: '_This panel was rebuilt — Dejavue updated since you opened it._',
      }))
    ) {
      return;
    }
  }
  await interaction.reply(
    eph('This panel is from an older version of Dejavue. Run `/dejavue dashboard` to open a fresh one.'),
  );
}

// ---------------------------------------------------------------------------
// Interaction routing (buttons / string selects / role selects / modals)
// ---------------------------------------------------------------------------

async function refreshTopics(interaction: ButtonInteraction): Promise<void> {
  const cfg = await getGuildConfig(getDb(), interaction.guildId!);
  if (cfg && interaction.guild) await refreshAllChannelTopics(interaction.guild, cfg).catch(() => undefined);
}

/** Apply a settings change, then redraw the page the control lives on. */
async function updateSettings(
  interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction,
  patch: Parameters<typeof updateGuildConfig>[2],
): Promise<void> {
  const guildId = interaction.guildId!;
  await updateGuildConfig(getDb(), guildId, patch);
  const page = pageOf(interaction.customId) ?? DEFAULT_PAGE;
  await interaction.update(await renderSettingsHub(guildId, page, hubCtx(interaction)));
}

export async function handleHubButton(interaction: ButtonInteraction): Promise<void> {
  const id = interaction.customId;
  const guildId = interaction.guildId!;
  const db = getDb();

  // Insights generation buttons (Pro-gated inside runGaps/runFaq) — before the
  // admin gate, since /dejavue insights is open to everyone.
  if (id === ID.gaps) return void (await runGaps(interaction));
  if (id === ID.faq) return void (await runFaq(interaction));

  // A pre-deploy id can never match below, and insights is open to everyone —
  // answer it here rather than letting the admin gate give a misleading reason.
  if (isLegacyId(id)) return void (await handleStale(interaction));

  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }

  const cfg = await ensureGuildConfig(db, guildId);

  // Settings toggles → flip + redraw the page in place.
  if (id === ctrl('nudges', 'toggle')) {
    return void (await updateSettings(interaction, { nudgeEnabled: !cfg.nudgeEnabled }));
  }
  // Turning either of these on builds an embedding per monitored channel, which
  // is far too slow to do before acknowledging. Save and redraw first, then let
  // the topic build run on behind it — the feature reads the topics lazily and
  // channelFitReconcile heals anything that fails.
  if (id === ctrl('routing', 'fit')) {
    const next = !cfg.channelFitCheck;
    await updateSettings(interaction, { channelFitCheck: next });
    if (next) void refreshTopics(interaction);
    return;
  }
  if (id === ctrl('routing', 'guard')) {
    const next = !cfg.guardEnabled;
    await updateSettings(interaction, { guardEnabled: next });
    if (next) void refreshTopics(interaction);
    return;
  }
  if (id === ctrl('routing', 'autoclose')) {
    return void (await updateSettings(interaction, { guardAutoClose: !cfg.guardAutoClose }));
  }
  if (id === ctrl('cleanup', 'prompt')) {
    return void (await updateSettings(interaction, { removeSolvedPrompt: !cfg.removeSolvedPrompt }));
  }
  if (id === ctrl('cleanup', 'branding')) {
    return void (await updateSettings(interaction, { brandingEnabled: !cfg.brandingEnabled }));
  }

  // Dashboard actions.
  if (id === ID.rescanAll) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targets = allTargets({ forumChannelIds: cfg.forumChannelIds, trackedChannelIds: cfg.trackedChannelIds });
    if (targets.length === 0) {
      await interaction.editReply('Nothing to re-scan yet.');
      return;
    }
    await interaction.editReply(rescanSummary(await startReindex(interaction, targets)));
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
        `✅ Created <#${res.forumId}> with **${res.solved}** solved examples and **${res.fresh}** fresh questions.\n` +
          `_Done exploring? Just delete <#${res.forumId}> and I'll clean everything up automatically._`,
      );
    } catch {
      await interaction.editReply('Demo failed — I need permission to create a forum channel.');
    }
    return;
  }

  await handleStale(interaction);
}

/** The shared "what happened" summary for a re-scan, used by the button and `/dejavue rescan`. */
export function rescanSummary(res: {
  started: string[];
  skipped: string[];
  throttled: string[];
}): string {
  const lines: string[] = [];
  if (res.started.length) {
    lines.push(
      `🔄 Re-scanning ${res.started.join(', ')} — watch the live message${res.started.length > 1 ? 's' : ''} I posted here.`,
    );
  }
  if (res.skipped.length) lines.push(`⏭️ Already running: ${res.skipped.join(', ')}.`);
  if (res.throttled.length) {
    lines.push(
      `⏳ Re-scanned recently: ${res.throttled.join(', ')} — a re-scan re-reads the whole channel, so it's rate-limited. Try again later.`,
    );
  }
  return lines.join('\n') || 'Nothing to re-scan.';
}

export async function handleHubSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (isLegacyId(interaction.customId)) return void (await handleStale(interaction));
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }
  const id = interaction.customId;
  const guildId = interaction.guildId!;
  const db = getDb();
  const value = interaction.values[0];

  if (id === PAGER_ID && value) {
    const page = (settingsPage(value as SettingsPageId).id ?? DEFAULT_PAGE) as SettingsPageId;
    return void (await interaction.update(await renderSettingsHub(guildId, page, hubCtx(interaction))));
  }
  if (id === ctrl('routing', 'sens') && value) {
    return void (await updateSettings(interaction, {
      guardSensitivity: value as 'low' | 'medium' | 'high',
    }));
  }
  if (id === ctrl('duplicates', 'sens') && value) {
    if (value === 'custom') {
      // Ask for the exact minimum match % in a modal instead of storing 'custom'.
      // showModal must be the FIRST acknowledgement — don't defer before it.
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
          .setCustomId(DEDUP_MODAL_ID)
          .setTitle('Custom duplicate threshold')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      );
      return;
    }
    return void (await updateSettings(interaction, {
      dedupSensitivity: value as 'low' | 'medium' | 'high',
    }));
  }
  if (id === ctrl('nudges', 'hours') && value) {
    return void (await updateSettings(interaction, { nudgeAfterHours: Number(value) }));
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
    if (interaction.guild) {
      await interaction.update(await renderDashboard(interaction.guild, hubCtx(interaction)));
    }
    return;
  }

  await handleStale(interaction);
}

/** Modal submits from the settings hub (currently: the custom dedup threshold). */
export async function handleHubModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== DEDUP_MODAL_ID) {
    await handleStale(interaction);
    return;
  }
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
  // The modal id carries its page, so we land back on Duplicate detection rather
  // than bouncing the admin to Overview.
  const page = pageOf(interaction.customId) ?? DEFAULT_PAGE;
  if (interaction.isFromMessage()) {
    await interaction.update(await renderSettingsHub(guildId, page, hubCtx(interaction)));
  } else {
    await interaction.reply(eph(`✅ Duplicate suggestions now require ≥${Math.round(similarity * 100)}% match.`));
  }
}

export async function handleHubRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
  if (interaction.customId !== ctrl('nudges', 'role')) {
    await handleStale(interaction);
    return;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change this.'));
    return;
  }
  await updateSettings(interaction, { nudgeHelperRoleId: interaction.values[0] ?? null });
}

export { isSettingsInteraction };
