import { promises as nodeDns } from 'node:dns';

/**
 * Custom-domain DNS guidance + live verification. A custom domain serves the
 * KB by pointing at the same host as `{slug}.{KB_BASE_DOMAIN}` — subdomains
 * via CNAME, apex domains via ALIAS/ANAME (a raw CNAME is not allowed at the
 * zone apex). TLS is provisioned automatically once DNS resolves to us.
 */

export interface DnsResolver {
  resolveCname(domain: string): Promise<string[]>;
  resolve4(domain: string): Promise<string[]>;
}

export interface DomainDnsResult {
  status: 'ok' | 'wrong-target' | 'unresolved';
  /** How the domain resolves: a CNAME chain or bare A records (apex/ALIAS). */
  via?: 'cname' | 'a';
  /** What we actually found (CNAME target or first A record), for diagnostics. */
  found?: string;
}

/** Does `domain` point at the KB host (directly, or by sharing its A records)? */
export async function checkDomainDns(
  domain: string,
  expectedHost: string,
  resolver: DnsResolver = nodeDns,
): Promise<DomainDnsResult> {
  const want = expectedHost.toLowerCase().replace(/\.$/, '');

  // Preferred setup: a CNAME pointing at (or under) the KB base domain.
  try {
    const target = (await resolver.resolveCname(domain))[0]?.toLowerCase().replace(/\.$/, '');
    if (target === want || target?.endsWith(`.${want}`)) {
      return { status: 'ok', via: 'cname', found: target };
    }
    if (target) return { status: 'wrong-target', via: 'cname', found: target };
  } catch {
    /* no CNAME — fall through to the A-record comparison */
  }

  // Apex/ALIAS setups have no visible CNAME: compare resolved A records instead.
  try {
    const [got, expected] = await Promise.all([resolver.resolve4(domain), resolver.resolve4(want)]);
    const expectedSet = new Set(expected);
    if (got.some((ip) => expectedSet.has(ip))) return { status: 'ok', via: 'a', found: got[0] };
    if (got.length) return { status: 'wrong-target', via: 'a', found: got[0] };
  } catch {
    /* NXDOMAIN / SERVFAIL / not yet propagated */
  }
  return { status: 'unresolved' };
}

/** Is this hostname a zone apex (example.com) rather than a subdomain? Naive two-label check. */
export function isApexDomain(domain: string): boolean {
  return domain.split('.').length <= 2;
}

/** The DNS record name to create at the provider ("help" for help.example.com, "@" for apex). */
export function dnsRecordName(domain: string): string {
  const parts = domain.split('.');
  return parts.length > 2 ? parts.slice(0, -2).join('.') : '@';
}

/** Human DNS setup instructions for a domain, as a Discord-markdown block. */
export function dnsInstructions(domain: string, kbHost: string): string {
  if (isApexDomain(domain)) {
    return (
      `Your domain is a **zone apex**, where plain CNAME records aren't allowed. In your DNS provider for \`${domain}\`, add:\n` +
      '```\n' +
      `Type: ALIAS (or ANAME / flattened CNAME)\nName: @\nTarget: ${kbHost}\n` +
      '```\n' +
      `If your provider has no ALIAS support, use a subdomain instead (e.g. \`help.${domain}\`).`
    );
  }
  return (
    `In your DNS provider for \`${domain.split('.').slice(-2).join('.')}\`, add:\n` +
    '```\n' +
    `Type: CNAME\nName: ${dnsRecordName(domain)}\nTarget: ${kbHost}\n` +
    '```'
  );
}
