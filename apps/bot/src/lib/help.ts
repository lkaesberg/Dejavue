import { type BaseMessageOptions, EmbedBuilder } from 'discord.js';
import { commandDescription, SUBCOMMANDS } from './commandCopy';
import { COLOR } from './embeds';
import { assertRowBudget, type HubCtx, navRow } from './hubNav';

/**
 * `/dejavue help`.
 *
 * The command list is generated from SUBCOMMANDS rather than retyped, which is
 * how this page previously came to claim the settings hub was Plus-only — it
 * was a second hand-written copy of the builder's descriptions, and it drifted.
 * Nothing in the settings hub is gated by plan.
 */
export function renderHelp(ctx: HubCtx): BaseMessageOptions {
  const commands = SUBCOMMANDS.map((c) => {
    const who = c.who === 'admin' ? ' _(needs Manage Server)_' : '';
    return `\`/dejavue ${c.name}\`${who}\n${c.help}`;
  }).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('❓ How Dejavue works')
    .setDescription(
      'I watch your help **forums** and **text channels**. When someone posts a question I check whether it has been answered before, and when a post is solved I archive the answer so the next person can find it — by search, on a public website, or through an MCP server your AI tools can query.',
    )
    .addFields(
      {
        name: '🚀 Getting started',
        value: [
          '**1.** `/dejavue setup #your-help-forum` — I create the `solved` / `unsolved` tags and import past threads.',
          '**2.** `/dejavue dashboard` — watch the import land and see everything I am watching.',
          '**3.** `/dejavue settings` — tune what I do on my own. Every setting explains itself.',
        ].join('\n'),
      },
      {
        name: '✅ Marking answers',
        value: [
          'Click **Mark as solved** on the post and type the answer, or right-click the helpful reply → **Apps → Mark as Answer**.',
          'When I suggest a duplicate, **Use this answer & close** copies the old answer across.',
          'Only the original poster, a moderator or an admin can resolve a post.',
        ].join('\n'),
      },
      { name: '📝 Commands', value: commands },
      {
        name: '💡 Just exploring?',
        value: 'Open `/dejavue dashboard` and hit **Create demo** — I build an example forum you can delete when you are done.',
      },
    );

  return {
    embeds: [embed],
    components: assertRowBudget([navRow('help', { admin: ctx.admin })], 'help'),
  };
}

/** Exported for the README drift test, which can't import the builder. */
export const helpCommandLines = (): string[] =>
  SUBCOMMANDS.map((c) => `/dejavue ${c.name} — ${commandDescription(c.name)}`);
