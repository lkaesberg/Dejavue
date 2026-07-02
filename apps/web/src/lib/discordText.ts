/**
 * Replace raw Discord markup with privacy-safe text for KB pages.
 *
 * Transcripts store message content verbatim, so user mentions arrive as
 * `<@123456789>` — a raw snowflake that both looks broken and leaks a stable
 * user id on the public site. Map user mentions to the page's anonymized
 * speaker alias ("@Original poster", "@Helper 2"); strip ids from role and
 * channel mentions and custom emoji.
 */
export function resolveMentions(text: string, aliasOf?: (id: string) => string): string {
  return text
    .replace(/<@!?(\d{5,})>/g, (_, id: string) => `@${aliasOf?.(id) ?? 'Member'}`)
    .replace(/<@&\d{5,}>/g, '@role')
    .replace(/<#(\d{5,})>/g, '#channel')
    .replace(/<a?:(\w+):\d{5,}>/g, ':$1:');
}
