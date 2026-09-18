import { capture } from '@dejavue/analytics';
import {
  ChannelType,
  type ChatInputCommandInteraction,
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
import { botPermissionWarning, missingBotPermissions } from '../lib/botPerms';
import { showBrandingFor } from '../lib/branding';
import { refreshChannelTopic } from '../lib/channelFit';
import { commandDescription, type SubcommandName } from '../lib/commandCopy';
import { handleWebsite } from '../lib/customize';
import { searchResultsEmbed } from '../lib/embeds';
import { ensureForumTags } from '../lib/forum';
import { renderHelp } from '../lib/help';
import { hubCtx } from '../lib/hubNav';
import { handleDashboard, handleInsights, handleSettings, rescanSummary } from '../lib/hubs';
import { allTargets, type ReindexTarget, startForumImport, startReindex } from '../lib/reindexTrigger';
import { eph } from '../lib/reply';
import { getGuildTier, limitsFor } from '../lib/tier';
import { scheduleTrackedCapture } from '../lib/trackedChannel';
import { channelCapUpsellLine, upsellPayload } from '../lib/upsell';
import type { SlashCommand } from './types';

const log = childLogger({ mod: 'cmd:dejavue' });

const desc = (name: SubcommandName) => commandDescription(name);

// Declaration order is picker order, so this reads as a getting-started list.
// Admin-only subcommands still appear for everyone: Discord's
// setDefaultMemberPermissions applies to the TOP-LEVEL command, and search /
// insights / help are open to all members. The "(needs Manage Server)" suffix on
// the description is what sets expectations; the runtime checks are what enforce
// it. Both name the Discord permission, never a role — Dejavue has none.
const data = new SlashCommandBuilder()
  .setName('dejavue')
  .setDescription('Duplicate detection + a searchable knowledge base for your server')
  .addSubcommand((s) => s.setName('dashboard').setDescription(desc('dashboard')))
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription(desc('setup'))
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The channel to start indexing')
          .addChannelTypes(
            ChannelType.GuildForum,
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
          )
          // Required, so this subcommand does exactly one thing. The status hub
          // it used to double as now has its own name: /dejavue dashboard.
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Forums only — whether posts are questions to answer or just content to archive')
          .setRequired(false)
          .addChoices(
            { name: 'question — find duplicates and prompt for an answer (default)', value: 'question' },
            { name: 'knowledge — archive every thread, never prompt', value: 'knowledge' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('search')
      .setDescription(desc('search'))
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
  .addSubcommand((s) => s.setName('insights').setDescription(desc('insights')))
  .addSubcommand((s) => s.setName('settings').setDescription(desc('settings')))
  .addSubcommand((s) => s.setName('website').setDescription(desc('website')))
  .addSubcommand((s) =>
    s
      .setName('rescan')
      .setDescription(desc('rescan'))
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
  .addSubcommand((s) => s.setName('help').setDescription(desc('help')))
  // Deprecated alias, kept for one release so muscle memory and older docs still
  // land somewhere useful. Remove once the rename has been out a while.
  .addSubcommand((s) =>
    s.setName('customize').setDescription('Renamed — use /dejavue website instead'),
  );

const requireAdmin = (interaction: ChatInputCommandInteraction): boolean =>
  !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

/**
 * `/dejavue setup #channel` — add one channel: a forum in question/knowledge
 * mode, or a text/announcement channel as a tracked knowledge base.
 *
 * This used to double as the status hub when run with no options, which meant
 * the most useful screen in the bot had no name. That is `/dejavue dashboard`
 * now, and `channel` is required here.
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

  // `channel` is required by the builder, so there is no bare-invocation branch
  // any more — the status hub it used to open is `/dejavue dashboard`.
  const picked = interaction.options.getChannel('channel', true);
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

    // Question mode can't work without the `solved` / `unsolved` tags. If that
    // fails, re-check the permissions and name what's actually missing — the old
    // message blamed Manage Channels for every failure, including Discord's
    // 20-tag limit, which no permission grant will fix.
    let tagPatch: { solvedTagId?: string; unsolvedTagId?: string } = {};
    try {
      const { solvedTagId, unsolvedTagId } = await ensureForumTags(forum);
      tagPatch = { solvedTagId, unsolvedTagId };
    } catch (err) {
      if (mode === 'question') {
        const missing = missingBotPermissions(forum, 'forum');
        await interaction.editReply(
          missing.length > 0
            ? `Setup failed — I'm missing **${missing.join(', ')}** in <#${forum.id}>. I need **Manage Channels** there to create the \`solved\` / \`unsolved\` tags. Grant it in Server Settings → Roles → Dejavue (or on the channel) and re-run.`
            : `Setup failed — I couldn't create the \`solved\` / \`unsolved\` tags in <#${forum.id}>. The forum may already be at Discord's 20-tag limit; free a tag and re-run.`,
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
        : ' 📥 Importing existing threads in the background — run `/dejavue dashboard` to watch the status.';
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
        '_Run `/dejavue rescan` to re-read the full history, or `/dejavue dashboard` for status._' +
        botPermissionWarning(channel, 'text'),
    );
    return;
  }

  await interaction.editReply('Pick a **forum**, **text**, or **announcement** channel.');
}

/**
 * `/dejavue rescan` — re-read a channel's full history.
 *
 * Named "rescan" everywhere a user can see it. The internals stay `reindex`:
 * that word is load-bearing in the DB (`reindex_job`, the `reindexing` status)
 * and the queue (`reindex-channel`), so renaming it would mean a migration for
 * no user-visible gain.
 */
async function handleRescan(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!requireAdmin(interaction)) {
    await interaction.reply(eph('You need the **Manage Server** permission to re-scan a channel.'));
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
      await interaction.reply(
        eph(`<#${picked.id}> isn't being watched. Add it with \`/dejavue setup\` first.`),
      );
      return;
    }
  } else if (cfg) {
    targets = allTargets(cfg);
  }
  if (targets.length === 0) {
    await interaction.reply(eph('Nothing to re-scan yet — add a channel with `/dejavue setup`.'));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(rescanSummary(await startReindex(interaction, targets)));
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
  // Ephemeral: a search is the asker's own half-formed question, and answering
  // it in the open dumps an embed into whatever channel they happened to run it
  // in. Only the searcher sees the results; they can still share a hit by
  // pasting its thread link.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
    embeds: [
      searchResultsEmbed(guildId, query, results, await showBrandingFor(guildId), { nothingIndexed }),
    ],
  });
}

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ ...renderHelp(hubCtx(interaction)), flags: MessageFlags.Ephemeral });
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
      case 'dashboard':
        return handleDashboard(interaction);
      case 'setup':
        return handleSetup(interaction);
      case 'rescan':
        return handleRescan(interaction);
      case 'settings':
        return handleSettings(interaction);
      // Deprecated alias — same hub, plus a note pointing at the new name.
      case 'customize':
      case 'website':
        return handleWebsite(interaction);
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
