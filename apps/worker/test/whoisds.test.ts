import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sources/http.js', () => ({
  withRetry: (fn: () => unknown) => fn(),
  fetchText: async () => readFileSync(new URL('./fixtures/whoisds-page.html', import.meta.url), 'utf8'),
  fetchBuffer: async () => Buffer.alloc(0),
}));

describe('WhoisDS download page (real fixture, 2026-11-19)', () => {
  it('finds the daily files and decodes their dates from the link', async () => {
    const { listDays } = await import('../src/sources/whoisds.js');
    const days = await listDays();
    // The free page lists only the last few days (4 on 2026-11-19), so we fetch every 6 hours.
    expect(days.length).toBeGreaterThanOrEqual(3);
    expect(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
    expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());
    expect(days.at(-1)!.url).toMatch(/^https:\/\/www\.whoisds\.com\/+whois-database\/newly-registered-domains\/.+\/nrd$/);
  });
});
