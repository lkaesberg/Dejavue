import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { ADMIN_SUFFIX, commandDescription, SUBCOMMANDS } from './commandCopy';
import { canResolveThread, NO_PERMISSION_MESSAGE, RESOLVE_PERMISSION_HINT } from './permissions';

// Top.gg rejected a submission because the bot "asks for some unknown permission
// or role in order to run commands". Every refusal must therefore name a real
// Discord permission, exactly as Server Settings → Roles spells it — never a
// role ("moderator", "staff") and never a bare "admin".
const DISCORD_PERMISSION_NAMES = [
  'View Channel',
  'Send Messages',
  'Send Messages in Threads',
  'Embed Links',
  'Read Message History',
  'Manage Threads',
  'Manage Channels',
  'Manage Server',
  'Timeout Members',
  'Administrator',
];

const VAGUE = /\b(moderator|mod team|staff|helper role|an admin|admin-only|\(admin\))\b/i;

describe('resolve-permission copy', () => {
  it('names Discord permissions instead of a role', () => {
    for (const copy of [NO_PERMISSION_MESSAGE, RESOLVE_PERMISSION_HINT]) {
      expect(copy).not.toMatch(VAGUE);
      expect(
        DISCORD_PERMISSION_NAMES.some((name) => copy.includes(name)),
        copy,
      ).toBe(true);
    }
  });

  it('lets the asker resolve their own post with no permissions at all', () => {
    expect(canResolveThread(null, true)).toBe(true);
  });

  it('accepts each permission the copy promises, and nothing else', () => {
    const allow = [
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.Administrator,
    ];
    for (const bit of allow) {
      expect(canResolveThread(new PermissionsBitField(bit), false)).toBe(true);
    }
    // A plain member — SendMessages alone — is refused.
    expect(
      canResolveThread(new PermissionsBitField(PermissionFlagsBits.SendMessages), false),
    ).toBe(false);
  });
});

describe('admin subcommand labelling', () => {
  it('names the permission in the picker rather than saying "(admin)"', () => {
    expect(ADMIN_SUFFIX).toContain('Manage Server');
    for (const c of SUBCOMMANDS.filter((s) => s.who === 'admin')) {
      expect(commandDescription(c.name), c.name).toContain('Manage Server');
      expect(commandDescription(c.name), c.name).not.toMatch(/\(admin\)/i);
    }
  });
});
