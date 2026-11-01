import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getEnv, SUPPORT_URL } from '@dejavue/core';
import { COLOR } from './embeds';
import { RESOLVE_PERMISSION_HINT } from './permissions';

/**
 * The setup guide a server gets when Dejavue joins — by DM to whoever added the bot,
 * or in a channel when that DM can't be delivered.
 *
 * It is the one message an admin reads before deciding whether the bot works, so it
 * covers what members will see and why the bot might stay silent, not only which
 * command to run. Long on purpose; `welcome.test.ts` keeps it inside Discord's limits
 * (1,024 per field, 6,000 per message).
 */
export function setupGuide(guildName: string, opts: { inChannel?: boolean } = {}): BaseMessageOptions {
  const env = getEnv();
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(
      opts.inChannel ? '👋 Thanks for adding Dejavue!' : `👋 Thanks for adding Dejavue to ${guildName}`,
    )
    .setDescription(
      [
        ...(opts.inChannel
          ? [
              "_I couldn't DM the person who added me, so here is the setup guide for this server's admins._",
              '',
            ]
          : []),
        "I help your server answer each question once. When someone asks something that has already been solved, I point them to the earlier answer — they get help right away, and your helpers don't repeat themselves. Every solved thread is archived: searchable in Discord and, if you want, on a public website.",
        '',
        'Setup takes about five minutes. Until you pick a channel I do nothing, and I ignore every channel you have not set up.',
      ].join('\n'),
    )
    .addFields(
      {
        name: '1️⃣ Pick a help channel',
        value: [
          'A **forum channel** works best: one post per question, and it gets the full solve workflow below. No forum yet? Use the **+** next to a category in your channel list and choose **Forum**. Forums need Community turned on (**Server Settings → Enable Community**).',
          'Text and announcement channels work too. I index their conversations so they show up in search, but they don’t get the solve workflow.',
        ].join('\n'),
      },
      {
        name: '2️⃣ Run setup',
        value: [
          '`/dejavue setup channel:#your-help-forum`',
          '• creates the `solved` and `unsolved` tags in that forum',
          '• imports the threads already in it, so I can spot duplicates from day one',
          '• checks my permissions there and tells you what is missing',
          'Add `mode: knowledge` for a forum that is an archive rather than questions (guides, FAQs, changelogs): every post is archived, and nobody gets prompted or duplicate replies.',
        ].join('\n'),
      },
      {
        name: '3️⃣ What your members will see',
        value: [
          'When someone posts a question, I:',
          "• search earlier solved posts. On a match I reply **💡 I've seen this before** with the answer and a **Use this answer & close** button; otherwise I note that it looks like a new question.",
          '• add a **Got your answer?** note with a **Mark as solved** button.',
          `To close a question, click **Mark as solved** and type the answer, or right-click the reply that helped → **Apps → Mark as Answer**. ${RESOLVE_PERMISSION_HINT} Solved posts get the \`solved\` tag and are archived.`,
        ].join('\n'),
      },
      {
        name: '4️⃣ Keep an eye on it — `/dejavue dashboard`',
        value:
          'Every channel I watch, how far each import has got, whether it is up to date, and **My permissions** — the first place to look if I am not doing something. Buttons there lead to every other screen.',
      },
      {
        name: '5️⃣ Tune it — `/dejavue settings`',
        value:
          'How strict duplicate matching is, reminders for questions nobody has answered, an off-topic guard that suggests a better channel, and cleanup. Every page explains what your members will see before you switch anything on.',
      },
      {
        name: '6️⃣ Publish a website (optional) — `/dejavue website`',
        value: `Turns solved threads into a searchable site at \`yourname.${env.KB_BASE_DOMAIN}\`. It stays off until you turn it on. A public site needs an imprint naming who runs it; a passphrase keeps it private instead. Authors appear as “Original poster” or “Helper 1”, never with their Discord names.`,
      },
      {
        name: '🔑 Permissions I need',
        value: [
          'In forums: **View Channel, Send Messages in Threads, Embed Links, Read Message History, Manage Threads** and **Manage Channels**. In text channels: **View Channel, Send Messages, Embed Links** and **Read Message History**.',
          'Manage Channels is what lets me create the `solved` / `unsolved` tags; Manage Threads lets me tag and close solved posts.',
          "**If I stay silent in a channel**, it most likely has its own permission overrides (private channels usually do): add Dejavue's role to that channel as well. `/dejavue dashboard` → **My permissions** names anything missing.",
        ].join('\n'),
      },
      {
        name: '💡 Want to try it first?',
        value:
          '`/dejavue dashboard` → **Create demo** builds an example forum with a few answered questions, so you can click through everything. Delete it when you are done.',
      },
      {
        name: '🙋 For your members',
        value:
          '`/dejavue search` finds past answers — only the person searching sees the results. `/dejavue privacy` lets anyone opt out of having their messages archived, in every server.',
      },
      {
        name: '❓ Need a hand?',
        value: '`/dejavue help` lists every command. Questions, bugs or ideas: the support server below.',
      },
    )
    .setFooter({ text: 'Powered by Dejavue' });

  // Link buttons only: in a DM there is no guild, so a hub button could do nothing.
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('Docs & website')
      .setEmoji('🌐')
      .setStyle(ButtonStyle.Link)
      .setURL(env.KB_PUBLIC_URL),
    new ButtonBuilder()
      .setLabel('Support server')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Link)
      .setURL(SUPPORT_URL),
  );
  return { embeds: [embed], components: [row] };
}

/**
 * The short public note posted when the installer did get the guide by DM. It speaks to
 * the whole server — admins and members — since everyone sees a bot arrive.
 */
export function arrivalNotice(installerId: string): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('👋 Dejavue is here')
    .setDescription(
      [
        'I help this server answer each question once: when someone asks something that has already been solved, I point them to the earlier answer, and solved threads become searchable with `/dejavue search`.',
        '',
        `**Admins** — I've sent <@${installerId}> a setup guide by DM. To start right away, run \`/dejavue setup channel:#your-help-forum\`, or \`/dejavue help\` for every command.`,
        "**Everyone else** — nothing changes until an admin picks a help channel, and I ignore every other channel. Don't want your messages archived? `/dejavue privacy`.",
      ].join('\n'),
    )
    .setFooter({ text: 'Powered by Dejavue' });
  return { embeds: [embed] };
}
