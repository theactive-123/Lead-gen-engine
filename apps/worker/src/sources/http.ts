import { Agent, interceptors, request, ProxyAgent, type Dispatcher } from 'undici';
import { userAgent } from '@lead/shared';

/**
 * Shared HTTP client for bulk downloads from data sources (not for crawling business sites;
 * that has its own polite per-host limiter in Phase 3). Honors HTTPS_PROXY when set.
 */
const base: Dispatcher = process.env.HTTPS_PROXY
  ? new ProxyAgent({ uri: process.env.HTTPS_PROXY, connections: 64 })
  : new Agent({ connections: 64, keepAliveTimeout: 30_000 });
const dispatcher = base.compose(interceptors.redirect({ maxRedirections: 5 }), interceptors.decompress());

export async function fetchBuffer(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Buffer> {
  const res = await request(url, {
    dispatcher,
    headers: { 'user-agent': userAgent(), 'accept-encoding': 'gzip, identity', ...opts.headers },
    headersTimeout: opts.timeoutMs ?? 60_000,
    bodyTimeout: opts.timeoutMs ?? 120_000,
  });
  if (res.statusCode >= 400) {
    await res.body.dump();
    const ra = Number(res.headers['retry-after']);
    throw new HttpError(url, res.statusCode, Number.isFinite(ra) ? ra * 1000 : undefined);
  }
  return Buffer.from(await res.body.arrayBuffer());
}

export async function fetchText(url: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  return (await fetchBuffer(url, opts)).toString('utf8');
}

export async function fetchJson<T>(url: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}

export class HttpError extends Error {
  constructor(readonly url: string, readonly status: number, readonly retryAfterMs?: number) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** Retry transient failures (network errors, 429, 5xx) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 1000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || i >= tries - 1) throw err;
      // "Too many requests": wait what the server asks (max 60s), else 5x the normal backoff.
      const wait = status === 429 ? Math.min((err as HttpError).retryAfterMs ?? baseMs * 5 * 2 ** i, 60_000) : baseMs * 2 ** i;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
