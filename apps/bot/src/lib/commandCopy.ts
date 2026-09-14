/**
 * One description per subcommand, shared by the slash-command builder and
 * `/dejavue help`.
 *
 * These were two hand-written copies of the same sentences, and they drifted:
 * help claimed the settings hub was Plus-only when nothing in it is gated at
 * all. Feeding both from this array makes that impossible.
 *
 * `desc` is the Discord command description and is capped at 100 characters by
 * the API — `commandCopy.test.ts` asserts it.
 */

export type Audience = 'admin' | 'anyone';

export interface SubcommandCopy {
  name: string;
  /** Discord command description. ≤100 chars. */
  desc: string;
  who: Audience;
  /** The one-line "what you do with it" shown in `/dejavue help`. */
  help: string;
}

/**
 * Declaration order is picker order — Discord renders subcommands in the order
 * the builder declares them, so this reads as a getting-started list.
 */
export const SUBCOMMANDS = [
  {
    name: 'dashboard',
    desc: 'See what Dejavue is watching — channels, index size, sync status and your plan',
    who: 'admin',
    help: 'Your home screen: every indexed channel and how fresh it is, plus buttons to everything else.',
  },
  {
    name: 'setup',
    desc: 'Start indexing a channel — forum, text or announcement',
    who: 'admin',
    help: 'Add a channel. Forums also get `solved` / `unsolved` tags, and past threads import automatically.',
  },
  {
    name: 'search',
    desc: 'Search every answer Dejavue has archived',
    who: 'anyone',
    help: 'Find a past answer. `match` loosens or tightens results; `threshold` sets an exact minimum match %.',
  },
  {
    name: 'insights',
    desc: 'Stats, resolution rate, top helpers, most-asked topics and the auto-FAQ',
    who: 'anyone',
    help: 'How your help channels are doing, and what people keep asking about.',
  },
  {
    name: 'settings',
    desc: 'Duplicate detection, stale-question nudges, the off-topic guard and cleanup',
    who: 'admin',
    help: 'Everything Dejavue does on its own, one page per feature, each explaining what members will see.',
  },
  {
    name: 'website',
    desc: 'Your public knowledge-base site — name, address, theme, privacy and imprint',
    who: 'admin',
    help: 'Turn the archive into a public site: pick the address, theme and whether it needs a passphrase.',
  },
  {
    name: 'rescan',
    desc: "Re-read a channel's full history and drop posts that were deleted",
    who: 'admin',
    help: "Catch up on anything posted while I was away, and forget threads that no longer exist.",
  },
  {
    name: 'help',
    desc: 'What Dejavue does, and every command explained',
    who: 'anyone',
    help: 'This page.',
  },
] as const satisfies readonly SubcommandCopy[];

export type SubcommandName = (typeof SUBCOMMANDS)[number]['name'];

const byName = new Map<string, SubcommandCopy>(SUBCOMMANDS.map((c) => [c.name, c]));

/** The copy for one subcommand. Throws on an unknown name so a typo fails at boot. */
export function subcommand(name: SubcommandName): SubcommandCopy {
  const found = byName.get(name);
  if (!found) throw new Error(`unknown subcommand: ${name}`);
  return found;
}

/**
 * The description Discord shows, with the audience appended. Admin-only
 * subcommands still appear in every member's picker — Discord only supports
 * default permissions on the *top-level* command, and search/insights/help are
 * for everyone — so the "(admin)" suffix is what sets expectations.
 */
export function commandDescription(name: SubcommandName): string {
  const c = subcommand(name);
  return c.who === 'admin' ? `${c.desc} (admin)` : c.desc;
}
