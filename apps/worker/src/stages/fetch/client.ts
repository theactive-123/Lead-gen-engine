import { Agent, ProxyAgent, interceptors, request, type Dispatcher } from 'undici';
import { userAgent } from '@lead/shared';

/**
 * Polite crawler HTTP client for business websites.
 * - At most `perHostRps` requests per second to any one host (shared across all tasks).
 * - Hard timeouts, a body size cap, HTML only, manual redirects (each hop is rate-limited too).
 */
export interface FetchResult {
  url: string;           // final URL after redirects
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: Buffer;
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
  redirects: string[];
  contentType: string;
}

export class HostLimiter {
  private next = new Map<string, number>();
  constructor(private gapMs: number) {}
  /** Wait until this host may be contacted again, then reserve the slot. */
  async wait(host: string): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.gapMs);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    if (this.next.size > 50_000) for (const [h, t] of this.next) if (t < now) this.next.delete(h);
  }
}

export function makeDispatcher(connections = 512): Dispatcher {
  const base: Dispatcher = process.env.HTTPS_PROXY
    ? new ProxyAgent({ uri: process.env.HTTPS_PROXY, connections })
    : new Agent({ connections: 4, keepAliveTimeout: 4_000, connect: { timeout: 8_000 } });
  return base.compose(interceptors.decompress());
}

export class CrawlClient {
  constructor(
    private dispatcher: Dispatcher,
    private limiter: HostLimiter,
    private opts: { timeoutMs: number; maxBytes: number; maxRedirects: number },
  ) {}

  /** GET with manual redirects. `accept` = 'html' rejects non-HTML bodies (headers still returned). */
  async get(url: string, accept: 'html' | 'text' | 'json' = 'html', beforeHop?: (next: string) => Promise<boolean>): Promise<FetchResult> {
    const started = Date.now();
    const redirects: string[] = [];
    let current = url;
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      await this.limiter.wait(u.host);
      const t0 = Date.now();
      const res = await request(current, {
        dispatcher: this.dispatcher,
        method: 'GET',
        headers: {
          'user-agent': userAgent(),
          accept:
            accept === 'html' ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
            : accept === 'json' ? 'application/json,*/*;q=0.5'
            : 'text/plain,*/*;q=0.5',
          'accept-language': 'en',
          'accept-encoding': 'gzip, deflate, br',
        },
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
        signal: AbortSignal.timeout(this.opts.timeoutMs + 5_000),
      });
      const ttfbMs = Date.now() - t0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (k !== 'set-cookie') headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      const sc = res.headers['set-cookie'];
      const setCookies = Array.isArray(sc) ? sc : sc ? [sc] : [];

      if (res.statusCode >= 300 && res.statusCode < 400 && headers.location && hop < this.opts.maxRedirects) {
        await res.body.dump();
        redirects.push(current);
        const next = new URL(headers.location, current).toString();
        // Let the caller veto a hop (robots.txt of a new host, or a jump to another domain).
        if (beforeHop && !(await beforeHop(next))) {
          return { url: next, status: res.statusCode, headers, setCookies, body: Buffer.alloc(0), truncated: false, ttfbMs, totalMs: Date.now() - started, redirects, contentType: '' };
        }
        current = next;
        continue;
      }
      const contentType = (headers['content-type'] ?? '').toLowerCase();
      const isHtml = contentType.includes('html') || contentType === '';
      if (accept === 'html' && !isHtml) {
        await res.body.dump();
        return { url: current, status: res.statusCode, headers, setCookies, body: Buffer.alloc(0), truncated: false, ttfbMs, totalMs: Date.now() - started, redirects, contentType };
      }
      // Read up to maxBytes, then stop downloading.
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        chunks.push(chunk as Buffer);
        size += (chunk as Buffer).length;
        if (size >= this.opts.maxBytes) {
          truncated = true;
          res.body.destroy();
          break;
        }
      }
      return { url: current, status: res.statusCode, headers, setCookies, body: Buffer.concat(chunks).subarray(0, this.opts.maxBytes), truncated, ttfbMs, totalMs: Date.now() - started, redirects, contentType };
    }
  }
}
