import { Resolver } from 'node:dns/promises';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { userAgent } from '@lead/shared';

/**
 * DNS lookups in two interchangeable modes:
 *  - udp: Node's resolver (c-ares) against public resolvers — fastest; the default on a server.
 *  - doh: DNS-over-HTTPS JSON API (Cloudflare / Google, no key) — for networks that block UDP DNS.
 * Every answer is normalised to lowercase without the trailing dot.
 */
export type RType = 'A' | 'CNAME' | 'MX' | 'NS';
export interface Answer {
  status: 'ok' | 'nxdomain' | 'nodata' | 'error';
  values: string[];
  error?: string;
}

const clean = (s: string) => s.toLowerCase().replace(/\.$/, '');

export interface DnsClient {
  query(name: string, type: RType): Promise<Answer>;
}

export function udpClient(servers: string[], timeoutMs: number): DnsClient {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers(servers);
  return {
    async query(name, type) {
      try {
        let values: string[];
        if (type === 'A') values = await r.resolve4(name);
        else if (type === 'CNAME') values = (await r.resolveCname(name)).map(clean);
        else if (type === 'MX') values = (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => clean(m.exchange));
        else values = (await r.resolveNs(name)).map(clean);
        return { status: 'ok', values };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTFOUND') return { status: 'nxdomain', values: [] };
        if (code === 'ENODATA') return { status: 'nodata', values: [] };
        return { status: 'error', values: [], error: code ?? String(err) };
      }
    },
  };
}

const TYPE_NUM: Record<RType, number> = { A: 1, CNAME: 5, MX: 15, NS: 2 };

export function dohClient(endpoints: string[], timeoutMs: number): DnsClient {
  const dispatcher: Dispatcher = process.env.HTTPS_PROXY
    ? new ProxyAgent({ uri: process.env.HTTPS_PROXY, connections: 128 })
    : new Agent({ connections: 128, keepAliveTimeout: 30_000 });
  let i = 0;
  return {
    async query(name, type) {
      const endpoint = endpoints[i++ % endpoints.length]!;
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      try {
        const res = await request(url, {
          dispatcher,
          headers: { accept: 'application/dns-json', 'user-agent': userAgent() },
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
        });
        if (res.statusCode !== 200) {
          await res.body.dump();
          return { status: 'error', values: [], error: `http_${res.statusCode}` };
        }
        const j = (await res.body.json()) as { Status: number; Answer?: { type: number; data: string }[] };
        if (j.Status === 3) return { status: 'nxdomain', values: [] };
        if (j.Status !== 0) return { status: 'error', values: [], error: `rcode_${j.Status}` };
        const want = TYPE_NUM[type];
        let values = (j.Answer ?? []).filter((a) => a.type === want).map((a) => a.data);
        if (type === 'MX') {
          values = values
            .map((v) => v.split(' '))
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map((p) => clean(p[1] ?? ''));
        } else values = values.map(clean);
        return { status: values.length ? 'ok' : 'nodata', values };
      } catch (err) {
        return { status: 'error', values: [], error: (err as Error).name };
      }
    },
  };
}
