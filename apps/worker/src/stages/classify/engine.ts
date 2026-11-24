/**
 * Rule-based niche classifier. All terms, weights and gates come from the database
 * (niches, sub_niches, keywords, url_patterns, niche_tech_hints, settings classify.*).
 */
export interface Taxonomy {
  niches: { id: number; key: string; name: string; gate: 'none' | 'store' | 'services' | 'booking'; excluded: boolean }[];
  subNiches: { id: number; key: string; name: string; niche_id: number }[];
  keywords: { sub_niche_id: number; term: string; kind: 'positive' | 'negative'; weight: number }[];
  urlPatterns: { niche_id: number | null; sub_niche_id: number | null; pattern: string; weight: number }[];
  techHints: { niche_id: number; tech: string; weight: number }[];
  fieldWeights: Record<string, number>;
  minScore: number;
  textCap?: number;          // most points body text can add per sub-niche (default 2)
  boostMinKeywords?: number; // boosts need at least this keyword score (default 2)
}

export interface PageInput {
  domain: string;
  title: string | null;
  h1: string | null;
  meta: string | null;
  site_name: string | null;
  text: string | null;
  products: string | null; // store product titles / types / vendors joined
  link_paths: string[];    // internal link paths, e.g. /services/seo
  techs: string[];         // technology names
  store_evidence: boolean;
  product_count: number | null;
  platform: string | null;
}

export interface Result {
  niche: string | null;
  sub_niche: string | null;
  in_scope: boolean;
  score: number;
  runner_up: string | null;
  runner_score: number;
  confidence: number;
  reason: string;
  top: { sub: string; score: number }[];
}

const NOT_WORD = '(?<![a-z0-9])';
const END_WORD = '(?![a-z0-9])';

/** Term -> regex source: whole words, flexible space/hyphen, optional apostrophe, optional plural for single words. */
export function termSource(term: string): string {
  const t = term.toLowerCase().trim();
  let src = t
    .split('')
    .map((ch) => {
      if (ch === ' ') return '[\\s\\-]+';
      if (ch === '-') return '[\\s\\-]?';
      if (ch === "'") return "['’]?";
      return ch.replace(/[.*+?^${}()|[\]\\/&]/g, (c) => '\\' + c);
    })
    .join('');
  if (/^[a-z]+$/.test(t) && !t.endsWith('s')) src += '(?:s|es)?';
  return NOT_WORD + src + END_WORD;
}

interface Compiled { sub: number; kind: 'positive' | 'negative'; weight: number; term: string; re: RegExp; domainSub: string | null }

export class Classifier {
  private compiled: Compiled[];
  private subById: Map<number, Taxonomy['subNiches'][number]>;
  private nicheById: Map<number, Taxonomy['niches'][number]>;
  private urlRes: { niche_id: number | null; sub_niche_id: number | null; re: RegExp; weight: number }[];

  constructor(private tax: Taxonomy) {
    this.subById = new Map(tax.subNiches.map((s) => [s.id, s]));
    this.nicheById = new Map(tax.niches.map((n) => [n.id, n]));
    this.compiled = tax.keywords.map((k) => ({
      sub: k.sub_niche_id, kind: k.kind, weight: Number(k.weight), term: k.term,
      re: new RegExp(termSource(k.term), 'i'),
      // Domain names have no spaces ("10-4coffee"): only long single words are looked for inside them.
      domainSub: /^[a-z]{5,}$/i.test(k.term) ? k.term.toLowerCase() : null,
    }));
    this.urlRes = tax.urlPatterns.map((u) => ({ ...u, re: new RegExp(u.pattern, 'i'), weight: Number(u.weight) }));
  }

  classify(p: PageInput): Result {
    const fw = this.tax.fieldWeights;
    const fields: [string, string][] = [
      ['title', p.title ?? ''], ['h1', p.h1 ?? ''], ['meta', p.meta ?? ''], ['site_name', p.site_name ?? ''],
      ['text', p.text ?? ''], ['products', p.products ?? ''],
    ];
    const label = p.domain.split('.')[0]!.toLowerCase();
    const pos = new Map<number, number>();
    const textPts = new Map<number, number>(); // body-text points per sub-niche (capped)
    const neg = new Map<number, number>();
    const textCap = this.tax.textCap ?? 2;
    const why = new Map<number, string[]>();
    for (const c of this.compiled) {
      let gained = 0;
      const where: string[] = [];
      for (const [name, value] of fields) {
        if (!value || !c.re.test(value)) continue;
        if (c.kind === 'negative' && name === 'products') continue; // product names don't make a shop a clinic
        let pts = (fw[name] ?? 1) * c.weight;
        if (name === 'text' && c.kind === 'positive') {
          // Body text often lists side products; it may add at most `textCap` points per sub-niche.
          const used = textPts.get(c.sub) ?? 0;
          pts = Math.max(0, Math.min(pts, textCap - used));
          textPts.set(c.sub, used + pts);
        }
        gained += pts;
        where.push(name);
      }
      if (c.kind === 'positive' && c.domainSub && label.includes(c.domainSub)) {
        gained += (fw.domain ?? 1) * c.weight;
        where.push('domain');
      }
      if (!gained) continue;
      if (c.kind === 'positive') {
        pos.set(c.sub, (pos.get(c.sub) ?? 0) + gained);
        (why.get(c.sub) ?? why.set(c.sub, []).get(c.sub)!).push(`"${c.term}" (${where.join('+')})`);
      } else {
        // A negative term counts once (not per field), weighted by its strongest field.
        neg.set(c.sub, (neg.get(c.sub) ?? 0) + c.weight * Math.max(...where.map((w) => fw[w] ?? 1)));
        (why.get(c.sub) ?? why.set(c.sub, []).get(c.sub)!).push(`minus "${c.term}"`);
      }
    }

    // Niche-level signals: URL paths and technology hints boost sub-niches that already have keyword evidence.
    const nicheBoost = new Map<number, { w: number; notes: string[] }>();
    const addBoost = (nicheId: number, w: number, note: string) => {
      const b = nicheBoost.get(nicheId) ?? { w: 0, notes: [] };
      b.w += w;
      b.notes.push(note);
      nicheBoost.set(nicheId, b);
    };
    for (const u of this.urlRes) {
      if (u.niche_id !== null && p.link_paths.some((lp) => u.re.test(lp))) addBoost(u.niche_id, u.weight, `pages ${u.re.source}`);
    }
    const techSet = new Set(p.techs);
    for (const h of this.tax.techHints) if (techSet.has(h.tech)) addBoost(h.niche_id, Number(h.weight), `uses ${h.tech}`);

    const scores: { sub: number; score: number }[] = [];
    let gatedStore: { sub: number; score: number } | null = null; // best DTC match held back for lack of a store
    for (const [sub, score] of pos) {
      const s = this.subById.get(sub);
      const n = s && this.nicheById.get(s.niche_id);
      if (!s || !n) continue;
      const keywordScore = score - (neg.get(sub) ?? 0);
      let total = keywordScore;
      if (n.gate === 'store' && !p.store_evidence) {
        // DTC needs a real store; remember the best such match so the reason can say so.
        if (!gatedStore || score > gatedStore.score) gatedStore = { sub, score };
        continue;
      }
      if (n.gate === 'services' && p.store_evidence && ((p.product_count ?? 0) >= 20 || p.platform === 'Shopify')) total -= 3; // a big shop is not an agency
      const b = nicheBoost.get(n.id);
      // Page-structure / technology boosts only add to real keyword evidence.
      if (b && keywordScore >= (this.tax.boostMinKeywords ?? 2)) total += b.w;
      scores.push({ sub, score: Math.round(total * 10) / 10 });
    }
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    const second = scores[1];
    const top = scores.slice(0, 5).map((x) => ({ sub: this.subById.get(x.sub)!.key, score: x.score }));
    if (!best || best.score < this.tax.minScore) {
      return { niche: null, sub_niche: null, in_scope: false, score: best?.score ?? 0, runner_up: null, runner_score: 0, confidence: 0,
        reason: best
          ? `best match too weak (${top[0]!.sub} ${best.score} < ${this.tax.minScore})`
          : gatedStore && gatedStore.score >= this.tax.minScore
            ? `looks like ${this.subById.get(gatedStore.sub)!.key} (${gatedStore.score}) but no store evidence found`
            : 'no niche keywords found',
        top };
    }
    const sub = this.subById.get(best.sub)!;
    const niche = this.nicheById.get(sub.niche_id)!;
    const margin = second ? (best.score - second.score) / best.score : 1;
    const confidence = Math.round(Math.min(1, best.score / 12) * (0.5 + 0.5 * Math.max(0, margin)) * 100) / 100;
    const boost = nicheBoost.get(niche.id);
    const reason = [...(why.get(best.sub) ?? []).slice(0, 6), ...(boost?.notes.slice(0, 3) ?? [])].join('; ');
    return {
      niche: niche.key, sub_niche: sub.key, in_scope: !niche.excluded, score: best.score,
      runner_up: second ? this.subById.get(second.sub)!.key : null, runner_score: second?.score ?? 0,
      confidence, reason: niche.excluded ? `excluded niche (${sub.name}): ${reason}` : reason, top,
    };
  }
}
