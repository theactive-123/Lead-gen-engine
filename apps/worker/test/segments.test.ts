import { describe, expect, it } from 'vitest';
import { segmentSql } from '@lead/shared';

describe('segment filter → SQL', () => {
  it('values go in bind parameters, never into the SQL text', () => {
    const evil = "US'); DROP TABLE domains; --";
    const { sql, params } = segmentSql(1, { countries: [evil], tech_not: ['Klaviyo'] });
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toEqual([1, ['Klaviyo'], [evil]]); // in filter-code order
    expect(sql).toContain('c.country = ANY($3::text[])');
  });
  it('always excludes not-a-fit (X) leads and suppressed domains/emails', () => {
    const { sql } = segmentSql(3, {});
    expect(sql).toContain("m.tier <> 'X'");
    expect(sql).toContain("x.kind = 'domain' AND x.value = d.domain");
    expect(sql).toContain("x.kind = 'email' AND x.value = lower(ct.email)");
  });
  it('"has all" filters compare the distinct count with the list length', () => {
    const { sql, params } = segmentSql(1, { tech_has: ['Facebook Pixel', 'Google Analytics'] });
    expect(sql).toMatch(/count\(DISTINCT t\.tech\).*= \$3/s);
    expect(params[2]).toBe(2);
  });
  it('rejects unknown keys, wrong types and empty lists', () => {
    expect(() => segmentSql(1, { bogus: 1 })).toThrow();
    expect(() => segmentSql(1, { tiers: ['Z'] })).toThrow();
    expect(() => segmentSql(1, { platforms: [] })).toThrow();
    expect(() => segmentSql(1, { first_seen_after: 'yesterday' })).toThrow();
  });
});
