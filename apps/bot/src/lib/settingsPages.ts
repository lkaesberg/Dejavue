import {
  ActionRowBuilder,
  type APIEmbedField,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { customSimilarity, dedupSettingLabel } from '@dejavue/core';
import type { GuildConfig } from '@dejavue/db';

/**
 * The settings hub, one page per feature.
 *
 * Why pages: the old hub put four toggles and four selects on one screen, which
 * used all five action rows Discord allows — leaving no room for navigation, and
 * no room to say what any of it meant. An admin saw `Fit-check: on` with nothing
 * explaining what a fit check is or what members would see.
 *
 * Each page here owns its copy AND its controls, so the explanation can't drift
 * away from the thing it explains. The prose answers three questions: what the
 * feature does, what a member actually sees, and what each option changes.
 *
 * Page state needs no storage — every control id names its own page
 * (`dv:s:<page>:<control>`), so the page to re-render is read straight off the
 * customId that fired.
 */

export const SETTINGS_PREFIX = 'dv:s:';
export const PAGER_ID = `${SETTINGS_PREFIX}pager`;

export type SettingsPageId = 'overview' | 'duplicates' | 'nudges' | 'routing' | 'cleanup';

export const DEFAULT_PAGE: SettingsPageId = 'overview';

/** Build a control id that carries its own page. */
export const ctrl = (page: SettingsPageId, control: string): string =>
  `${SETTINGS_PREFIX}${page}:${control}`;

/** The page a settings customId belongs to, or null. The pager has no page of its own. */
export function pageOf(customId: string): SettingsPageId | null {
  if (!customId.startsWith(SETTINGS_PREFIX) || customId === PAGER_ID) return null;
  const page = customId.slice(SETTINGS_PREFIX.length).split(':')[0];
  return SETTINGS_PAGES.some((p) => p.id === page) ? (page as SettingsPageId) : null;
}

export const isSettingsInteraction = (customId: string): boolean =>
  customId.startsWith(SETTINGS_PREFIX);

export type HubRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>
  | ActionRowBuilder<RoleSelectMenuBuilder>;

export interface SettingsCtx {
  /**
   * True when the tier forces the Dejavue footer on (Free). The branding toggle
   * still renders, disabled, rather than vanishing — a setting that appears and
   * disappears with your plan is more confusing than one that explains itself.
   */
  brandingLocked: boolean;
}

export interface SettingsPage {
  id: SettingsPageId;
  emoji: string;
  /** Pager option label. Hard limit 100. */
  label: string;
  /** Pager option description. Hard limit 100 — the tightest copy in the hub. */
  blurb: string;
  title: string;
  /** What it does / what members see / what the options change. */
  explain: string;
  fields(cfg: GuildConfig, ctx: SettingsCtx): APIEmbedField[];
  /** Controls only. The pager takes row 1 and the nav row takes row 5. */
  rows(cfg: GuildConfig, ctx: SettingsCtx): HubRow[];
}

const onOff = (b: boolean): string => (b ? 'on' : 'off');

function toggle(id: string, label: string, on: boolean, disabled = false): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(disabled);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const overview: SettingsPage = {
  id: 'overview',
  emoji: '📋',
  label: 'Overview',
  blurb: 'Every setting and its current value, on one page',
  title: 'Settings ▸ Overview',
  explain:
    "Everything Dejavue does on its own. Pick a page from the menu below to change something — each page explains what the feature does and what your members will see.\n\nEvery plan gets all of these. The one exception is hiding the *“Powered by Dejavue”* footer, which needs **Plus**.",
  fields: (cfg, ctx) => [
    {
      name: '🔁 Duplicate detection',
      value: `Suggests an existing answer on a new question · **${dedupSettingLabel(cfg.dedupSensitivity)}**`,
    },
    {
      name: '⏰ Stale-question nudges',
      value: cfg.nudgeEnabled
        ? `**on** — after ${cfg.nudgeAfterHours}h${cfg.nudgeHelperRoleId ? `, pinging <@&${cfg.nudgeHelperRoleId}>` : ', pinging nobody'}`
        : '**off** — unanswered questions are left alone',
    },
    {
      name: '🧭 Channel routing',
      value: [
        `Fit suggestions **${onOff(cfg.channelFitCheck)}**`,
        cfg.guardEnabled
          ? `off-topic guard **on** (${cfg.guardAutoClose ? 'closes the post' : 'warns only'}, ${cfg.guardSensitivity} confidence)`
          : 'off-topic guard **off**',
      ].join(' · '),
    },
    {
      name: '🧹 Cleanup & branding',
      value: [
        `Solved prompt is **${cfg.removeSolvedPrompt ? 'deleted' : 'kept'}**`,
        `footer **${ctx.brandingLocked || cfg.brandingEnabled ? 'shown' : 'hidden'}**${ctx.brandingLocked ? ' (Plus to hide)' : ''}`,
      ].join(' · '),
    },
  ],
  rows: () => [],
};

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

const duplicates: SettingsPage = {
  id: 'duplicates',
  emoji: '🔁',
  label: 'Duplicate detection',
  blurb: 'How eagerly I suggest an answer you already have',
  title: 'Settings ▸ Duplicate detection',
  explain:
    "When someone posts a new question I compare it against every solved post I've archived. If one is close enough I reply with the match, plus a **Use this answer & close** button that copies the old answer over and marks the new post solved.\n\n**Sensitivity** decides how close \"close enough\" is. Nothing ever closes by itself — a suggestion takes one click to dismiss, so guessing wrong costs far less than missing a duplicate.",
  fields: (cfg) => [
    { name: 'Sensitivity', value: dedupSettingLabel(cfg.dedupSensitivity), inline: true },
    {
      name: 'What members see',
      value: 'A reply listing up to 3 similar solved posts, with **Use this answer & close** and **Not a duplicate**.',
    },
  ],
  rows: (cfg) => {
    const isCustom = customSimilarity(cfg.dedupSensitivity) !== undefined;
    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(ctrl('duplicates', 'sens'))
          .setPlaceholder(`Sensitivity: ${dedupSettingLabel(cfg.dedupSensitivity)}`)
          .addOptions(
            {
              label: 'Only near-identical reposts',
              description: 'Fewest suggestions — catches the same question asked twice.',
              value: 'low',
              default: cfg.dedupSensitivity === 'low',
            },
            {
              label: 'Balanced (default)',
              description: 'Also catches the same problem worded differently.',
              value: 'medium',
              default: cfg.dedupSensitivity === 'medium',
            },
            {
              label: 'Also loosely-related posts',
              description: 'Catches more, and sometimes suggests a neighbouring question.',
              value: 'high',
              default: cfg.dedupSensitivity === 'high',
            },
            {
              label: isCustom
                ? `Custom: ${dedupSettingLabel(cfg.dedupSensitivity)} — change…`
                : 'Custom — set an exact match %…',
              description: 'Type the minimum match percentage yourself.',
              value: 'custom',
              default: isCustom,
            },
          ),
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Stale-question nudges
// ---------------------------------------------------------------------------

const NUDGE_HOURS = [6, 12, 24, 48, 72] as const;

const nudges: SettingsPage = {
  id: 'nudges',
  emoji: '⏰',
  label: 'Stale-question nudges',
  blurb: 'Chase up questions nobody has answered yet',
  title: 'Settings ▸ Stale-question nudges',
  explain:
    'If a question is still unanswered after a while, I post a reminder in the thread and can ping a helper role. Off by default — nothing is posted until you turn this on.\n\n**Wait time** counts from when the post was created, not from the last reply. **Helper role** is optional: with none set the reminder still appears, it just pings nobody.',
  fields: (cfg) => [
    { name: 'Status', value: cfg.nudgeEnabled ? '✅ on' : '⛔ off', inline: true },
    { name: 'Wait time', value: `${cfg.nudgeAfterHours} hours`, inline: true },
    {
      name: 'Pings',
      value: cfg.nudgeHelperRoleId ? `<@&${cfg.nudgeHelperRoleId}>` : 'nobody — reminder only',
      inline: true,
    },
  ],
  // NOTE: 3 rows here + the pager + the nav row is exactly Discord's limit of 5.
  // There is no room for a fourth control on this page, ever.
  rows: (cfg) => {
    const role = new RoleSelectMenuBuilder()
      .setCustomId(ctrl('nudges', 'role'))
      .setPlaceholder('Helper role to ping (clear the menu for none)')
      .setMinValues(0)
      .setMaxValues(1);
    // Without this the menu reads "Helper role to ping" forever, even after one
    // is set — the old hub never showed the admin what they had chosen.
    if (cfg.nudgeHelperRoleId) role.setDefaultRoles(cfg.nudgeHelperRoleId);
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        toggle(ctrl('nudges', 'toggle'), `Nudges: ${onOff(cfg.nudgeEnabled)}`, cfg.nudgeEnabled),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(ctrl('nudges', 'hours'))
          .setPlaceholder(`Nudge after: ${cfg.nudgeAfterHours} hours`)
          .addOptions(
            NUDGE_HOURS.map((h) => ({
              label: `After ${h} hours`,
              value: String(h),
              default: cfg.nudgeAfterHours === h,
            })),
          ),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(role),
    ];
  },
};

// ---------------------------------------------------------------------------
// Channel routing & the off-topic guard
// ---------------------------------------------------------------------------

const routing: SettingsPage = {
  id: 'routing',
  emoji: '🧭',
  label: 'Channel routing & off-topic guard',
  blurb: 'Suggest — or enforce — the right channel for a post',
  title: 'Settings ▸ Channel routing',
  explain:
    "Two escalating checks on \"is this in the right channel?\", both based on each monitored channel's description. Give your channels good descriptions and both get noticeably better.\n\n**Fit suggestions** — if another monitored channel fits better, I post a gentle *“might fit better in #other”* with a **Move it there** button. Nothing happens unless someone clicks it.\n\n**Off-topic guard** — for posts that clearly don't belong anywhere here, I post a warning instead. With **auto-close** on I also tag the post `wrong-channel` and close the thread.\n\n**Guard confidence** is how sure I must be before doing that.",
  fields: (cfg) => [
    { name: 'Fit suggestions', value: cfg.channelFitCheck ? '✅ on' : '⛔ off', inline: true },
    {
      name: 'Off-topic guard',
      value: cfg.guardEnabled ? (cfg.guardAutoClose ? '✅ on — closes the post' : '✅ on — warns only') : '⛔ off',
      inline: true,
    },
    { name: 'Guard confidence', value: cfg.guardSensitivity, inline: true },
  ],
  rows: (cfg) => [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      toggle(ctrl('routing', 'fit'), `Fit suggestions: ${onOff(cfg.channelFitCheck)}`, cfg.channelFitCheck),
      toggle(ctrl('routing', 'guard'), `Off-topic guard: ${onOff(cfg.guardEnabled)}`, cfg.guardEnabled),
      // Auto-close does nothing while the guard is off — grey it out rather than
      // letting an admin flip a switch with no effect.
      toggle(
        ctrl('routing', 'autoclose'),
        `Auto-close: ${onOff(cfg.guardAutoClose)}`,
        cfg.guardAutoClose,
        !cfg.guardEnabled,
      ),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(ctrl('routing', 'sens'))
        .setPlaceholder(`Guard confidence: ${cfg.guardSensitivity}`)
        .setDisabled(!cfg.guardEnabled)
        .addOptions(
          {
            label: 'Only when it is unmistakable',
            description: 'Fewest warnings — a post must be plainly off-topic.',
            value: 'low',
            default: cfg.guardSensitivity === 'low',
          },
          {
            label: 'Balanced (default)',
            description: "Warns on posts that don't match the channel description.",
            value: 'medium',
            default: cfg.guardSensitivity === 'medium',
          },
          {
            label: 'Flag aggressively',
            description: 'Catches more, and will sometimes warn on a borderline post.',
            value: 'high',
            default: cfg.guardSensitivity === 'high',
          },
        ),
    ),
  ],
};

// ---------------------------------------------------------------------------
// Cleanup & branding
// ---------------------------------------------------------------------------

const cleanup: SettingsPage = {
  id: 'cleanup',
  emoji: '🧹',
  label: 'Cleanup & branding',
  blurb: 'What my own messages leave behind in your channels',
  title: 'Settings ▸ Cleanup & branding',
  explain:
    '**Solved prompt** — every question gets a *“Got your answer?”* message from me. When the post is marked solved I can delete that message, or keep it and edit it into a solved notice. Deleting leaves a tidier thread; keeping it leaves a visible record of who solved the post and when.\n\n**Footer** — the *“Powered by Dejavue”* line on my embeds and on your public site. Hiding it is a **Plus** feature: on the free plan the footer stays, and that is the trade for everything else the free plan includes.',
  fields: (cfg, ctx) => [
    {
      name: 'When a post is solved',
      value: cfg.removeSolvedPrompt ? 'My prompt is deleted' : 'My prompt stays, edited into a notice',
      inline: true,
    },
    {
      name: 'Footer',
      value: ctx.brandingLocked
        ? 'Shown — hiding it needs **Plus**'
        : cfg.brandingEnabled
          ? 'Shown'
          : 'Hidden',
      inline: true,
    },
  ],
  rows: (cfg, ctx) => [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      toggle(
        ctrl('cleanup', 'prompt'),
        cfg.removeSolvedPrompt ? 'Solved prompt: deleted' : 'Solved prompt: kept',
        cfg.removeSolvedPrompt,
      ),
      // Disabled rather than hidden on Free: a control that vanishes with your
      // plan is more confusing than one that says why it won't move.
      toggle(
        ctrl('cleanup', 'branding'),
        ctx.brandingLocked
          ? 'Footer: shown (Plus to hide)'
          : cfg.brandingEnabled
            ? 'Footer: shown'
            : 'Footer: hidden',
        ctx.brandingLocked || cfg.brandingEnabled,
        ctx.brandingLocked,
      ),
    ),
  ],
};

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  overview,
  duplicates,
  nudges,
  routing,
  cleanup,
];

export function settingsPage(id: SettingsPageId): SettingsPage {
  return SETTINGS_PAGES.find((p) => p.id === id) ?? overview;
}

/** The page picker — row 1 of every settings page. */
export function pagerRow(active: SettingsPageId): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(PAGER_ID)
      .setPlaceholder('Jump to a setting…')
      .addOptions(
        SETTINGS_PAGES.map((p) => ({
          label: p.label,
          description: p.blurb,
          value: p.id,
          emoji: p.emoji,
          default: p.id === active,
        })),
      ),
  );
}
