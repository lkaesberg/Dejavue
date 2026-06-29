import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { SearchMatch } from '@dejavue/db';

export const BRAND_FOOTER = 'Powered by Dejavue';
export const COLOR = 0x5865f2;
export const COLOR_SOLVED = 0x57f287;
export const COLOR_DUPLICATE = 0xfee75c;

export const SOLVE_BUTTON_ID = 'dejavue:solve';
export const DISMISS_BUTTON_ID = 'dejavue:dismiss';
export const ACCEPT_BUTTON_PREFIX = 'dejavue:accept:'; // + original thread id
export const SOLVE_MODAL_PREFIX = 'dejavue:solve-modal'; // optional :controlMessageId

export function threadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function withBranding(embed: EmbedBuilder, showBranding: boolean): EmbedBuilder {
  return showBranding ? embed.setFooter({ text: BRAND_FOOTER }) : embed;
}

/** The control message posted into a new forum post. */
export function controlMessage(showBranding: boolean): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('Got your answer?')
      .setDescription(
        'When this is resolved, hit **Mark as solved** below — or right-click the reply that helped → **Apps → Mark as Answer**. ' +
          'Solved posts get archived and become searchable with `/dejavue search`. ' +
          '_This prompt disappears once solved._',
      ),
    showBranding,
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SOLVE_BUTTON_ID)
      .setLabel('Mark as solved')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

/** Replacement message shown after a post is solved (edits the control message). */
export function solvedNotice(opts: {
  showBranding: boolean;
  solverId: string;
  answerAuthorId?: string | null;
}): BaseMessageOptions {
  const credit = opts.answerAuthorId
    ? `Marked solved — answer by <@${opts.answerAuthorId}>. Thanks!`
    : `Marked solved by <@${opts.solverId}>.`;
  const embed = withBranding(
    new EmbedBuilder().setColor(COLOR_SOLVED).setTitle('✅ Solved').setDescription(credit),
    opts.showBranding,
  );
  return { embeds: [embed], components: [] };
}

/** Public notice posted in the thread when an answer is typed via the modal. */
export function solvedWithAnswerNotice(
  answer: string,
  solverId: string,
  showBranding: boolean,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR_SOLVED)
      .setTitle('✅ Solved')
      .setDescription(`${answer.slice(0, 3500)}\n\n— marked by <@${solverId}>`),
    showBranding,
  );
  return { embeds: [embed] };
}

/** Posted into the thread when an answer is borrowed from a duplicate. */
export function duplicateAcceptedNotice(
  answerText: string,
  originalUrl: string,
  showBranding: boolean,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR_SOLVED)
      .setTitle('✅ Answered from a previous post')
      .setDescription(
        `${answerText ? `${answerText.slice(0, 3500)}\n\n` : ''}Marked as a duplicate of ${originalUrl}.`,
      ),
    showBranding,
  );
  return { embeds: [embed] };
}

/** Replaces the duplicate suggestion after it's accepted. */
export function duplicateResolvedNotice(
  guildId: string,
  originalThreadId: string,
  showBranding: boolean,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR_SOLVED)
      .setTitle('✅ Resolved as a duplicate')
      .setDescription(`Answered from [a previous solved post](${threadUrl(guildId, originalThreadId)}).`),
    showBranding,
  );
  return { embeds: [embed], components: [] };
}

/** Suggestion posted when a new post looks like a duplicate of past solved posts. */
export function duplicatesMessage(
  guildId: string,
  matches: SearchMatch[],
  showBranding: boolean,
  draft?: string,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR_DUPLICATE)
      .setTitle('💡 This may already be answered')
      .setDescription(
        'I found similar solved posts — one of these might save you a wait:\n\n' +
          matches
            .map((m, i) => {
              const pct = m.kind === 'semantic' ? ` · ${Math.round(m.score * 100)}% match` : '';
              const where = m.channelName ? ` · #${m.channelName}` : '';
              return `**${i + 1}.** [${m.title}](${threadUrl(guildId, m.threadId)})${where}${pct}`;
            })
            .join('\n'),
      ),
    showBranding,
  );
  if (draft) {
    embed.addFields({ name: '🤖 Possible answer (AI draft)', value: draft.slice(0, 1024) });
  }

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const top = matches[0];
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (top) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${ACCEPT_BUTTON_PREFIX}${top.threadId}`)
        .setLabel('Use top answer & close')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(DISMISS_BUTTON_ID)
      .setLabel('Not a duplicate')
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(row);
  return { embeds: [embed], components };
}

/** Advisory: this question looks like a better fit for another channel (Plus, opt-in). */
export function channelFitMessage(
  betterChannelId: string,
  showBranding: boolean,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('🧭 Might fit better elsewhere')
      .setDescription(
        `This looks like it may be a better fit for <#${betterChannelId}>. ` +
          'You can move it there to reach the right people faster — or ignore this if it belongs here.',
      ),
    showBranding,
  );
  return { embeds: [embed] };
}

/** Off-topic guard: posted when a question is confidently in the wrong channel and closed. */
export function channelGuardMessage(
  betterChannelId: string | null,
  showBranding: boolean,
): BaseMessageOptions {
  const embed = withBranding(
    new EmbedBuilder()
      .setColor(COLOR_DUPLICATE)
      .setTitle('🚫 This looks like the wrong channel')
      .setDescription(
        (betterChannelId
          ? `This question looks off-topic here — it's a much better fit for <#${betterChannelId}>. `
          : 'This question looks off-topic for this channel. ') +
          "I've tagged and closed this thread to keep the channel on-topic. Please repost it in the right place.",
      ),
    showBranding,
  );
  return { embeds: [embed] };
}

/** Modal that forces the solver to provide an answer (no empty solves). */
export function buildSolveModal(controlMessageId?: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(controlMessageId ? `${SOLVE_MODAL_PREFIX}:${controlMessageId}` : SOLVE_MODAL_PREFIX)
    .setTitle('Mark as solved');
  const input = new TextInputBuilder()
    .setCustomId('answer')
    .setLabel('What was the answer?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(2000)
    .setPlaceholder('Type/paste the solution — or cancel & right-click the reply → Apps → Mark as Answer');
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

/** A "#channel · 96% match" / "#channel · keyword" meta line for one search hit. */
function matchMeta(r: SearchMatch): string {
  const parts: string[] = [];
  if (r.channelName) parts.push(`#${r.channelName}`);
  parts.push(r.kind === 'semantic' ? `${Math.round(r.score * 100)}% match` : 'keyword');
  return parts.join(' · ');
}

export function searchResultsEmbed(
  guildId: string,
  query: string,
  results: SearchMatch[],
  showBranding: boolean,
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(`Search: ${query}`.slice(0, 256));
  if (results.length === 0) {
    embed.setDescription('No solved posts matched. Try different keywords.');
  } else {
    embed.setDescription(
      results
        .map(
          (r, i) =>
            `**${i + 1}.** [${r.title}](${threadUrl(guildId, r.threadId)})\n` +
            `   _${matchMeta(r)}_`,
        )
        .join('\n')
        .slice(0, 4000),
    );
  }
  return withBranding(embed, showBranding);
}

export function statsEmbed(
  counts: { open: number; solved: number; unsolved: number },
  showBranding: boolean,
): EmbedBuilder {
  const total = counts.open + counts.solved + counts.unsolved;
  const rate = total > 0 ? Math.round((counts.solved / total) * 100) : 0;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('Dejavue stats')
    .addFields(
      { name: 'Solved', value: String(counts.solved), inline: true },
      { name: 'Unsolved / open', value: String(counts.unsolved + counts.open), inline: true },
      { name: 'Resolution rate', value: `${rate}%`, inline: true },
    );
  return withBranding(embed, showBranding);
}
