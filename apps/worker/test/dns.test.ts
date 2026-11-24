import { describe, expect, it } from 'vitest';
import { matchSignatures, type Signature } from '../src/stages/dns/stage.js';

// Records as seen in the Phase 3 DNS run (2026-11-24).
const rec = (o: Partial<Record<'a' | 'www_cname' | 'www_a' | 'mx' | 'ns', string[]>>) => ({ domain: 'x.com', a: [], www_cname: [], www_a: [], mx: [], ns: [], ...o });
const sig = (kind: string, name: string, record: Signature['record'], re: RegExp): Signature => ({ kind, name, record, re });

describe('matchSignatures', () => {
  const sigs = [
    sig('platform', 'Squarespace', 'www_cname', /^ext-(cust|sq)\.squarespace\.com$/),
    sig('platform', 'Wix', 'www_cname', /\.wixdns\.net$/),
    sig('mx_provider', 'Google Workspace', 'mx', /(^|\.)google\.com$|googlemail\.com$/),
  ];
  it('finds platform and mail provider independently', () => {
    const m = matchSignatures(rec({ a: ['198.185.159.145'], www_cname: ['ext-sq.squarespace.com'], mx: ['aspmx.l.google.com'] }), sigs);
    expect(m).toEqual({ platform: 'Squarespace', mx_provider: 'Google Workspace', parking: null });
  });
  it('returns nulls when nothing matches', () => {
    expect(matchSignatures(rec({ a: ['84.32.84.58'], ns: ['ns2.dns-parking.com'] }), sigs)).toEqual({ platform: null, mx_provider: null, parking: null });
  });
});
