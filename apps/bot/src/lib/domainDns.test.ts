import { describe, expect, it } from 'vitest';
import {
  checkDomainDns,
  dnsInstructions,
  dnsRecordName,
  type DnsResolver,
  isApexDomain,
} from './domainDns';

const resolver = (cnames: Record<string, string[]>, a: Record<string, string[]>): DnsResolver => ({
  resolveCname: async (d) => {
    const r = cnames[d];
    if (!r) throw new Error('ENODATA');
    return r;
  },
  resolve4: async (d) => {
    const r = a[d];
    if (!r) throw new Error('NXDOMAIN');
    return r;
  },
});

describe('checkDomainDns', () => {
  it('accepts a CNAME to the KB host (also with trailing dot / any casing)', async () => {
    const r = resolver({ 'help.acme.com': ['Dejavue.app.'] }, {});
    expect(await checkDomainDns('help.acme.com', 'dejavue.app', r)).toEqual({
      status: 'ok',
      via: 'cname',
      found: 'dejavue.app',
    });
  });

  it('accepts an apex ALIAS that shares the KB host A records', async () => {
    const r = resolver({}, { 'acme.com': ['1.2.3.4'], 'dejavue.app': ['1.2.3.4', '5.6.7.8'] });
    expect((await checkDomainDns('acme.com', 'dejavue.app', r)).status).toBe('ok');
  });

  it('flags a CNAME pointing elsewhere with what it found', async () => {
    const r = resolver({ 'help.acme.com': ['pages.github.io'] }, {});
    expect(await checkDomainDns('help.acme.com', 'dejavue.app', r)).toEqual({
      status: 'wrong-target',
      via: 'cname',
      found: 'pages.github.io',
    });
  });

  it('reports unresolved when nothing is configured yet', async () => {
    const r = resolver({}, { 'dejavue.app': ['1.2.3.4'] });
    expect((await checkDomainDns('help.acme.com', 'dejavue.app', r)).status).toBe('unresolved');
  });
});

describe('dns instructions', () => {
  it('derives the record name from the subdomain', () => {
    expect(dnsRecordName('help.acme.com')).toBe('help');
    expect(dnsRecordName('docs.eu.acme.com')).toBe('docs.eu');
    expect(dnsRecordName('acme.com')).toBe('@');
  });

  it('recommends CNAME for subdomains and ALIAS for the apex', () => {
    expect(isApexDomain('acme.com')).toBe(true);
    expect(isApexDomain('help.acme.com')).toBe(false);
    expect(dnsInstructions('help.acme.com', 'dejavue.app')).toContain('Type: CNAME');
    expect(dnsInstructions('help.acme.com', 'dejavue.app')).toContain('Name: help');
    expect(dnsInstructions('help.acme.com', 'dejavue.app')).toContain('Target: dejavue.app');
    expect(dnsInstructions('acme.com', 'dejavue.app')).toContain('ALIAS');
    expect(dnsInstructions('acme.com', 'dejavue.app')).toContain('Name: @');
  });
});
