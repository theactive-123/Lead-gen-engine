# Build Prompt v2: "LeadEngine" — High-Volume, 100% Free Lead Data Engine

> Progress notes, verified source facts and decisions live in `docs/PROGRESS.md`. Read it first.

---

## 0. How to work with me

- I run 5 agency/service brands (web design & development, Shopify, Webflow, WordPress, design). I have 8 years of design/dev experience but **I am not a backend developer**.
- Explain each step as **What / How / Why** — most focus on **Why**. Short and scannable, no walls of text.
- When I must do something by hand, give **click-by-click** steps.
- English only in UI text and code comments.
- Build in **phases** (section 14). After each phase: run it on real data, show me real numbers and sample rows, then **stop and wait for my "go"**.
- **Never invent** endpoints, file formats, dataset paths, IP ranges or fingerprints. Verify every external source live before writing code for it. If something changed, tell me and propose the closest free alternative.

---

## 1. Goal

Build a lead **data engine** in two layers:

1. **Data layer (volume):** collect **500,000 – 1,000,000 business websites/brands per month** from free public sources.
2. **Nurturing layer (quality):** run every record through enrichment steps — tech detection (Wappalyzer-style), DNS/platform checks, store/catalog probing, niche classification, contact extraction, website quality audit (incl. Lighthouse-style scoring), business-activity signals — and turn the raw data into **segmented, scored, ready-to-use leads**, matched to my **5 brands** and the services each brand sells.

Speed and scale are the priority. The engine must be fast, resumable, and able to process millions of records without manual babysitting.

---

## 2. Hard rules

1. **100% free. No API keys, no paid APIs, no sign-ups to data providers.** Only public, keyless data and open-source tools.
   - The only "accounts" allowed are infrastructure I host myself (a server, a database). If any step truly cannot be done without a key, stop and tell me — don't silently add one.
2. **Fast at scale, but polite per site.** Speed comes from crawling **many different domains in parallel**, never from hammering one domain:
   - max 1–2 requests per second per domain, respect `robots.txt`, real timeouts, identifiable User-Agent with a contact email (from env).
   - This keeps the crawler from being blocked, which is what actually keeps it fast.
3. **Never scrape** Google Search, Google Maps, LinkedIn, Facebook, Instagram, Yelp, Upwork, Clutch, or any site whose terms forbid it. Social links found on a business's own site are stored as URLs only.
4. **Public business data only.** Contact extraction comes from the business's own website and free public records. No SMTP mailbox probing (it gets the server IP blacklisted).
5. Everything configurable from the dashboard/database (niches, keywords, brands, scoring) — no hard-coded business logic.

---

## 3. Architecture (designed for millions of rows on free infrastructure)

**Two storage tiers — this is important for staying free:**

- **Data lake (bulk, cheap):** Parquet files on disk, queried with **DuckDB**. Holds the millions of raw domains, crawl results and features. DuckDB can scan tens of millions of rows on one machine in seconds.
- **Lead database (refined):** **PostgreSQL** (self-hosted in Docker on the same server). Holds only nurtured leads, segments, brand matches, export history and dashboard data.
- Why: a free hosted Postgres tier (e.g. Supabase free) is far too small for millions of raw rows. Self-hosted Postgres + Parquet costs nothing extra.

**Processes:**

- `apps/web` — **Next.js (App Router, TypeScript)** dashboard. Tailwind + shadcn/ui. Runs on the same server (or Vercel free tier if it only needs to read the DB).
- `apps/worker` — **Node.js (TypeScript)** workers. Horizontally scalable: I can run 1 or several worker processes; they pull jobs from the queue.
- **Queue:** `pg-boss` on the self-hosted Postgres (no Redis).
- **Batching:** workers process records in **batches (e.g. 500–5,000)**, write results with Postgres `COPY` / bulk inserts and append to Parquet. Never one-row-at-a-time writes.
- **Resumable everywhere:** every stage has a cursor/checkpoint. Killing and restarting the worker must never lose or duplicate work.

**Hosting (free):** design for a single machine first — either my own PC or a free cloud VM (e.g. Oracle Cloud Always Free ARM). Give me a `docker-compose.yml` that starts Postgres + worker + web with one command. Document minimum RAM/disk needed for 1M records/month.

---

## 4. Tech stack

- TypeScript monorepo (pnpm workspaces): `apps/web`, `apps/worker`, `packages/shared`.
- HTTP: `undici` with a connection pool, high global concurrency (configurable, start ~200 concurrent requests), per-host limiter, timeouts (8–10s), max body size, gzip/brotli, redirect limit, skip non-HTML.
- DNS: a fast resolver with caching (Node `dns` with configurable public resolvers, or `dns2`), high concurrency.
- HTML parsing: `cheerio` (fast). **Playwright/Chrome only for the Lighthouse step and for JS-only sites in the top tier.**
- Tech detection: an **open-source Wappalyzer-compatible fingerprint dataset** (the original Wappalyzer repo is no longer open; find a currently maintained open fork, verify its license, and vendor the fingerprints with an update script).
- Performance audit: **Lighthouse (npm package, run locally with headless Chrome)** — free, no key. Do NOT use the PageSpeed Insights API (needs a key at volume).
- Classification: rules + keyword dictionaries first; then an optional **local embedding model** (e.g. a small sentence-embedding model via `transformers.js`/ONNX, runs on CPU, free, no key) for niche classification of homepage text.
- Bulk data: **DuckDB** (Node bindings) + Parquet.
- Validation `zod`, logging `pino`, tests `vitest` with saved real fixtures.
- Export: `exceljs` (xlsx), CSV streaming for large files.

---

## 5. Data sources — the volume engines (all keyless)

Build each as a plugin:

```ts
interface Source {
  key: string;
  label: string;
  schedule: string;                     // cron
  run(cursor: Cursor): AsyncIterable<DomainCandidate>;  // streams
  health(): Promise<SourceHealth>;
}
```

All sources output **domain candidates** (`domain`, `source`, `first_seen`, optional hints like business name, location, text). Dedupe by registrable domain (use the Public Suffix List).

### 5.1 Common Crawl (main volume engine — millions of domains)
- Free public web archive, no key. Use the **columnar URL index (Parquet)** and query it with DuckDB over HTTP/S3 to pull hostnames by signals, e.g.:
  - Hostnames whose pages reference platform assets (Shopify CDN, WooCommerce paths, Webflow assets, Squarespace, Wix, BigCommerce, etc. — verify exact markers).
  - URL patterns like `/products/`, `/collections/`, `/cart` (ecommerce), `/book`, `/schedule`, `/classes` (wellness/fitness), `/services`, `/white-label`, `/partners` (agencies).
- Use **WAT files** (metadata + links) when you need page titles, meta descriptions and outbound links without downloading full HTML.
- Process one crawl at a time, store results to Parquet, track which index files are done.
- Verify current crawl IDs, file paths and the index schema live before building.

### 5.2 Certificate Transparency logs (new websites, daily)
- Read CT logs **directly** via their public RFC 6962 `get-entries` endpoints (keyless) — much faster and more reliable than crt.sh. Verify the current log list from the public log list JSON.
- Extract new hostnames; keep registrable domains; drop obvious junk (random subdomains, cloud provider hostnames, mail/cpanel/autodiscover prefixes).
- These are websites that went live in the last days → freshest leads.

### 5.3 Newly registered domains (daily)
- Free daily newly-registered-domain lists (e.g. WhoisDS free daily list — verify availability and terms).
- Keep all; classification later decides niche.

### 5.4 Popularity / size ranking lists
- **Tranco** list (free download) and **Common Crawl host-level ranks / web graph** (free) — used both as a source and to estimate how established a brand is.

### 5.5 Link expansion (finds more brands in the same niche)
- From known good niche sites, follow outbound links found in Common Crawl WAT data (e.g. "stockists", "partners", "brands we carry", directory pages on the brand's own site). Strictly limited depth, only from data we already have.

### 5.6 Public business registries (from v1, lower volume, keep as plugins)
- US state filings (e.g. Florida daily bulk files), city business licences via Socrata open data (keyless; slower without a token but works). Verify live.

**Volume target check:** after Phase 2, report how many unique domains per day each source produces. Sources 5.1 + 5.2 + 5.3 must comfortably exceed 1M candidates/month; nurturing then filters down.

---

## 6. Nurturing pipeline (stage by stage)

Each stage is a batch job type. Each record carries `stage_status` and `drop_reason`. Cheap stages run on everything; expensive stages only on records that pass the cheap ones (**funnel design** = speed).

| # | Stage | Runs on | Cost |
|---|---|---|---|
| 1 | Normalise & dedupe | 100% | very cheap |
| 2 | DNS resolve + DNS-based platform detection | 100% | very cheap |
| 3 | Homepage fetch + lightweight extraction | resolvable domains | cheap |
| 4 | Tech fingerprinting (Wappalyzer-style) | fetched pages | cheap |
| 5 | Platform deep probe (store/catalog) | detected platforms | cheap |
| 6 | Niche classification | fetched pages | cheap–medium |
| 7 | Contact extraction | in-niche records | medium |
| 8 | Business signals | in-niche records | cheap |
| 9 | Website quality audit (light) | in-niche records | medium |
| 10 | Lighthouse audit (full) | top-tier only | expensive |
| 11 | Brand matching, segmentation, scoring | in-niche records | cheap |
| 12 | Personalised first lines | qualified | cheap |
| 13 | Export | on demand / daily | cheap |

### Stage 1 — Normalise & dedupe
Lowercase, strip `www`, registrable domain via Public Suffix List, drop parked/for-sale TLD spam patterns, merge duplicates across sources (keep all source hits).

### Stage 2 — DNS + platform via DNS
- A/AAAA/CNAME/MX lookups (cached, high concurrency).
- Detect hosting platform from DNS where possible (e.g. CNAME/IP patterns for Shopify, Webflow, Squarespace, Wix, WP Engine, Kinsta, etc. — **verify each pattern live** against known sites before using it).
- `has_mx` (business email exists), `mx_provider` (Google Workspace / Microsoft 365 / other — a size/maturity signal).
- Drop: no DNS, parked-domain nameservers.

### Stage 3 — Homepage fetch
- One GET of the homepage (follow ≤3 redirects). Save: final URL, status, TTFB, total time, HTML size, title, meta description, H1, language, visible text sample (first ~2,000 chars), all links, script/style URLs, JSON-LD blocks, copyright year, viewport meta.
- Don't store full HTML in Postgres; store extracted features in Parquet (optionally gzip HTML to disk with 7-day expiry for re-processing).
- Detect parked pages, "coming soon", default server pages, hacked/spam pages → tag them.

### Stage 4 — Tech fingerprinting
- Run the open Wappalyzer-compatible fingerprints over headers, cookies, HTML, script srcs, meta tags.
- Store technologies with categories: CMS/ecommerce platform, theme, page builder, analytics, tag manager, ad pixels (Meta, TikTok, Google Ads), email marketing (Klaviyo, Mailchimp…), reviews apps, chat, booking widgets, payment, CDN.
- **These are segmentation gold:** e.g. "Shopify + Meta Pixel + no Klaviyo", "WordPress + Elementor + old jQuery", "Wix + no analytics".

### Stage 5 — Platform deep probe (public endpoints only)
- **Shopify:** public `/products.json` (paged) and `/collections.json` → product count, price range, last product update date, vendor names, currency. `/meta.json` if available. Detect theme name.
- **WooCommerce:** public Store API (`/wp-json/wc/store/products`) if exposed → product count, prices.
- **WordPress:** `/wp-json/` presence, version hints, plugins visible in HTML.
- **Webflow / Squarespace / Wix:** platform markers only.
- These give real **business activity** (are they adding products? how big is the catalog? price level = budget signal).
- Respect rate limits; small pages only; stop after a few pages per store.

### Stage 6 — Niche classification
1. Rules: platform + URL patterns + keyword dictionaries (positive and **negative** keywords, word boundaries) on title/meta/H1/text/product names.
2. Optional local embedding model: compare homepage text to niche descriptions; take best match above a threshold.
3. Save `niche`, `sub_niche`, `confidence`, `reason`.
4. Records outside all configured niches → `out_of_scope` (kept in Parquet only, not in Postgres).

### Stage 7 — Contact extraction
- Fetch up to 5 more pages chosen from links: contact, about, team, wholesale/partners, privacy policy (often contains email + address), terms.
- Extract: emails (mailto, text, JSON-LD, simple obfuscation), phones (`tel:`, text, JSON-LD), address (JSON-LD/footer), owner/founder names (About pages, JSON-LD `founder`, "Founded by…"), social URLs.
- Filter junk emails (platform/system emails, `example.com`, image filenames like `logo@2x.png`).
- Validate email: syntax + domain MX. Type: `named` / `role` (info@, hello@) / `freemail`.
- Free extra sources: **OpenStreetMap Overpass** (keyless; follow usage policy, cache) for phone/website/email of physical businesses; **RDAP** (`rdap.org`, keyless) for registrant org when not redacted.
- Save source URL and confidence for every field. Compute `completeness` (email / phone / owner / address).

### Stage 8 — Business signals
- Estimated size/maturity: Tranco/CC rank, MX provider, number of pages in sitemap, catalog size, presence of careers page, multiple locations.
- Freshness: domain first seen (CT/NRD date), copyright year, last product update (Shopify), blog last post date.
- Marketing maturity: ad pixels present, email marketing tool present, reviews app present.
- Country/state/city (from address, phone code, TLD, currency).

### Stage 9 — Light website audit (all in-niche records)
Own fast checks, no browser: TTFB, page weight, number of scripts, render-blocking hints, image formats, HTTPS + redirect, mobile viewport, broken links sample, missing title/meta/H1, missing favicon, outdated libraries (jQuery version etc.), copyright year, no analytics, no email capture (ecommerce), no booking (wellness/fitness), no reviews, no contact form. Each finding: `code`, `severity`, `message`, `evidence`.

### Stage 10 — Lighthouse audit (top tier only)
- Run **Lighthouse locally** (headless Chrome, mobile preset) only on records that reach tier A/B in a preliminary score — this is the expensive step, so the funnel protects speed.
- Configurable parallelism (start 2–4 Chrome instances). Store performance, accessibility, best-practices, SEO scores and key metrics (LCP, CLS, TBT).
- Never block the rest of the pipeline on this stage.

### Stage 11 — Brand matching, segmentation & scoring
- I have **5 brands**; each brand sells different services. Store them as **brand profiles** (section 8).
- For every in-niche record, compute a **match score per brand**: does this record fit the brand's target niches, platforms, size, country, and does it show the problems that brand solves (from audit findings + tech stack)?
- **Segments** are saved filters (e.g. "Shopify DTC, US, 50–500 products, Meta Pixel, no Klaviyo, Lighthouse < 50"). Build a segment builder in the dashboard.
- **Lead score** = fit × need × reachability (completeness) × freshness, weights editable per brand. Tiers A/B/C.
- Store the score breakdown so I can see **why** each lead scored what it did.

### Stage 12 — Personalised first lines
- Template engine per brand × niche × finding (no AI key). 2–3 variants, max ~25 words, must reference one **true, specific** finding. No hype, no exclamation marks, no "I hope this finds you well", no "it's not X, it's Y" lines.
- Pluggable interface for a local LLM later (off by default).

### Stage 13 — Export
- Streaming **CSV** (handles 100k+ rows) and **XLSX** (one sheet per niche or per segment, summary sheet).
- Export per **brand → segment → tier**, "new since last export" mode, mark exported rows.
- Columns: lead_id, brand, segment, tier, score, niche, sub_niche, domain, company_name, platform, key technologies, country/state/city, email, email_type, phone, owner_name, socials, product_count, price_range, lighthouse_performance, top 3 findings, first_line_1/2, first_seen_date, sources.

---

## 7. Niches (configurable taxonomy)

Focus on niches with **lots of brands** and **low agency saturation**. Store as editable tables (niche → sub-niches → keywords, negative keywords, URL patterns, platform hints, example domains).

Starting set (I will refine):

**A. DTC ecommerce brands** (huge volume; Shopify/Woo/BigCommerce)
- Supplements & functional nutrition, clean beauty/skincare, haircare, men's grooming, pet products, coffee/tea roasters, specialty food & snacks, craft beverages (non-alcoholic), home & kitchen goods, home fragrance/candles, sustainable/eco products, outdoor & camping gear, cycling/fitness equipment, baby & kids products, jewellery (independent), apparel (independent labels — not dropshipping).
- Exclude: obvious dropshipping stores (detect: generic themes + AliExpress apps + random catalog), marketplaces, mega-brands (very high rank).

**B. White-label service buyers** (businesses that resell services → buy white-label web/dev/design)
- Digital marketing agencies, SEO agencies, PPC/social agencies, branding studios, IT/MSP companies, business coaches/consultancies with productised services, print & sign shops offering web services.
- Signals: services pages listing "web design" or "websites" with small teams, "white label"/"partners" pages, agency-style sites.

**C. Wellness & fitness**
- Boutique fitness (pilates, yoga, barre, cycling, HIIT), recovery studios (sauna, cold plunge, cryo, float, red light), personal trainers & online coaching, wellness retreats, nutrition coaches, physiotherapy-adjacent wellness, wellness product brands.
- Signals: booking widgets (Mindbody, Glofox, Mariana Tek, Momence, Acuity, Vagaro…), class schedules, memberships.

**D. Other low-saturation niches with many brands** (suggest more after Phase 2 data)
- Independent B2B manufacturers & industrial suppliers (dated sites, high budgets), specialty contractors with product lines, boutique hotels/B&Bs/glamping, wineries/breweries/distilleries (DTC shipping), creative education/course creators, local makers moving off Etsy.

**Saturation control:** a `saturation_level` per niche (editable). Heavily-pitched niches (e.g. dentists, generic restaurants, real-estate agents) are **excluded by default**. After Phase 2, show me counts per niche so we can pick the best ones with data.

---

## 8. Brand profiles (I will provide details later — build the structure now)

Table `brands` with 5 placeholder rows (`brand_1` … `brand_5`). Each brand has:
- name, website, short description, **services offered** (list), price range
- target niches & sub-niches (weights), excluded niches
- target platforms (e.g. Shopify only, or WordPress/Webflow)
- target countries/regions
- ideal company size signals
- **problem → service mapping** (which audit findings / tech gaps mean this brand can help, e.g. `no_email_marketing_tool` → "Klaviyo setup", `lighthouse_perf_below_50` → "speed optimisation", `wix_site` → "Webflow migration")
- first-line templates and case-study references
- scoring weights

Dashboard page to edit all of this without code. The whole segmentation must work automatically once I fill in these profiles.

---

## 9. Data model

**Parquet (data lake), partitioned by date:** `candidates/`, `dns/`, `pages/`, `tech/`, `store_probe/`, `classified/` — one row per domain per stage, with stage version.

**Postgres (leads):**
- `domains` (id, domain, first_seen, sources[], stage_status, drop_reason, updated_at)
- `companies` (domain_id, name, country, region, city, address, platform, size_signals jsonb, freshness jsonb)
- `technologies` (domain_id, tech, category, version, confidence)
- `store_profiles` (domain_id, platform, product_count, price_min, price_max, currency, last_product_update, theme)
- `classifications` (domain_id, niche_id, sub_niche_id, confidence, reason)
- `contacts` (domain_id, email, email_type, email_confidence, email_source_url, mx_ok, phone, phone_source, owner_name, owner_title, owner_source, socials jsonb, completeness)
- `audits` (domain_id, light_audit jsonb, lighthouse jsonb, audited_at) + `audit_findings` (domain_id, code, severity, message, evidence)
- `brands`, `brand_niche_weights`, `brand_problem_map`, `brand_templates`
- `brand_matches` (domain_id, brand_id, match_score, tier, breakdown jsonb)
- `segments` (id, brand_id, name, filter jsonb) and `segment_members` (materialised daily)
- `first_lines` (domain_id, brand_id, variant, text, finding_code)
- `niches`, `sub_niches`, `keywords`, `url_patterns`, `platform_signatures`
- `suppression` (email/domain, reason) — checked before any export
- `exports`, `runs` (per stage: started, finished, in, out, dropped by reason, errors, throughput/min)

Indexes for all dashboard filters. Partition large tables if needed.

---

## 10. Performance targets

- **Ingest:** ≥ 1M candidate domains/month sustained.
- **DNS stage:** ≥ 100k domains/hour on one machine.
- **Homepage fetch:** ≥ 20k domains/hour on one machine (tunable concurrency).
- **Lighthouse:** only top tier; ≥ 500/hour with 4 Chrome instances.
- Show live throughput (records/min per stage) and queue depth in the dashboard.
- Auto back-off when error rates rise (timeouts, 429s); circuit breaker per source.
- Benchmark each stage in its phase and report real numbers to me.

---

## 11. Dashboard (Next.js)

1. **Overview** — funnel for today / 7 days / 30 days: candidates → resolved → fetched → in-niche → with contact → qualified (A/B), per source, per niche, per brand. Throughput and queue depth. Source health.
2. **Explorer** — fast table over leads with filters: brand, niche, sub-niche, platform, technologies (has / doesn't have), country/state, product count, price range, Lighthouse score, completeness, tier, first seen date. Server-side pagination (millions of rows).
3. **Segment builder** — save filters as named segments per brand; show live count.
4. **Lead detail** — all data, tech stack, store profile, findings, score breakdown per brand, first lines (copy), sources.
5. **Brands** — edit the 5 brand profiles (section 8).
6. **Niches** — taxonomy, keywords, saturation levels, counts.
7. **Sources** — enable/disable, run now, logs, throughput.
8. **Exports** — create CSV/XLSX per brand/segment/tier, history, download.
9. **Settings** — concurrency, rate limits, suppression list (CSV import), fingerprint updates.

Clean and professional, no gradients, no clutter.

---

## 12. Reliability

- Idempotent, resumable stages; checkpoints per source and stage.
- Retries with backoff; dead-letter view in dashboard.
- Page cache (7 days) to avoid re-fetching.
- Re-check schedule: in-niche records re-crawled every 30 days; new domains without a site re-checked at 7/21/45 days.
- Disk usage monitor and automatic Parquet compaction.

---

## 13. Compliance basics (built in)

- Public business info only; one-click delete of any domain's data; suppression list applied before every export.
- Exports are for B2B outreach; my email tool adds unsubscribe + physical address (CAN-SPAM). Store `country` so I can exclude EU/UK leads from cold email if needed.
- Obey robots.txt and per-domain rate limits (section 2).

---

## 14. Build phases (stop after each one)

1. **Foundation** — monorepo, Docker Compose (Postgres + worker + web), queue, Parquet/DuckDB setup, runs logging. Show it running.
2. **Volume sources** — Common Crawl index extraction, CT logs, newly registered domains, Tranco. Report unique domains/day per source.
3. **Cheap stages** — normalise, DNS + platform detection, homepage fetch. Benchmark throughput.
4. **Tech + platform probes** — fingerprints, Shopify/Woo/WordPress probes. Show tech stack stats.
5. **Classification** — niches/sub-niches (rules, then optional local embeddings). Show counts per niche and 50 samples per niche for me to review accuracy.
6. **Contacts + business signals** — show completeness % per niche.
7. **Audits** — light audit for all in-niche; Lighthouse for top tier. Benchmark.
8. **Brands, segmentation, scoring, first lines** — with placeholder brand profiles until I send real ones.
9. **Dashboard** — all pages.
10. **Exports** — CSV/XLSX streaming.
11. **Hardening & deploy** — run unattended for 7 days, report total volume, funnel and bottlenecks.

---

## 15. Definition of done

- One command (`docker compose up`) starts everything; `README.md` explains setup, every env var, how to add niches/brands/sources, and how to read the funnel — written for a non-developer.
- Sustains ≥ 1M candidates/month and reports real funnel numbers daily.
- All parsers/fingerprints tested with saved real fixtures.
- Exports open cleanly in Excel and Google Sheets.
- No API keys anywhere in the system.
