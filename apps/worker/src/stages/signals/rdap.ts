import { fetchJson, withRetry } from '../../sources/http.js';
import { HostLimiter } from '../fetch/client.js';

/**
 * Domain registration date via RDAP, asking each registry directly using IANA's bootstrap file
 * (https://data.iana.org/rdap/dns.json) instead of a third-party redirector. Registries without RDAP
 * (e.g. .co, .io, .de on 2026-11-24) return null — nothing is guessed.
 */
let bootstrap: { at: number; map: Map<string, string> } | undefined;

async function registryFor(domain: string): Promise<string | null> {
  if (!bootstrap || Date.now() - bootstrap.at > 86_400_000) {
    const j = await withRetry(() => fetchJson<{ services: [string[], string[]][] }>('https://data.iana.org/rdap/dns.json'));
    const map = new Map<string, string>();
    for (const [tlds, urls] of j.services) for (const t of tlds) map.set(t.toLowerCase(), urls.find((u) => u.startsWith('https://')) ?? urls[0]!);
    bootstrap = { at: Date.now(), map };
  }
  const labels = domain.toLowerCase().split('.');
  for (let i = 1; i < labels.length; i++) {
    const base = bootstrap.map.get(labels.slice(i).join('.'));
    if (base) return base.endsWith('/') ? base : `${base}/`;
  }
  return null;
}

export async function registrationDate(domain: string, limiter: HostLimiter): Promise<string | null> {
  const base = await registryFor(domain);
  if (!base) return null;
  const url = `${base}domain/${encodeURIComponent(domain)}`;
  await limiter.wait(new URL(url).host);
  try {
    const j = await fetchJson<{ events?: { eventAction: string; eventDate: string }[] }>(url, { timeoutMs: 15_000 });
    const ev = (j.events ?? []).find((e) => e.eventAction === 'registration');
    return ev?.eventDate ? new Date(ev.eventDate).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}
