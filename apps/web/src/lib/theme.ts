import type { GuildConfig } from '@dejavue/db';

// Port of the Claude Design `applyTheme()` token system. Each tenant's
// `/dejavue customize` choices (theme / accent / corners / heading font) become a
// block of CSS custom properties rendered into the page <head>, so every component
// can reference var(--token) and the whole site re-skins per guild.

interface Accent {
  a: string;
  b: string;
  softL: string;
  softD: string;
  lineL: string;
  lineD: string;
}

export const ACCENTS: Record<string, Accent> = {
  indigo: { a: '#4F46E5', b: '#7C3AED', softL: '#F2F0FC', softD: 'rgba(124,58,237,0.20)', lineL: '#4F46E5', lineD: '#A78BFA' },
  blue: { a: '#2563EB', b: '#4F46E5', softL: '#EAF1FE', softD: 'rgba(37,99,235,0.22)', lineL: '#2563EB', lineD: '#88ABF7' },
  teal: { a: '#0D9488', b: '#2DD4BF', softL: '#E6FAF6', softD: 'rgba(13,148,136,0.24)', lineL: '#0F9B82', lineD: '#34E0C6' },
  violet: { a: '#7C3AED', b: '#A855F7', softL: '#F5EEFE', softD: 'rgba(168,85,247,0.22)', lineL: '#7C3AED', lineD: '#C9A6FB' },
  amber: { a: '#D97706', b: '#F59E0B', softL: '#FDF1E0', softD: 'rgba(217,119,6,0.24)', lineL: '#B45309', lineD: '#F6B860' },
};

const FONTS: Record<string, string> = {
  grotesk: "'Space Grotesk', sans-serif",
  sans: "'Inter', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

type ThemeInput = Pick<GuildConfig, 'kbTheme' | 'kbAccent' | 'kbCorners' | 'kbHeadingFont'> | null | undefined;

/** Build the CSS custom-property declarations for a tenant's appearance settings. */
export function themeVars(cfg: ThemeInput): string {
  const dark = cfg?.kbTheme === 'dark';
  const ac = ACCENTS[cfg?.kbAccent ?? 'indigo'] ?? ACCENTS.indigo!;
  const sharp = cfg?.kbCorners === 'sharp';
  const headfont = FONTS[cfg?.kbHeadingFont ?? 'grotesk'] ?? FONTS.grotesk!;

  const palette = dark
    ? {
        bg: '#14161F', sidebar: '#171922', hero1: '#1C1F2C', hero2: '#14161F',
        surface: '#1C1F2B', surface2: '#232634', border: '#2A2D3C', border2: '#363A4E',
        text: '#F1F2F8', textmid: '#B4B8CE', textmut: '#838AA6',
        chipbg: '#262A38', chiptext: '#A2A7C2', inputbg: '#1F2230', footerbg: '#171922',
        ansbg: 'rgba(45,212,191,0.08)', ansborder: 'rgba(45,212,191,0.32)',
        solvedbg: 'rgba(45,212,191,0.14)', solvedfg: '#3FE0C4',
        accentsoft: ac.softD, accentline: ac.lineD,
      }
    : {
        bg: '#FFFFFF', sidebar: '#FCFCFE', hero1: '#F8F7FE', hero2: '#FFFFFF',
        surface: '#FFFFFF', surface2: '#FAFAFD', border: '#ECECF3', border2: '#E1E1EC',
        text: '#14152A', textmid: '#565A73', textmut: '#9398B4',
        chipbg: '#F4F4F9', chiptext: '#9398B4', inputbg: '#F5F5FA', footerbg: '#FCFCFE',
        ansbg: '#F4FDFA', ansborder: '#B7EFE2',
        solvedbg: '#E6FAF5', solvedfg: '#0F9B82',
        accentsoft: ac.softL, accentline: ac.lineL,
      };

  return [
    `--bg:${palette.bg}`, `--sidebar:${palette.sidebar}`, `--hero1:${palette.hero1}`, `--hero2:${palette.hero2}`,
    `--surface:${palette.surface}`, `--surface2:${palette.surface2}`, `--border:${palette.border}`, `--border2:${palette.border2}`,
    `--text:${palette.text}`, `--textmid:${palette.textmid}`, `--textmut:${palette.textmut}`,
    `--chipbg:${palette.chipbg}`, `--chiptext:${palette.chiptext}`, `--inputbg:${palette.inputbg}`, `--footerbg:${palette.footerbg}`,
    `--ansbg:${palette.ansbg}`, `--ansborder:${palette.ansborder}`,
    `--solvedbg:${palette.solvedbg}`, `--solvedfg:${palette.solvedfg}`,
    `--accent:${ac.a}`, `--accent2:${ac.b}`, `--accentsoft:${palette.accentsoft}`, `--accentline:${palette.accentline}`,
    `--rad:${sharp ? '6px' : '14px'}`, `--radsm:${sharp ? '5px' : '10px'}`,
    `--headfont:${headfont}`,
  ].join('; ');
}

/** Display name for a tenant (brand override → slug → fallback). */
export function brandOf(cfg: { brandName?: string | null; kbSlug?: string | null } | null, slug?: string): string {
  return cfg?.brandName?.trim() || cfg?.kbSlug || slug || 'Knowledge Base';
}

export function brandInitial(name: string): string {
  return (name.trim()[0] ?? 'D').toUpperCase();
}

// Deterministic per-channel dot color (the design's category palette), so each
// channel keeps a stable color across the sidebar, cards and badges.
const DOT_PALETTE = ['#6366F1', '#7C3AED', '#2DD4BF', '#8B5CF6', '#4F46E5', '#A78BFA', '#2563EB', '#0F9B82'];

export function channelDot(channelId: string): string {
  let h = 0;
  for (let i = 0; i < channelId.length; i++) h = (h * 31 + channelId.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length]!;
}

/** A "#channel-name" handle from a display name. */
export function channelHandle(name: string): string {
  return `#${name.toLowerCase().replace(/\s+/g, '-')}`;
}

export interface ChannelKind {
  /** Human label shown on the KB. */
  label: string;
  /** Short code (qa | knowledge | knowledge-channel). */
  code: 'qa' | 'knowledge' | 'knowledge-channel';
  bg: string;
  fg: string;
}

type KindInput =
  | { trackedChannelIds?: string[] | null; channelModes?: Record<string, string> | null }
  | null
  | undefined;

/**
 * What kind of channel a KB category came from, for the badge on the site:
 *  - Knowledge channel — a tracked normal text channel (every message indexed)
 *  - Knowledge        — a forum in "knowledge" mode (every thread published)
 *  - Q&A              — a classic question forum (solved threads published)
 */
export function channelKind(cfg: KindInput, channelId: string): ChannelKind {
  if (cfg?.trackedChannelIds?.includes(channelId)) {
    return { label: 'Knowledge channel', code: 'knowledge-channel', bg: '#EEF6FF', fg: '#2563EB' };
  }
  if (cfg?.channelModes?.[channelId] === 'knowledge') {
    return { label: 'Knowledge', code: 'knowledge', bg: '#E6FAF5', fg: '#0F9B82' };
  }
  return { label: 'Q&A', code: 'qa', bg: 'var(--accentsoft)', fg: 'var(--accentline)' };
}
