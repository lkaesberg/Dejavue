import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  PermissionFlagsBits,
} from 'discord.js';

/**
 * Cross-hub navigation.
 *
 * Every hub used to be a dead end: the dashboard was only reachable by running
 * `/dejavue setup` with no options, and nothing linked anywhere else. A nav row
 * at the bottom of each hub means an admin can reach everything from wherever
 * they landed, without memorising eight subcommand names.
 *
 * This module is deliberately PURE — it imports only discord.js and knows
 * nothing about what any hub renders. That is what lets both `hubs.ts` and
 * `customize.ts` import it without creating a cycle. The module that knows both
 * hubs is `hubRouter.ts`, and nothing imports that back.
 */

export type HubId = 'dashboard' | 'settings' | 'website' | 'insights' | 'help';

export const NAV_PREFIX = 'dv:nav:';

export const isNavInteraction = (customId: string): boolean => customId.startsWith(NAV_PREFIX);

export const navId = (hub: HubId): string => `${NAV_PREFIX}${hub}`;

interface NavEntry {
  hub: HubId;
  emoji: string;
  label: string;
  /** Whether reaching this hub needs Manage Server. */
  admin: boolean;
}

const NAV: readonly NavEntry[] = [
  { hub: 'dashboard', emoji: '🏠', label: 'Dashboard', admin: true },
  { hub: 'settings', emoji: '⚙️', label: 'Settings', admin: true },
  { hub: 'website', emoji: '🌐', label: 'Website', admin: true },
  { hub: 'insights', emoji: '📈', label: 'Insights', admin: false },
  { hub: 'help', emoji: '❓', label: 'Help', admin: false },
];

/** The hub a nav customId points at, or null if it isn't a nav id. */
export function navTarget(customId: string): HubId | null {
  if (!isNavInteraction(customId)) return null;
  const hub = customId.slice(NAV_PREFIX.length);
  return NAV.some((n) => n.hub === hub) ? (hub as HubId) : null;
}

/** Does reaching this hub require Manage Server? */
export function navNeedsAdmin(hub: HubId): boolean {
  return NAV.find((n) => n.hub === hub)?.admin ?? false;
}

/**
 * The shared nav row. Exactly five slots, which is also the per-row button cap —
 * there is no room for a sixth destination.
 *
 * The hub you're already in renders disabled, so the row doubles as a "you are
 * here". Pass `backTo` when a hub has inner pages (the website hub's appearance
 * page): that slot becomes an enabled "◀ Back" pointing at the given customId,
 * because on an inner page "go to Website" means something useful.
 *
 * A non-admin gets only the destinations they can actually open — hiding them
 * beats letting someone click into a permission refusal.
 */
export function navRow(
  active: HubId,
  opts: { admin: boolean; backTo?: string },
): ActionRowBuilder<ButtonBuilder> {
  const buttons = NAV.filter((n) => opts.admin || !n.admin).map((n) => {
    if (n.hub === active && opts.backTo) {
      return new ButtonBuilder()
        .setCustomId(opts.backTo)
        .setLabel('Back')
        .setEmoji('◀️')
        .setStyle(ButtonStyle.Secondary);
    }
    return new ButtonBuilder()
      .setCustomId(navId(n.hub))
      .setLabel(n.label)
      .setEmoji(n.emoji)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(n.hub === active);
  });
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** Discord's hard cap: five action rows per message. */
export const MAX_ROWS = 5;

/**
 * discord.js does NOT validate the five-row limit locally — a sixth row builds
 * fine and then fails as a 400 in someone's server. Every hub renderer runs its
 * rows through here so an over-budget layout fails in tests instead.
 */
export function assertRowBudget<T>(rows: T[], where: string): T[] {
  if (rows.length > MAX_ROWS) {
    throw new Error(`${where}: ${rows.length} action rows exceeds Discord's limit of ${MAX_ROWS}`);
  }
  return rows;
}

export interface HubCtx {
  /** Whether the viewer has Manage Server — decides which nav buttons they get. */
  admin: boolean;
}

export const isHubAdmin = (i: {
  memberPermissions?: { has(p: bigint): boolean } | null;
}): boolean => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

export const hubCtx = (i: Interaction): HubCtx => ({ admin: isHubAdmin(i) });
