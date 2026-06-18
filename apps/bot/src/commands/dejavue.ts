import {
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type ForumChannel,
  MessageFlags,
  type NewsChannel,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import {
  type ChannelMode,
  channelMode,
  checkQuota,
  countByStatus,
  countPublished,
  createBackfillJob,
  ensureGuildConfig,
  type GenStatus,
  generationStatus,
  getDb,
  deleteChannelTopic,
  getFaqEntries,
  getGuildConfig,
  getTopClusters,
  keywordSearch,
  markGenerationStarted,
  setChannelGuidelines,
  resolutionStats,
  type SearchMatch,
  semanticSearch,
  topHelpers,
  updateGuildConfig,
} from '@dejavue/db';
import { enqueueBackfill, enqueueClusterGaps, enqueueRegenFaq } from '@dejavue/queue';
import { refreshAllChannelTopics, refreshChannelTopic } from '../lib/channelFit';
import { handleCustomize } from '../lib/customize';
import { scheduleTrackedCapture } from '../lib/trackedChannel';
import { buildSolveModal, COLOR, searchResultsEmbed, statsEmbed, threadUrl } from '../lib/embeds';
import { ensureForumTags, forumParent } from '../lib/forum';
import { canResolveThread, NO_PERMISSION_MESSAGE } from '../lib/permissions';
import { eph } from '../lib/reply';
import { getGuildTier, limitsFor } from '../lib/tier';
import { upsellPayload } from '../lib/upsell';
import type { SlashCommand } from './types';

const log = childLogger({ mod: 'cmd:dejavue' });

const data = new SlashCommandBuilder()
  .setName('dejavue')
  .setDescription('Duplicate detection + a searchable solved-answer archive for forum channels')
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Start monitoring a forum channel (admin)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The forum channel to monitor')
          .addChannelTypes(ChannelType.GuildForum)
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('How this channel works')
          .setRequired(true)
          .addChoices(
            { name: 'question — Q&A: dedup, mark-solved, answers', value: 'question' },
            { name: 'knowledge — pure archive: publish every thread, no prompts', value: 'knowledge' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('track')
      .setDescription('Index a normal text channel as a searchable knowledge base (admin)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The text/announcement channel to index')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('untrack')
      .setDescription('Stop monitoring a forum or tracked text channel (admin)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The channel to stop monitoring')
          .addChannelTypes(
            ChannelType.GuildForum,
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((s) => s.setName('config').setDescription('Show the current configuration'))
  .addSubcommand((s) =>
    s.setName('status').setDescription('Full status: config, URLs, MCP endpoint (admin)'),
  )
  .addSubcommand((s) =>
    s
      .setName('search')
      .setDescription('Search the solved-answer archive')
      .addStringOption((o) =>
        o.setName('query').setDescription('What are you looking for?').setRequired(true),
      ),
  )
  .addSubcommand((s) => s.setName('stats').setDescription('Solved / unsolved counts'))
  .addSubcommand((s) => s.setName('analytics').setDescription('Resolution rate, top helpers, most-asked (Plus)'))
  .addSubcommand((s) => s.setName('gaps').setDescription('Recurring unanswered-question clusters (Pro)'))
  .addSubcommand((s) => s.setName('faq').setDescription('Auto-generated FAQ (Pro)'))
  .addSubcommand((s) =>
    s
      .setName('nudges')
      .setDescription('Configure stale-question nudges (Plus, admin)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Turn nudges on or off'))
      .addIntegerOption((o) =>
        o
          .setName('hours')
          .setDescription('Hours to wait before nudging')
          .setMinValue(1)
          .setMaxValue(720),
      )
      .addRoleOption((o) => o.setName('role').setDescription('Helper role to ping')),
  )
  .addSubcommand((s) =>
    s
      .setName('fitcheck')
      .setDescription('Suggest a better channel when a question seems off-topic (Plus, admin)')
      .addBooleanOption((o) =>
        o.setName('enabled').setDescription('Turn the channel-fit check on or off'),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('guard')
      .setDescription('Warn/relabel/close off-topic posts vs the channel guidelines (Plus, admin)')
      .addBooleanOption((o) =>
        o.setName('enabled').setDescription('Turn the off-topic guard on or off'),
      )
      .addBooleanOption((o) =>
        o
          .setName('autoclose')
          .setDescription('Auto-close posts that are clearly in the wrong channel'),
      )
      .addStringOption((o) =>
        o
          .setName('sensitivity')
          .setDescription('How readily to flag a post as wrong-channel')
          .addChoices(
            { name: 'low — only the most obvious', value: 'low' },
            { name: 'medium — balanced (default)', value: 'medium' },
            { name: 'high — flag aggressively', value: 'high' },
          ),
      ),
  )
  .addSubcommand((s) => s.setName('solved').setDescription('Mark the current forum post as solved'))
  .addSubcommand((s) =>
    s
      .setName('customize')
      .setDescription('Customize the knowledge base — branding, theme, domain, privacy (admin)'),
  )
  .addSubcommand((s) =>
    s.setName('demo').setDescription('Create an example forum with sample questions (admin)'),
  )
  .addSubcommand((s) => s.setName('help').setDescription('How Dejavue works'));

// A generation is re-triggered only if none ran in the last 5 minutes and one
// isn't already in flight; an in-flight run "expires" after 5 minutes so a stuck
// run never blocks forever.
const GEN_OPTS = { throttleMs: 5 * 60_000, maxRunMs: 5 * 60_000 };

/** Short "12s" / "3m" / "2h" elapsed label. */
function sinceLabel(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** A one-line status banner for a generative command (working / fresh). */
function genStatusLine(st: GenStatus, queued: boolean): string | null {
  if (st.inFlight && st.startedAt) {
    return `⏳ Still working on it — started ${sinceLabel(st.startedAt)} ago. This updates automatically; run the command again in a moment for the latest.`;
  }
  if (queued) return '⏳ Working on it — run the command again in a moment for the latest.';
  if (st.fresh && st.finishedAt) return `_Updated ${sinceLabel(st.finishedAt)} ago._`;
  return null;
}

async function resolveForum(interaction: ChatInputCommandInteraction): Promise<ForumChannel | null> {
  const picked = interaction.options.getChannel('channel', true);
  const channel = await interaction.guild?.channels.fetch(picked.id).catch(() => null);
  return channel && channel.type === ChannelType.GuildForum ? (channel as ForumChannel) : null;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const h = seconds / 3600;
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to run setup.'));
    return;
  }
  if (!interaction.guild) {
    await interaction.reply(eph('Run this in a server.'));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const forum = await resolveForum(interaction);
  if (!forum) {
    await interaction.editReply('That is not a forum channel.');
    return;
  }

  const db = getDb();
  const guildId = interaction.guild.id;
  try {
    const cfg = await ensureGuildConfig(db, guildId);
    const limits = limitsFor(await getGuildTier(guildId));
    if (
      !cfg.forumChannelIds.includes(forum.id) &&
      cfg.forumChannelIds.length >= limits.maxForumChannels
    ) {
      await interaction.editReply(
        upsellPayload({
          title: 'Upgrade for more forum channels',
          description: `Your plan monitors up to ${limits.maxForumChannels} forum channel(s). Upgrade to **Plus** (3 forums), **Pro** (5), or **Max** (unlimited).`,
          skuId: getEnv().SKU_PLUS,
        }),
      );
      return;
    }

    const mode = interaction.options.getString('mode', true) as ChannelMode;
    const channels = new Set(cfg.forumChannelIds);
    channels.add(forum.id);
    const channelModes = { ...(cfg.channelModes ?? {}), [forum.id]: mode };

    // Question channels need the solved/unsolved tags; knowledge channels don't
    // (pure archive), so a missing Manage Channels permission shouldn't block them.
    let tagPatch: { solvedTagId?: string; unsolvedTagId?: string } = {};
    try {
      const { solvedTagId, unsolvedTagId } = await ensureForumTags(forum);
      tagPatch = { solvedTagId, unsolvedTagId };
    } catch (err) {
      if (mode === 'question') throw err;
      log.warn({ err, channel: forum.id }, 'knowledge channel: forum tags skipped');
    }

    await updateGuildConfig(db, guildId, {
      forumChannelIds: [...channels],
      channelModes,
      ...tagPatch,
    });
    // Capture the forum's post-guidelines (topic) so the KB can show them.
    await setChannelGuidelines(db, guildId, forum.id, forum.topic ?? null);
    // If the channel-fit check is on, profile this newly tracked channel so it can
    // be compared against (and suggested for) future questions.
    if (cfg.channelFitCheck) {
      await refreshChannelTopic(guildId, forum, cfg.embeddingModel, forum.topic).catch((err) =>
        log.warn({ err, channel: forum.id }, 'failed to build channel topic'),
      );
    }

    // Import the channel's existing history (free, bounded by tier). Idempotent —
    // re-running setup only processes new threads (already-imported ones are
    // skipped), so it also pulls in more history after a tier upgrade. Imported
    // threads are deduped and, if the KB is on, published.
    const bfJob = await createBackfillJob(db, { guildId, channelId: forum.id, entitlementId: null });
    await enqueueBackfill({ backfillJobId: bfJob.id });
    const importNote = ' Importing existing threads in the background — they appear as they finish.';

    if (mode === 'knowledge') {
      await interaction.editReply(
        `✅ Now archiving <#${forum.id}> as a **knowledge** channel — every thread is added to the ` +
          `knowledge base automatically. No answer prompts and no duplicate reminders here.${importNote}`,
      );
    } else {
      await interaction.editReply(
        `✅ Now monitoring <#${forum.id}> as a **question** channel. I ensured \`solved\` / \`unsolved\` tags exist. ` +
          `New posts get an **unsolved** tag and a control message; solved posts are archived for \`/dejavue search\`.${importNote}`,
      );
    }
  } catch (err) {
    log.error({ err }, 'setup failed');
    await interaction.editReply(
      'Setup failed — I need the **Manage Channels** permission to create the forum tags. Grant it and re-run.',
    );
  }
}

async function handleTrack(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to track channels.'));
    return;
  }
  if (!interaction.guild) {
    await interaction.reply(eph('Run this in a server.'));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const picked = interaction.options.getChannel('channel', true);
  const channel = await interaction.guild.channels.fetch(picked.id).catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
  ) {
    await interaction.editReply('Pick a normal **text** or **announcement** channel (not a forum or thread).');
    return;
  }

  const db = getDb();
  const guildId = interaction.guild.id;
  const cfg = await ensureGuildConfig(db, guildId);
  const limits = limitsFor(await getGuildTier(guildId));
  const already = cfg.trackedChannelIds.includes(channel.id);
  if (!already && cfg.trackedChannelIds.length >= limits.maxTrackedChannels) {
    await interaction.editReply(
      upsellPayload({
        title: 'Upgrade to track more channels',
        description: `Your plan indexes up to ${limits.maxTrackedChannels} normal channel(s). Upgrade to **Plus** (3), **Pro** (10), or **Max** (unlimited).`,
        skuId: getEnv().SKU_PLUS,
      }),
    );
    return;
  }

  const trackedChannelIds = already ? cfg.trackedChannelIds : [...cfg.trackedChannelIds, channel.id];
  await updateGuildConfig(db, guildId, { trackedChannelIds });
  // Capture the channel's description as guidelines (shown on the KB) and seed an
  // initial capture of recent conversation.
  await setChannelGuidelines(db, guildId, channel.id, (channel as TextChannel).topic ?? null);
  scheduleTrackedCapture(channel as TextChannel | NewsChannel);

  const cap = Number.isFinite(limits.trackedDocCap) ? String(limits.trackedDocCap) : '∞';
  await interaction.editReply(
    `✅ Now indexing <#${channel.id}> as a knowledge base. Recent conversations are captured into searchable ` +
      `entries that appear on your public KB and in \`/dejavue search\`.\n` +
      `_Tracked-channel quota: up to **${cap}** indexed conversations — separate from your forum archive. ` +
      'Turn on publishing in `/dejavue customize` to show them on the website._',
  );
}

async function handleUntrack(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to change monitored channels.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const picked = interaction.options.getChannel('channel', true);
  const cfg = await getGuildConfig(db, guildId);

  // Tracked normal channel?
  if (cfg?.trackedChannelIds.includes(picked.id)) {
    const trackedChannelIds = cfg.trackedChannelIds.filter((id) => id !== picked.id);
    await updateGuildConfig(db, guildId, { trackedChannelIds });
    await interaction.reply(
      eph(
        `✅ Stopped indexing <#${picked.id}>.\n` +
          '_Already-indexed conversations are kept (so search/KB still work). To remove their public pages, turn off publishing in `/dejavue customize`._',
      ),
    );
    return;
  }

  if (!cfg || !cfg.forumChannelIds.includes(picked.id)) {
    await interaction.reply(eph(`<#${picked.id}> isn't being monitored.`));
    return;
  }
  const remaining = cfg.forumChannelIds.filter((id) => id !== picked.id);
  const channelModes = { ...(cfg.channelModes ?? {}) };
  delete channelModes[picked.id];
  await updateGuildConfig(db, guildId, { forumChannelIds: remaining, channelModes });
  // Drop its topic vector so it's no longer a fit-check candidate.
  await deleteChannelTopic(db, guildId, picked.id).catch(() => undefined);
  await interaction.reply(
    eph(
      `✅ Stopped monitoring <#${picked.id}> — new posts there won't get duplicate detection or a control message.\n` +
        '_Already-archived answers are kept (so search/KB still work). To also remove its public pages, unsolve those threads or turn off publishing in `/dejavue customize`._',
    ),
  );
}

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const guildId = interaction.guildId!;
  const cfg = await getGuildConfig(db, guildId);
  const tier = await getGuildTier(guildId);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue configuration')
    .addFields(
      { name: 'Tier', value: tier, inline: true },
      {
        name: 'Monitored forums',
        value: cfg?.forumChannelIds.length
          ? cfg.forumChannelIds
              .map((id) => `<#${id}>${channelMode(cfg, id) === 'knowledge' ? ' _(knowledge)_' : ''}`)
              .join(', ')
          : '_none — run_ `/dejavue setup`',
      },
      {
        name: 'Tracked channels',
        value: cfg?.trackedChannelIds.length
          ? cfg.trackedChannelIds.map((id) => `<#${id}>`).join(', ')
          : '_none — run_ `/dejavue track`',
      },
      {
        name: 'Public KB',
        value: cfg?.kbPublishOptIn ? `on (\`${cfg.kbSlug ?? '—'}\`)` : 'off',
        inline: true,
      },
      { name: 'Channel-fit check', value: cfg?.channelFitCheck ? 'on' : 'off', inline: true },
      {
        name: 'Off-topic guard',
        value: cfg?.guardEnabled
          ? `on${cfg.guardAutoClose ? ' (auto-close)' : ''} · ${cfg.guardSensitivity}`
          : 'off',
        inline: true,
      },
      { name: 'Embedding model', value: cfg?.embeddingModel ?? 'bge-small-en-v1.5', inline: true },
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to view status.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const env = getEnv();
  const cfg = await getGuildConfig(db, guildId);
  const tier = await getGuildTier(guildId);
  const limits = limitsFor(tier);
  const counts = await countByStatus(db, guildId);
  const published = await countPublished(db, guildId);
  const kbUrl = cfg?.kbSlug ? `https://${cfg.kbSlug}.${env.KB_BASE_DOMAIN}` : null;
  const channelCap = Number.isFinite(limits.maxForumChannels) ? String(limits.maxForumChannels) : '∞';
  const kbCap = Number.isFinite(limits.kbPageCap) ? `/${limits.kbPageCap}` : '';

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue status')
    .addFields(
      { name: 'Tier', value: tier, inline: true },
      {
        name: 'Solved / total',
        value: `${counts.solved} / ${counts.solved + counts.unsolved + counts.open}`,
        inline: true,
      },
      { name: 'Embedding model', value: cfg?.embeddingModel ?? 'bge-small-en-v1.5', inline: true },
      {
        name: 'Archive (threads)',
        value: `${counts.solved + counts.unsolved + counts.open} / ${Number.isFinite(limits.archiveCap) ? limits.archiveCap : '∞'}`,
        inline: true,
      },
      {
        name: `Monitored forums (${cfg?.forumChannelIds.length ?? 0} / ${channelCap})`,
        value: cfg?.forumChannelIds.length
          ? cfg.forumChannelIds
              .map((id) => `<#${id}>${channelMode(cfg, id) === 'knowledge' ? ' _(knowledge)_' : ''}`)
              .join(', ')
          : '_none — run_ `/dejavue setup`',
      },
      {
        name: 'Public KB',
        value:
          cfg?.kbPublishOptIn && kbUrl
            ? `on — ${kbUrl} (${published}${kbCap} pages)`
            : cfg?.kbPublishOptIn
              ? 'on — _set a slug in_ `/dejavue customize`'
              : 'off',
      },
      {
        name: 'Stale nudges',
        value: cfg?.nudgeEnabled
          ? `on, after ${cfg.nudgeAfterHours}h${cfg.nudgeHelperRoleId ? ` → <@&${cfg.nudgeHelperRoleId}>` : ''}`
          : 'off',
        inline: true,
      },
    );

  if (cfg?.customDomain) {
    embed.addFields({ name: 'Custom domain', value: `https://${cfg.customDomain}`, inline: true });
  }
  if (limits.generative) {
    const q = await checkQuota(db, guildId, limits.monthlyGenerationQuota);
    embed.addFields({ name: 'AI generations (month)', value: `${q.used} / ${q.limit}`, inline: true });
  }
  if (limits.mcp) {
    embed.addFields({
      name: 'MCP server (Max)',
      value: kbUrl
        ? `\`${kbUrl}/mcp\`\nAdd as a Streamable HTTP MCP server in your AI client to query this KB.`
        : '_set a KB slug first in_ `/dejavue customize`',
    });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleSearch(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString('query', true);
  const guildId = interaction.guildId!;
  await interaction.deferReply();
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));

  let results: SearchMatch[];
  if (limits.semanticSearch) {
    const cfg = await getGuildConfig(db, guildId);
    const { embedOne, embeddingModelId } = await import('@dejavue/ai');
    const vector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    results = await semanticSearch(db, {
      guildId,
      queryVector: vector,
      limit: 5,
      minSimilarity: 0.5,
      modelId: embeddingModelId(cfg?.embeddingModel),
    });
  } else {
    results = await keywordSearch(db, { guildId, query, limit: 5 });
  }

  await interaction.editReply({
    embeds: [searchResultsEmbed(guildId, query, results, !limits.removeBranding)],
  });
}

async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const counts = await countByStatus(db, guildId);
  const limits = limitsFor(await getGuildTier(guildId));
  const embed = statsEmbed(counts, !limits.removeBranding);
  if (limits.generative) {
    const q = await checkQuota(db, guildId, limits.monthlyGenerationQuota);
    embed.addFields({
      name: 'AI generations (this month)',
      value: `${q.used} / ${q.limit}${q.topUp ? ` (incl. ${q.topUp} top-up)` : ''}`,
      inline: true,
    });
  }
  await interaction.reply({ embeds: [embed] });
}

async function handleAnalytics(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  if (limits.analytics !== 'full') {
    await interaction.reply({
      ...upsellPayload({
        title: 'Analytics is a Plus feature',
        description: 'Resolution rate, time-to-resolution, top helpers and most-asked topics. Upgrade to **Plus**.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply();
  const [stats, helpers, clusters] = await Promise.all([
    resolutionStats(db, guildId),
    topHelpers(db, guildId, 5),
    getTopClusters(db, guildId, 5),
  ]);
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue analytics')
    .addFields(
      { name: 'Resolution rate', value: `${Math.round(stats.rate * 100)}% (${stats.solved}/${stats.total})`, inline: true },
      { name: 'Avg time to resolve', value: formatDuration(stats.avgTtrSeconds), inline: true },
      {
        name: 'Top helpers',
        value: helpers.length ? helpers.map((h) => `<@${h.userId}> — ${h.solved}`).join('\n') : '—',
      },
      {
        name: 'Most-asked topics',
        value: clusters.length
          ? clusters.map((c) => `• ${c.label ?? c.representativeText ?? 'topic'} (${c.size})`).join('\n')
          : '_run_ `/dejavue gaps` _to compute_',
      },
    );
  if (!limits.removeBranding) embed.setFooter({ text: 'Powered by Dejavue' });
  await interaction.editReply({ embeds: [embed] });
}

async function handleGaps(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  if (!limits.generative) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Knowledge-gap clustering is a Pro feature',
        description: 'Group recurring unanswered questions so you know exactly which docs to write. Upgrade to **Pro**.',
        skuId: getEnv().SKU_PRO,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Only (re)cluster if nothing ran recently and a run isn't already in flight —
  // re-running while it works just shows the same in-progress status.
  const cfg = await getGuildConfig(db, guildId);
  const st = generationStatus(cfg, 'cluster', GEN_OPTS);
  let queued = false;
  if (!st.inFlight && !st.fresh) {
    await markGenerationStarted(db, guildId, 'cluster');
    await enqueueClusterGaps({ guildId });
    queued = true;
  }

  const clusters = await getTopClusters(db, guildId, 10);
  const list = clusters.length
    ? clusters
        .map((c) => {
          const first = c.memberThreadIds[0];
          const title = c.label ?? c.representativeText ?? 'topic';
          return first ? `• [${title}](${threadUrl(guildId, first)}) — ${c.size} asks` : `• ${title} — ${c.size} asks`;
        })
        .join('\n')
    : '_No clusters yet._';
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Knowledge gaps');
  embed.setDescription([list, genStatusLine(st, queued)].filter(Boolean).join('\n\n'));
  await interaction.editReply({ embeds: [embed] });
}

async function handleFaq(interaction: ChatInputCommandInteraction): Promise<void> {
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cfg = await getGuildConfig(db, guildId);
  const st = generationStatus(cfg, 'faq', GEN_OPTS);
  let queued = false;
  if (!st.inFlight && !st.fresh) {
    await markGenerationStarted(db, guildId, 'faq');
    await enqueueRegenFaq({ guildId });
    queued = true;
  }

  const faqs = await getFaqEntries(db, guildId);
  const statusLine = genStatusLine(st, queued);
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Auto-FAQ');
  if (faqs.length === 0) {
    embed.setDescription(['_No FAQ entries yet._', statusLine].filter(Boolean).join('\n\n'));
  } else {
    if (statusLine) embed.setDescription(statusLine);
    for (const f of faqs.slice(0, 8)) {
      embed.addFields({ name: f.question.slice(0, 256), value: f.answer.slice(0, 1024) });
    }
  }
  await interaction.editReply({ embeds: [embed] });
}

async function handleNudges(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to configure nudges.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  if (!limits.nudges) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Nudges are a Plus feature',
        description: 'Automatically ping helpers about questions that have gone unanswered. Upgrade to **Plus**.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const enabled = interaction.options.getBoolean('enabled');
  const hours = interaction.options.getInteger('hours');
  const role = interaction.options.getRole('role');
  const patch: Parameters<typeof updateGuildConfig>[2] = {};
  if (enabled !== null) patch.nudgeEnabled = enabled;
  if (hours !== null) patch.nudgeAfterHours = hours;
  if (role) patch.nudgeHelperRoleId = role.id;

  await ensureGuildConfig(db, guildId);
  if (Object.keys(patch).length > 0) await updateGuildConfig(db, guildId, patch);
  const cfg = await getGuildConfig(db, guildId);
  await interaction.reply(
    eph(
      `Nudges: **${cfg?.nudgeEnabled ? 'on' : 'off'}** after **${cfg?.nudgeAfterHours}h**` +
        `${cfg?.nudgeHelperRoleId ? `, pinging <@&${cfg.nudgeHelperRoleId}>` : ''}.`,
    ),
  );
}

async function handleFitcheck(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to configure this.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  // Needs embeddings, so it rides on the semantic (Plus+) tier.
  if (!limits.semanticSearch) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Channel-fit check is a Plus feature',
        description:
          'Builds a topic profile for each channel and nudges posters toward a better-fitting ' +
          'channel when a question looks off-topic. Upgrade to **Plus**.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await ensureGuildConfig(db, guildId);
  const enabled = interaction.options.getBoolean('enabled');
  if (enabled === null) {
    const cfg = await getGuildConfig(db, guildId);
    await interaction.reply(
      eph(
        `Channel-fit check is **${cfg?.channelFitCheck ? 'on' : 'off'}**. ` +
          'Pass `enabled:` to change it.',
      ),
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await updateGuildConfig(db, guildId, { channelFitCheck: enabled });
  if (enabled) {
    // Build a topic profile for every monitored channel up front so the first check works.
    const cfg = await getGuildConfig(db, guildId);
    if (cfg && interaction.guild) {
      await refreshAllChannelTopics(interaction.guild, cfg).catch((err) =>
        log.warn({ err, guildId }, 'failed to build channel topics on enable'),
      );
    }
  }
  await interaction.editReply(
    enabled
      ? '✅ Channel-fit check **on**. I profiled each monitored channel; new questions that look ' +
          'off-topic will get a gentle suggestion to move to a better-fitting channel.'
      : 'Channel-fit check **off**.',
  );
}

async function handleGuard(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to configure the guard.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));
  // Needs embeddings → rides on the semantic (Plus+) tier, like the fit-check.
  if (!limits.semanticSearch) {
    await interaction.reply({
      ...upsellPayload({
        title: 'The off-topic guard is a Plus feature',
        description:
          'Profiles each channel from its name + posting guidelines and warns — or, with auto-close, ' +
          'relabels and closes — posts that are clearly in the wrong channel. Upgrade to **Plus**.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await ensureGuildConfig(db, guildId);
  const enabled = interaction.options.getBoolean('enabled');
  const autoclose = interaction.options.getBoolean('autoclose');
  const sensitivity = interaction.options.getString('sensitivity') as
    | 'low'
    | 'medium'
    | 'high'
    | null;

  if (enabled === null && autoclose === null && sensitivity === null) {
    const cfg = await getGuildConfig(db, guildId);
    await interaction.reply(
      eph(
        `Off-topic guard: **${cfg?.guardEnabled ? 'on' : 'off'}**` +
          ` · auto-close **${cfg?.guardAutoClose ? 'on' : 'off'}**` +
          ` · sensitivity **${cfg?.guardSensitivity ?? 'medium'}**.\n` +
          'Pass `enabled:`, `autoclose:`, or `sensitivity:` to change it.',
      ),
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const patch: Parameters<typeof updateGuildConfig>[2] = {};
  if (enabled !== null) patch.guardEnabled = enabled;
  if (autoclose !== null) patch.guardAutoClose = autoclose;
  if (sensitivity !== null) patch.guardSensitivity = sensitivity;
  await updateGuildConfig(db, guildId, patch);

  // Profile every monitored channel up front so the first check has something to compare against.
  if (enabled === true) {
    const cfg = await getGuildConfig(db, guildId);
    if (cfg && interaction.guild) {
      await refreshAllChannelTopics(interaction.guild, cfg).catch((err) =>
        log.warn({ err, guildId }, 'failed to build channel topics on guard enable'),
      );
    }
  }

  const cfg = await getGuildConfig(db, guildId);
  await interaction.editReply(
    cfg?.guardEnabled
      ? `✅ Off-topic guard **on** (sensitivity **${cfg.guardSensitivity}**). ` +
          (cfg.guardAutoClose
            ? "Posts clearly in the wrong channel are tagged `wrong-channel` and closed."
            : 'Off-topic posts get a warning with a better-fitting channel. Turn on `autoclose:` to relabel + close.')
      : 'Off-topic guard **off**.',
  );
}

async function handleSolved(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !channel.isThread() || !forumParent(channel)) {
    await interaction.reply(eph('Run this inside a forum post.'));
    return;
  }
  const isOp = channel.ownerId === interaction.user.id;
  if (!canResolveThread(interaction.memberPermissions, isOp)) {
    await interaction.reply(eph(NO_PERMISSION_MESSAGE));
    return;
  }
  // Open the modal so an answer is always provided (or right-click → Mark as Answer).
  await interaction.showModal(buildSolveModal());
}

async function handleDemo(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to run the demo.'));
    return;
  }
  if (!interaction.guild) {
    await interaction.reply(eph('Run this in a server.'));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { runDemo } = await import('../lib/demo');
    const res = await runDemo(interaction.guild);
    await interaction.editReply(
      `✅ Created <#${res.forumId}> with **${res.solved}** solved examples and **${res.fresh}** fresh questions.\n\n` +
        'Open it and watch the two newest posts get flagged as duplicates within a few seconds ' +
        '(with an AI draft on Pro). Then try `/dejavue search password`, `/dejavue stats`, and `/dejavue gaps`.',
    );
  } catch (err) {
    log.error({ err }, 'demo failed');
    await interaction.editReply(
      'Demo failed — I need the **Manage Channels** permission to create a forum channel. Grant it and re-run.',
    );
  }
}

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue')
    .setDescription(
      [
        '**What I do:** I watch your help **forum channels**, flag likely duplicate questions, ',
        'and turn solved posts into a searchable archive (and a public knowledge base).',
        '',
        '**Get started:** `/dejavue setup #your-forum` (admin).',
        '**Track a chat channel:** `/dejavue track #channel` indexes a normal channel as a searchable KB.',
        '**Mark answers:** click **Mark as solved**, or right-click the helpful reply → **Apps → Mark as Answer**.',
        '**Find answers:** `/dejavue search <question>` — shows the channel and a match %.',
        '**Customize your KB:** `/dejavue customize` — branding, theme, domain & privacy in one place.',
        '**Keep channels on-topic:** `/dejavue guard` warns or closes off-topic posts.',
        '**See progress:** `/dejavue stats`, `/dejavue analytics`, `/dejavue gaps`, `/dejavue faq`.',
      ].join('\n'),
    );
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export const dejavueCommand: SlashCommand = {
  data,
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply(eph('Dejavue only works inside a server.'));
      return;
    }
    switch (interaction.options.getSubcommand()) {
      case 'setup':
        return handleSetup(interaction);
      case 'track':
        return handleTrack(interaction);
      case 'untrack':
        return handleUntrack(interaction);
      case 'config':
        return handleConfig(interaction);
      case 'status':
        return handleStatus(interaction);
      case 'search':
        return handleSearch(interaction);
      case 'stats':
        return handleStats(interaction);
      case 'analytics':
        return handleAnalytics(interaction);
      case 'gaps':
        return handleGaps(interaction);
      case 'faq':
        return handleFaq(interaction);
      case 'nudges':
        return handleNudges(interaction);
      case 'fitcheck':
        return handleFitcheck(interaction);
      case 'guard':
        return handleGuard(interaction);
      case 'solved':
        return handleSolved(interaction);
      case 'customize':
        return handleCustomize(interaction);
      case 'demo':
        return handleDemo(interaction);
      case 'help':
        return handleHelp(interaction);
      default:
        await interaction.reply(eph('Unknown subcommand.'));
    }
  },
};
