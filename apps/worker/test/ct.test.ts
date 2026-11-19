import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDataTile, decodeRfc6962Entry, tilePath } from '../src/sources/ct/leaves.js';

const fx = (f: string) => new URL(`./fixtures/ct/${f}`, import.meta.url);

describe('static-ct-api data tiles (real fixtures, 2026-11-19)', () => {
  it.each(['letsencrypt-sycamore-2026h2.tile', 'google-parcelyard-2026h2.tile'])('%s decodes 256 entries exactly', (f) => {
    const certs = decodeDataTile(readFileSync(fx(f)));
    expect(certs).toHaveLength(256);
    // Certificates for bare IP addresses carry no DNS names (verified: 51 of 512 in these tiles).
    expect(certs.filter((c) => c.names.length > 0).length).toBeGreaterThan(200);
    expect(certs.every((c) => c.timestamp > Date.parse('2026-11-19') && c.timestamp < Date.parse('2026-11-20'))).toBe(true);
    expect(certs.some((c) => c.precert)).toBe(true);
    expect(certs.some((c) => !c.precert)).toBe(true);
  });

  it('rejects a truncated tile instead of returning garbage', () => {
    const buf = readFileSync(fx('letsencrypt-sycamore-2026h2.tile'));
    expect(() => decodeDataTile(buf.subarray(0, buf.length - 7))).toThrow();
  });
});

describe('RFC 6962 get-entries (real fixture, Cloudflare Nimbus 2026)', () => {
  it('decodes x509 and precert entries with names', () => {
    const json = JSON.parse(readFileSync(fx('cloudflare-nimbus2026-get-entries.json'), 'utf8'));
    const certs = json.entries.map((e: any) => decodeRfc6962Entry(e.leaf_input, e.extra_data));
    expect(certs).toHaveLength(32);
    expect(certs.every((c: any) => c && c.names.length > 0)).toBe(true);
    expect(certs.some((c: any) => c.precert)).toBe(true);
  });
});

describe('tilePath', () => {
  it('follows the static-ct-api path encoding', () => {
    expect(tilePath(0)).toBe('000');
    expect(tilePath(67)).toBe('067');
    expect(tilePath(1234067)).toBe('x001/x234/067');
    expect(tilePath(4349081)).toBe('x004/x349/081');
  });
});

describe('activeShards', () => {
  it('keeps only shards whose expiry window covers today + N days', async () => {
    const { activeShards } = await import('../src/sources/ct/logs.js');
    const day = 86_400_000;
    const iso = (d: number) => new Date(Date.now() + d * day).toISOString();
    const logs = [
      { id: 'past', name: 'ends soon', kind: 'tiled' as const, url: 'a', startInclusive: iso(-200), endExclusive: iso(20) },
      { id: 'now', name: 'covers +60d', kind: 'tiled' as const, url: 'b', startInclusive: iso(30), endExclusive: iso(200) },
      { id: 'future', name: 'starts later', kind: 'rfc6962' as const, url: 'c', startInclusive: iso(180), endExclusive: iso(360) },
    ];
    expect(activeShards(logs, 60).map((l) => l.id)).toEqual(['now']);
  });
});
