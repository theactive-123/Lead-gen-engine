import robotsParser from 'robots-parser';
import type { CrawlClient } from './client.js';

/**
 * robots.txt per origin (cached for the life of the batch).
 * 2xx -> obey the rules; 4xx -> no rules (allowed); 5xx / unreachable -> treat as "disallow"
 * (the same cautious rule Google applies).
 */
export type RobotsVerdict = { allowed: boolean; reason: 'rules' | 'no_robots' | 'robots_unavailable'; text?: string; crawlDelay?: number; error?: unknown };

export class RobotsCache {
  private cache = new Map<string, Promise<RobotsVerdict & { parser?: ReturnType<typeof robotsParser> }>>();
  constructor(private client: CrawlClient, private agentName: string) {}

  private load(origin: string) {
    let p = this.cache.get(origin);
    if (!p) {
      p = (async () => {
        const url = `${origin}/robots.txt`;
        try {
          const r = await this.client.get(url, 'text');
          if (r.status >= 200 && r.status < 300) {
            const text = r.body.toString('utf8').slice(0, 500_000);
            const parser = robotsParser(url, text);
            return { allowed: true, reason: 'rules' as const, text: text.slice(0, 20_000), parser, crawlDelay: parser.getCrawlDelay(this.agentName) };
          }
          if (r.status >= 400 && r.status < 500) return { allowed: true, reason: 'no_robots' as const };
          return { allowed: false, reason: 'robots_unavailable' as const };
        } catch (error) {
          return { allowed: false, reason: 'robots_unavailable' as const, error };
        }
      })();
      this.cache.set(origin, p);
    }
    return p;
  }

  /**
   * Seed the cache with a robots.txt we already stored (saves one request per site). Only complete
   * copies are accepted: a copy cut at the storage limit could miss a "Disallow" rule at its end.
   */
  prime(origin: string, text: string, storedLimit = 20_000): boolean {
    if (this.cache.has(origin) || text.length >= storedLimit) return false;
    const url = `${origin}/robots.txt`;
    const parser = robotsParser(url, text);
    this.cache.set(origin, Promise.resolve({ allowed: true, reason: 'rules' as const, text, parser, crawlDelay: parser.getCrawlDelay(this.agentName) }));
    return true;
  }

  async check(url: string): Promise<RobotsVerdict> {
    const v = await this.load(new URL(url).origin);
    if (v.parser) {
      const ok = v.parser.isAllowed(url, this.agentName);
      return { allowed: ok !== false, reason: 'rules', text: v.text, crawlDelay: v.crawlDelay };
    }
    return { allowed: v.allowed, reason: v.reason, error: v.error };
  }
}
