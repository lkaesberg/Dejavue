import {
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type ForumChannel,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import {
  checkQuota,
  countByStatus,
  countPublished,
  createBackfillJob,
  ensureGuildConfig,
  getActiveOtp,
  getDb,
  getFaqEntries,
  getGuildConfig,
  getTopClusters,
  keywordSearch,
  publishExistingSolved,
  resolutionStats,
  type SearchMatch,
  semanticSearch,
  topHelpers,
  updateGuildConfig,
} from '@dejavue/db';
import { enqueueBackfill, enqueueClusterGaps, enqueueRegenFaq } from '@dejavue/queue';
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
  .addSubcommand((s) => s.setName('solved').setDescription('Mark the current forum post as solved'))
  .addSubcommand((s) =>
    s
      .setName('backfill')
      .setDescription("Import a forum's existing history into the archive (one-time purchase)")
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Forum channel to import')
          .addChannelTypes(ChannelType.GuildForum)
          .setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('kb')
      .setDescription('Configure the public knowledge base (admin)')
      .addStringOption((o) =>
        o.setName('slug').setDescription('Subdomain label, e.g. "acme" → acme.dejavue.app'),
      )
      .addBooleanOption((o) =>
        o.setName('publish').setDescription('Publish solved posts to the public KB'),
      ),
  )
  .addSubcommand((s) =>
    s.setName('demo').setDescription('Create an example forum with sample questions (admin)'),
  )
  .addSubcommand((s) => s.setName('help').setDescription('How Dejavue works'));

const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'docs', 'status', 'admin', 'dejavue', 'mail', 'cdn']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

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
          description: `Your plan monitors up to ${limits.maxForumChannels} forum channel(s). Upgrade to **Plus** (3 forums) or **Pro** (unlimited).`,
          skuId: getEnv().SKU_PLUS,
        }),
      );
      return;
    }

    const { solvedTagId, unsolvedTagId } = await ensureForumTags(forum);
    const channels = new Set(cfg.forumChannelIds);
    channels.add(forum.id);
    await updateGuildConfig(db, guildId, { forumChannelIds: [...channels], solvedTagId, unsolvedTagId });
    await interaction.editReply(
      `✅ Now monitoring <#${forum.id}>. I ensured \`solved\` / \`unsolved\` tags exist. ` +
        'New posts get an **unsolved** tag and a control message; solved posts are archived for `/dejavue search`.',
    );
  } catch (err) {
    log.error({ err }, 'setup failed');
    await interaction.editReply(
      'Setup failed — I need the **Manage Channels** permission to create the forum tags. Grant it and re-run.',
    );
  }
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
          ? cfg.forumChannelIds.map((id) => `<#${id}>`).join(', ')
          : '_none — run_ `/dejavue setup`',
      },
      {
        name: 'Public KB',
        value: cfg?.kbPublishOptIn ? `on (\`${cfg.kbSlug ?? '—'}\`)` : 'off',
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
        name: `Monitored forums (${cfg?.forumChannelIds.length ?? 0} / ${channelCap})`,
        value: cfg?.forumChannelIds.length
          ? cfg.forumChannelIds.map((id) => `<#${id}>`).join(', ')
          : '_none — run_ `/dejavue setup`',
      },
      {
        name: 'Public KB',
        value:
          cfg?.kbPublishOptIn && kbUrl
            ? `on — ${kbUrl} (${published}${kbCap} pages)`
            : cfg?.kbPublishOptIn
              ? 'on — _set a slug:_ `/dejavue kb slug:<name>`'
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

  if (limits.generative) {
    const q = await checkQuota(db, guildId, env.PRO_MONTHLY_QUOTA);
    embed.addFields({ name: 'AI generations (month)', value: `${q.used} / ${q.limit}`, inline: true });
  }
  if (limits.mcp) {
    embed.addFields({
      name: 'MCP server (Pro)',
      value: kbUrl
        ? `\`${kbUrl}/mcp\`\nAdd as a Streamable HTTP MCP server in your AI client to query this KB.`
        : '_set a KB slug first:_ `/dejavue kb slug:<name>`',
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
    const { embedOne } = await import('@dejavue/ai');
    const vector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    results = await semanticSearch(db, { guildId, queryVector: vector, limit: 5, minSimilarity: 0.5 });
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
    const q = await checkQuota(db, guildId, getEnv().PRO_MONTHLY_QUOTA);
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
  await enqueueClusterGaps({ guildId });
  const clusters = await getTopClusters(db, guildId, 10);
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Knowledge gaps');
  embed.setDescription(
    clusters.length
      ? clusters
          .map((c) => {
            const first = c.memberThreadIds[0];
            const title = c.label ?? c.representativeText ?? 'topic';
            return first ? `• [${title}](${threadUrl(guildId, first)}) — ${c.size} asks` : `• ${title} — ${c.size} asks`;
          })
          .join('\n')
      : 'No clusters yet — re-clustering has been queued. Try again shortly.',
  );
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
  await enqueueRegenFaq({ guildId });
  const faqs = await getFaqEntries(db, guildId);
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('Auto-FAQ');
  if (faqs.length === 0) {
    embed.setDescription('No FAQ entries yet — regeneration has been queued. Try again shortly.');
  } else {
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

async function handleBackfill(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to run a backfill.'));
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
  const env = getEnv();
  const otp = env.SKU_BACKFILL ? await getActiveOtp(db, interaction.guild.id, env.SKU_BACKFILL) : undefined;
  if (!otp && !env.DEV_FORCE_TIER) {
    await interaction.editReply(
      upsellPayload({
        title: 'One-time backfill',
        description:
          'Import your entire existing forum history into the searchable archive on day one — a one-time purchase.',
        skuId: env.SKU_BACKFILL,
      }),
    );
    return;
  }

  const job = await createBackfillJob(db, {
    guildId: interaction.guild.id,
    channelId: forum.id,
    entitlementId: otp?.id ?? null,
  });
  await enqueueBackfill({ backfillJobId: job.id });
  await interaction.editReply(
    `🪄 Backfill started for <#${forum.id}>. It runs in the background and respects Discord rate limits; ` +
      'existing posts become searchable as they import.',
  );
}

async function handleKb(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to configure the KB.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const rawSlug = interaction.options.getString('slug');
  const publish = interaction.options.getBoolean('publish');

  const patch: Parameters<typeof updateGuildConfig>[2] = {};
  if (rawSlug) {
    const slug = rawSlug.toLowerCase().trim();
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
      await interaction.reply(
        eph('Invalid slug — use 2–40 lowercase letters, numbers, or hyphens (not a reserved word).'),
      );
      return;
    }
    patch.kbSlug = slug;
  }
  if (publish !== null) patch.kbPublishOptIn = publish;

  await ensureGuildConfig(db, guildId);
  if (Object.keys(patch).length > 0) await updateGuildConfig(db, guildId, patch);

  // When turning the KB on, retroactively publish already-solved threads (up to cap).
  let backfilled = 0;
  if (publish === true) {
    const limits = limitsFor(await getGuildTier(guildId));
    backfilled = await publishExistingSolved(db, guildId, limits.kbPageCap);
  }
  const cfg = await getGuildConfig(db, guildId);

  const url = cfg?.kbSlug ? `https://${cfg.kbSlug}.${getEnv().KB_BASE_DOMAIN}` : '_set a slug first_';
  await interaction.reply(
    eph(
      `KB publishing: **${cfg?.kbPublishOptIn ? 'on' : 'off'}**\nPublic URL: ${url}` +
        `${backfilled ? `\nPublished **${backfilled}** existing solved post(s).` : ''}\n` +
        '_Usernames are aliased on public pages. Solved posts publish automatically while under your tier cap (Free 10 / Plus 100 / Pro unlimited)._',
    ),
  );
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
        '**Mark answers:** click **Mark as solved**, or right-click the helpful reply → **Apps → Mark as Answer**.',
        '**Find answers:** `/dejavue search <question>`.',
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
      case 'solved':
        return handleSolved(interaction);
      case 'backfill':
        return handleBackfill(interaction);
      case 'kb':
        return handleKb(interaction);
      case 'demo':
        return handleDemo(interaction);
      case 'help':
        return handleHelp(interaction);
      default:
        await interaction.reply(eph('Unknown subcommand.'));
    }
  },
};
