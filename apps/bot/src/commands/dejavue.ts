import { capture } from '@dejavue/analytics';
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
import { childLogger, getEnv, SEARCH_PRESET_SIMILARITY } from '@dejavue/core';
import {
  type ChannelMode,
  countIndexedMessages,
  ensureChannelSync,
  ensureGuildConfig,
  getDb,
  getGuildConfig,
  keywordSearch,
  type SearchMatch,
  hybridSearch,
  setChannelGuidelines,
  updateGuildConfig,
} from '@dejavue/db';
import { botPermissionWarning } from '../lib/botPerms';
import { refreshChannelTopic } from '../lib/channelFit';
import { handleCustomize } from '../lib/customize';
import { COLOR, searchResultsEmbed } from '../lib/embeds';
import { ensureForumTags } from '../lib/forum';
import { handleInsights, handleSettings, renderSetupHub } from '../lib/hubs';
import { allTargets, type ReindexTarget, startForumImport, startReindex } from '../lib/reindexTrigger';
import { eph } from '../lib/reply';
import { getGuildTier, limitsFor } from '../lib/tier';
import { scheduleTrackedCapture } from '../lib/trackedChannel';
import { channelCapUpsellLine, upsellPayload } from '../lib/upsell';
import type { SlashCommand } from './types';

const log = childLogger({ mod: 'cmd:dejavue' });

const data = new SlashCommandBuilder()
  .setName('dejavue')
  .setDescription('Duplicate detection + a searchable knowledge base for your server')
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Add a channel, or run it alone to view & manage your indexed channels (admin)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel to add to the knowledge base (leave empty to open the channel manager)')
          .addChannelTypes(
            ChannelType.GuildForum,
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          )
          .setRequired(false),
      )
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Forums only — how the channel works (default: question)')
          .setRequired(false)
          .addChoices(
            { name: 'question — Q&A: find duplicates, mark answers', value: 'question' },
            { name: 'knowledge — archive everything, no prompts', value: 'knowledge' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('rescan')
      .setDescription("Re-scan a channel's full history and remove deleted posts (admin)")
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel to re-scan (leave empty to re-scan every channel)')
          .addChannelTypes(
            ChannelType.GuildForum,
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          )
          .setRequired(false),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('settings')
      .setDescription('Turn on/off nudges, channel-fit suggestions & the off-topic guard (admin)'),
  )
  .addSubcommand((s) =>
    s
      .setName('customize')
      .setDescription('Customize your public website — branding, theme, domain & privacy (admin)'),
  )
  .addSubcommand((s) =>
    s
      .setName('insights')
      .setDescription('Stats, analytics, recurring-question clusters & the auto-FAQ'),
  )
  .addSubcommand((s) =>
    s
      .setName('search')
      .setDescription('Search your knowledge base')
      .addStringOption((o) =>
        o.setName('query').setDescription('What are you looking for?').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('match')
          .setDescription('How closely results must match (default: balanced)')
          .setRequired(false)
          .addChoices(
            { name: 'broad — more results, looser match', value: 'broad' },
            { name: 'balanced — the default', value: 'balanced' },
            { name: 'exact — only close matches', value: 'exact' },
          ),
      )
      .addIntegerOption((o) =>
        o
          .setName('threshold')
          .setDescription('Custom minimum match % (0–100) — overrides the match preset')
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(100),
      ),
  )
  .addSubcommand((s) => s.setName('help').setDescription('Learn how Dejavue works'));

const requireAdmin = (interaction: ChatInputCommandInteraction): boolean =>
  !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

/**
 * `/dejavue setup` — with no channel it opens the channels & status hub; with a channel
 * it adds it (a forum in question/knowledge mode, or a text channel as a tracked KB).
 */
async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!requireAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission for setup.'));
    return;
  }
  if (!interaction.guild) {
    await interaction.reply(eph('Run this in a server.'));
    return;
  }

  const picked = interaction.options.getChannel('channel', false);
  if (!picked) {
    // Defer first: renderSetupHub does several DB round-trips and could otherwise
    // blow Discord's 3s window into a hard "did not respond".
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await renderSetupHub(interaction.guild));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await interaction.guild.channels.fetch(picked.id).catch(() => null);
  if (!channel) {
    await interaction.editReply('Could not find that channel.');
    return;
  }
  const db = getDb();
  const guildId = interaction.guild.id;
  const cfg = await ensureGuildConfig(db, guildId);
  const limits = limitsFor(await getGuildTier(guildId));

  if (channel.type === ChannelType.GuildForum) {
    const forum = channel as ForumChannel;
    if (!cfg.forumChannelIds.includes(forum.id) && cfg.forumChannelIds.length >= limits.maxForumChannels) {
      capture('upsell_shown', guildId, { gate: 'forum_channel_cap', cap: limits.maxForumChannels });
      await interaction.editReply(
        upsellPayload({
          title: 'Upgrade for more forum channels',
          description: `Your plan monitors up to ${limits.maxForumChannels} forum channel(s). ${channelCapUpsellLine('forum')}`,
          skuId: getEnv().SKU_PLUS,
        }),
      );
      return;
    }
    const mode = (interaction.options.getString('mode') ?? 'question') as ChannelMode;
    const channels = new Set(cfg.forumChannelIds);
    channels.add(forum.id);
    const channelModes = { ...(cfg.channelModes ?? {}), [forum.id]: mode };

    let tagPatch: { solvedTagId?: string; unsolvedTagId?: string } = {};
    try {
      const { solvedTagId, unsolvedTagId } = await ensureForumTags(forum);
      tagPatch = { solvedTagId, unsolvedTagId };
    } catch (err) {
      if (mode === 'question') {
        await interaction.editReply(
          'Setup failed — I need the **Manage Channels** permission to create the `solved`/`unsolved` tags. Grant it and re-run.',
        );
        return;
      }
      log.warn({ err, channel: forum.id }, 'knowledge channel: forum tags skipped');
    }

    await updateGuildConfig(db, guildId, { forumChannelIds: [...channels], channelModes, ...tagPatch });
    capture('setup_completed', guildId, { channel_kind: 'forum', mode });
    await setChannelGuidelines(db, guildId, forum.id, forum.topic ?? null);
    await ensureChannelSync(db, guildId, forum.id, 'forum');
    if (cfg.channelFitCheck) {
      await refreshChannelTopic(guildId, forum, cfg.embeddingModel, forum.topic).catch((err) =>
        log.warn({ err, channel: forum.id }, 'failed to build channel topic'),
      );
    }
    const imp = await startForumImport(interaction, forum.id);
    const importNote = imp.resumed
      ? ' 📥 An import of this channel is already running — it resumes where it left off.'
      : imp.posted
        ? ' 📥 Importing existing threads now — the progress message below updates live and turns ✅ when everything is in.'
        : ' 📥 Importing existing threads in the background — run `/dejavue setup` (no options) to watch the status.';
    const note =
      `${importNote} Everything indexed ` +
      'is published to your knowledge base automatically; run `/dejavue rescan` anytime to refresh.' +
      botPermissionWarning(forum, 'forum');
    await interaction.editReply(
      mode === 'knowledge'
        ? `✅ Now archiving <#${forum.id}> as a **knowledge** channel — every thread is added automatically.${note}`
        : `✅ Now monitoring <#${forum.id}> as a **question** channel. New posts get an **unsolved** tag and a control message; solved posts are archived for search.${note}`,
    );
    return;
  }

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    const already = cfg.trackedChannelIds.includes(channel.id);
    if (!already && cfg.trackedChannelIds.length >= limits.maxTrackedChannels) {
      capture('upsell_shown', guildId, { gate: 'tracked_channel_cap', cap: limits.maxTrackedChannels });
      await interaction.editReply(
        upsellPayload({
          title: 'Upgrade to track more channels',
          description: `Your plan indexes up to ${limits.maxTrackedChannels} normal channel(s). ${channelCapUpsellLine('tracked')}`,
          skuId: getEnv().SKU_PLUS,
        }),
      );
      return;
    }
    const trackedChannelIds = already ? cfg.trackedChannelIds : [...cfg.trackedChannelIds, channel.id];
    await updateGuildConfig(db, guildId, { trackedChannelIds });
    capture('setup_completed', guildId, { channel_kind: 'tracked' });
    await setChannelGuidelines(db, guildId, channel.id, (channel as TextChannel).topic ?? null);
    await ensureChannelSync(db, guildId, channel.id, 'channel');
    scheduleTrackedCapture(channel as TextChannel | NewsChannel);
    await interaction.editReply(
      `✅ Now indexing <#${channel.id}> as a knowledge base. I'll capture recent conversations now — ` +
        'everything indexed is searchable and published to your knowledge base automatically.\n' +
        '_Run `/dejavue rescan` to re-scan full history, or `/dejavue setup` (no options) for status._' +
        botPermissionWarning(channel, 'text'),
    );
    return;
  }

  await interaction.editReply('Pick a **forum**, **text**, or **announcement** channel.');
}

async function handleReindex(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!requireAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to reindex.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const cfg = await getGuildConfig(db, guildId);
  const picked = interaction.options.getChannel('channel', false);

  let targets: ReindexTarget[] = [];
  if (picked) {
    if (cfg?.forumChannelIds.includes(picked.id)) targets = [{ id: picked.id, kind: 'forum' }];
    else if (cfg?.trackedChannelIds.includes(picked.id)) targets = [{ id: picked.id, kind: 'tracked' }];
    else {
      await interaction.reply(eph(`<#${picked.id}> isn't monitored. Add it with \`/dejavue setup\` first.`));
      return;
    }
  } else if (cfg) {
    targets = allTargets(cfg);
  }
  if (targets.length === 0) {
    await interaction.reply(eph('Nothing to reindex yet — add a channel with `/dejavue setup`.'));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { started, skipped, throttled } = await startReindex(interaction, targets);
  const lines: string[] = [];
  if (started.length) {
    lines.push(
      `🔄 Reindexing ${started.join(', ')} — watch the live message${started.length > 1 ? 's' : ''} I posted here.`,
    );
  }
  if (skipped.length) lines.push(`⏭️ Already running: ${skipped.join(', ')}.`);
  if (throttled.length) {
    lines.push(
      `⏳ Recently reindexed: ${throttled.join(', ')} — a reindex re-reads the whole channel, so it's rate-limited. Try again later.`,
    );
  }
  await interaction.editReply(lines.join('\n') || 'Nothing to reindex.');
}

// How closely a `/dejavue search` result must match the query, by the `match` option.
async function handleSearch(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString('query', true);
  const match = (interaction.options.getString('match') ??
    'balanced') as keyof typeof SEARCH_PRESET_SIMILARITY;
  // A typed threshold % beats the preset (same scale as the "% match" badges).
  const customThreshold = interaction.options.getInteger('threshold');
  const minSimilarity =
    customThreshold != null
      ? customThreshold / 100
      : (SEARCH_PRESET_SIMILARITY[match] ?? SEARCH_PRESET_SIMILARITY.balanced);
  const guildId = interaction.guildId!;
  await interaction.deferReply();
  const db = getDb();
  const limits = limitsFor(await getGuildTier(guildId));

  let results: SearchMatch[];
  if (limits.semanticSearch) {
    const cfg = await getGuildConfig(db, guildId);
    const { embedOne, embeddingModelId } = await import('@dejavue/ai');
    const vector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    // Hybrid: exact-term overlap boosts semantic results, and direct keyword
    // hits the embeddings missed are appended for recall.
    results = await hybridSearch(db, {
      guildId,
      query,
      queryVector: vector,
      limit: 5,
      minSimilarity,
      modelId: embeddingModelId(cfg?.embeddingModel),
    });
  } else {
    // Keyword search (free tier) has no similarity score, so `match` doesn't apply.
    results = await keywordSearch(db, { guildId, query, limit: 5 });
  }

  capture('search_performed', guildId, {
    mode: limits.semanticSearch ? 'hybrid' : 'keyword',
    result_count: results.length,
  });

  // On an empty result, tell a fresh server "nothing indexed yet" instead of
  // implying their keywords were wrong.
  const nothingIndexed = results.length === 0 && (await countIndexedMessages(db, guildId)) === 0;
  await interaction.editReply({
    embeds: [searchResultsEmbed(guildId, query, results, !limits.removeBranding, { nothingIndexed })],
  });
}

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue')
    .setDescription(
      [
        '**What I do:** I watch your help **forums** and **text channels**, flag likely duplicate ',
        'questions, and turn the conversations into a searchable knowledge base (and a public site).',
        '',
        '**Add channels & see status:** `/dejavue setup` — run it bare for the channel manager, or ',
        '`/dejavue setup #channel [mode]` to add a forum or text channel.',
        '**Keep it fresh:** `/dejavue rescan [#channel]` re-scans full history and removes deleted posts.',
        '**Find answers:** `/dejavue search <question>`.',
        '**Mark answers:** click **Mark as solved** in a post, or right-click a reply → **Apps → Mark as Answer**.',
        '**Insights:** `/dejavue insights` — counts, analytics, knowledge gaps & auto-FAQ in one place.',
        '**Settings:** `/dejavue settings` — stale nudges, channel-fit suggestions, off-topic guard (Plus).',
        '**Customize:** `/dejavue customize` — branding, theme, domain & privacy.',
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
    const subcommand = interaction.options.getSubcommand();
    capture('command_used', interaction.guildId!, { subcommand });
    switch (subcommand) {
      case 'setup':
        return handleSetup(interaction);
      case 'rescan':
        return handleReindex(interaction);
      case 'settings':
        return handleSettings(interaction);
      case 'customize':
        return handleCustomize(interaction);
      case 'insights':
        return handleInsights(interaction);
      case 'search':
        return handleSearch(interaction);
      case 'help':
        return handleHelp(interaction);
      default:
        await interaction.reply(eph('Unknown subcommand.'));
    }
  },
};
