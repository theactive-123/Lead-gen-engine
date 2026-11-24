import { datasetExists, datasetGlob, db, lakeQuery, setting, sqlLiteral, withRun, writeParquet } from '@lead/shared';
import { REGISTRY_FILE } from '../normalize.js';
import { loadBatch, type StagePlan } from '../plan.js';
import { dohClient, udpClient, type DnsClient } from './resolver.js';
import { existsSync } from 'node:fs';

/**
 * Stage 2 — DNS. For each domain: A (apex), CNAME + A (www), MX, NS.
 * A domain passes when the apex or www resolves to an address (= a website can exist).
 * Platform / mail provider / parking are matched from `platform_signatures`; matching is
 * re-done from the stored records whenever the rules change, so no re-lookup is needed.
 */
export const dnsPlan: StagePlan = {
  key: 'dns',
  defaults: { batch: 2000, snapshot: 20000 },
  async todoSql() {
    if (!existsSync(REGISTRY_FILE())) return null;
    const done = (await datasetExists('dns')) ? `AND domain NOT IN (SELECT domain FROM read_parquet(${datasetGlob('dns')}))` : '';
    return `SELECT domain, priority FROM read_parquet(${sqlLiteral(REGISTRY_FILE())}) WHERE drop_reason IS NULL ${done}`;
  },
};

export interface Signature { kind: string; name: string; record: 'a' | 'www_cname' | 'mx' | 'ns'; re: RegExp }

export async function loadSignatures(): Promise<Signature[]> {
  const rows = (await db().query<{ kind: string; name: string; record: Signature['record']; pattern: string }>(
    'SELECT kind, name, record, pattern FROM platform_signatures WHERE enabled',
  )).rows;
  return rows.map((r) => ({ ...r, re: new RegExp(r.pattern, 'i') }));
}

export interface DnsRecord {
  domain: string;
  a: string[];
  www_cname: string[];
  www_a: string[];
  mx: string[];
  ns: string[];
}

/** First matching signature per kind (platform, mx_provider, parking). */
export function matchSignatures(rec: DnsRecord, sigs: Signature[]): Record<string, string | null> {
  const out: Record<string, string | null> = { platform: null, mx_provider: null, parking: null };
  for (const s of sigs) {
    if (out[s.kind]) continue;
    const values = s.record === 'a' ? [...rec.a, ...rec.www_a] : rec[s.record];
    if (values.some((v) => s.re.test(v))) out[s.kind] = s.name;
  }
  return out;
}

async function resolveOne(dns: DnsClient, domain: string) {
  const [a, mx, ns, wwwCname] = await Promise.all([
    dns.query(domain, 'A'),
    dns.query(domain, 'MX'),
    dns.query(domain, 'NS'),
    dns.query(`www.${domain}`, 'CNAME'),
  ]);
  // Only look up www's address when the apex has none (saves a query for most domains).
  const wwwA = a.values.length ? { status: 'skipped', values: [] as string[] } : await dns.query(`www.${domain}`, 'A');
  const status =
    a.status === 'nxdomain' && ns.status === 'nxdomain' ? 'nxdomain'
    : [a, mx, ns].every((x) => x.status === 'error') ? 'error'
    : a.values.length || wwwA.values.length ? 'ok'
    : 'no_address';
  return {
    domain,
    status,
    a: a.values,
    www_cname: wwwCname.values,
    www_a: wwwA.values,
    mx: mx.values,
    ns: ns.values,
    error: [a, mx, ns, wwwCname].map((x) => x.error).filter(Boolean).join(',') || null,
  };
}

export async function runDnsBatch(snapshot: string, batch: number): Promise<Record<string, unknown>> {
  const rows = await loadBatch<{ domain: string }>('dns', snapshot, batch);
  const mode = await setting<string>('dns.mode', 'udp');
  const timeout = await setting<number>('dns.timeout_ms', 4000);
  const concurrency = await setting<number>('dns.concurrency', 500);
  const client = (process.env.DNS_MODE ?? mode) === 'doh'
    ? dohClient(await setting<string[]>('dns.doh_endpoints', ['https://cloudflare-dns.com/dns-query']), timeout)
    : udpClient(await setting<string[]>('dns.servers', ['1.1.1.1', '8.8.8.8']), timeout);
  const sigs = await loadSignatures();

  return withRun('stage.dns', { snapshot, batch }, async (run) => {
    const out: Record<string, unknown>[] = new Array(rows.length);
    let next = 0;
    // Each domain makes 4-5 lookups, so `concurrency` questions ≈ concurrency/4 domains at once.
    await Promise.all(
      Array.from({ length: Math.max(1, Math.floor(concurrency / 4)) }, async () => {
        while (next < rows.length) {
          const i = next++;
          const r = await resolveOne(client, rows[i]!.domain);
          const m = matchSignatures(r, sigs);
          out[i] = {
            ...r,
            pass: r.status === 'ok' && !m.parking,
            platform: m.platform,
            mx_provider: r.mx.length ? (m.mx_provider ?? 'other') : null,
            parking: m.parking,
            resolved_at: new Date().toISOString(),
          };
        }
      }),
    );
    run.inCount = rows.length;
    for (const o of out) {
      if (o.pass) run.outCount++;
      else run.drop(o.parking ? 'parked_ns' : String(o.status));
    }
    await writeParquet('dns', out, {
      name: `dns-${snapshot}-${batch}`,
      columns: {
        domain: 'VARCHAR', status: 'VARCHAR', a: 'VARCHAR[]', www_cname: 'VARCHAR[]', www_a: 'VARCHAR[]', mx: 'VARCHAR[]',
        ns: 'VARCHAR[]', error: 'VARCHAR', pass: 'BOOLEAN', platform: 'VARCHAR', mx_provider: 'VARCHAR', parking: 'VARCHAR', resolved_at: 'TIMESTAMP',
      },
    });
    return { domains: rows.length, pass: run.outCount };
  });
}
