# Progress log

## Decisions
- Database: self-hosted PostgreSQL 16 in Docker (free, no Supabase / MongoDB).
- Bulk data: Parquet files under `data/lake/`, queried with DuckDB.
- Queue: pg-boss on the same Postgres.
- Runtime: TypeScript executed with `tsx` (no build step for the worker).
- Crawler contact email: placeholder until Phase 3 (`CRAWLER_CONTACT_EMAIL`).

## Verified sources (checked live 2026-11-19)
- Common Crawl latest crawl `CC-MAIN-2026-43`. Columnar index: 300 Parquet files in
  `subset=warc` listed in `crawl-data/<CRAWL>/cc-index-table.paths.gz` on `https://data.commoncrawl.org/`.
  Columns include `url_host_registered_domain`, `url_host_tld`, `url_path`, `fetch_status`, `content_languages`.
  Files are sorted by SURT key (domain ranges). One file ≈ 7M URLs, ≈ 100k registered domains, ~2 s to query.
- `index.commoncrawl.org` (CDX API) intermittently resets connections — do not depend on it.
- CC web graph domain ranks: `projects/hyperlinkgraph/cc-main-2026-jun-jul-aug/domain/cc-main-2026-jun-jul-aug-domain-ranks.txt.gz` (2.4 GB).
- CT log list: `https://www.gstatic.com/ct/log_list/v3/log_list.json`. 17 usable RFC 6962 logs
  (Cloudflare, DigiCert, Sectigo, TrustAsia). Google + Let's Encrypt are **tiled only** (static-ct-api, `checkpoint` + tiles).
- WhoisDS daily NRD zip: links on the page are `https://www.whoisds.com//whois-database/newly-registered-domains/<base64(YYYY-MM-DD.zip)>/nrd`
  (note the double slash). Exactly 70,000 domains/day (free sample cap). Only the last 4 days are listed.
  Page terms: "downloaded free of charge … may be reused, including for commercial purposes, without a license".
- Tranco: `https://tranco-list.eu/top-1m.csv.zip` → redirects to daily list.
- Fingerprints: `enthec/webappanalyzer` (GPL-3.0, ~7,700 technologies, updated 2026-11-15).

## Phase status
- Phase 1 — Foundation: **done** (2026-11-19)
  - pnpm monorepo: `apps/worker`, `apps/web`, `packages/shared`.
  - `docker compose up -d --build` starts postgres + worker + web (verified).
  - Migrations auto-apply on worker start (advisory lock, idempotent).
  - Queue: pg-boss 12; queues get retryLimit 3 + backoff, dead-letter, job heartbeat 30s.
  - Crash test: worker killed mid-job → job retried ~90s later → completed. Orphaned runs marked failed by reaper.
  - Lake selftest: 1M rows write+read 1.7s; 6M rows 12.2s (≈30M rows/min).
  - Worker RSS hit 3.3 GB during the 6M selftest (all rows built in memory). Real stages must batch (2–5k).
  - Building images inside the Claude cloud sandbox needs a local, uncommitted compose override
    (build network host + HTTPS_PROXY + CA secret). The Dockerfile accepts an optional `ca` secret for that.
- Phase 2 — Volume sources: done (2026-11-19), see report in the Phase 2 section below.

## Phase 2 notes
- Source plugins: `apps/worker/src/sources/` (tranco, whoisds, ct, commoncrawl). Runner writes
  `data/lake/candidates/dt=YYYY-MM-DD/part-<source>-<batch>.parquet` (deterministic names → idempotent), then checkpoint.
- Each source has its own pg-boss queue `source.<key>` with policy `exclusive` (no overlapping runs).
- CT: logs are sharded by cert expiry. On 2026-11-19 the 2027h1 shards got ~97% of new entries.
  Rule `activeShards(daysAhead=60)` picks 15 of 50 usable logs. Logs are read in parallel (one reader per log);
  per-log failures are isolated (seen: TrustAsia HETU 429 rate limit, TrustAsia Luoshu 404 on a tile inside its checkpoint).
  Sequential reading of all 50 logs could not keep up (745k certs per 3.5 min window took >8 min).
- CT IP-only certificates have no DNS names (~10% of entries) — skipped by design.
- Common Crawl: filter `coalesce(url_host_private_suffix, url_host_registry_suffix) = url_host_registry_suffix`
  excludes platform subdomains (myshopify, github.io…). Full CC-MAIN-2026-43 scan: 292 files in 549 s.
- DuckDB `httpfs` must be INSTALLed once; done at startup and pre-installed in the worker image.

## Phase 2 measured volume (2026-11-19, this sandbox: 4 vCPU / 15 GB)
| Source | Unique domains | Time | Notes |
|---|---|---|---|
| Common Crawl CC-MAIN-2026-43 (300 files) | 3,616,848 with ≥1 signal (of ~34M scanned) | 9 min | eng: 2.41M; eng+main TLDs: ecommerce 1.60M, wellness 239k, agency 390k |
| CT, 14 active logs, 30-min matched window | 347,259 | — | 4 logs (sycamore, parcelyard, tiger, wyvern) = 283,300 (82%) → new default |
| CT discovery rate | ~40–70k new unique domains / 5 min | — | ≈ 3–5M unique/day conservatively |
| WhoisDS | 69.6–69.8k/day (4 days = 278,732) | 8 s | capped free sample |
| Tranco | 998,922 | 8 s | list L5KW4 |
| All combined | 5,553,790 unique | — | lake size 115 MB |
- Overlaps: CC∩Tranco 80.5k; CT∩(Tranco∪CC) only 3%; WhoisDS∩CT 573 (new + already live with HTTPS).
- CT keeps up: 15 logs read ~1.7× faster than real time; 4-log default reads 25 min of backlog in 216 s.
- Cloudflare Nimbus timestamps lag ~1 h behind other logs (its "unique" share in a time window is an artifact).

## Phase 3 — Cheap stages (done 2026-11-24)
- Stage 1 normalise: registry rebuild 5,623,260 domains in ~21 s; 41,234 junk dropped (digits 38,036, long label 2,017, hyphens 1,181).
- Planner: snapshot Parquet per stage + pg-boss batch jobs; outputs are the record of done work; recent 6 snapshots excluded.
- Benchmark (sandbox, 1 worker, DNS over HTTPS through the proxy, 30 min, 0 failed runs):
  DNS 889,706 domains/hour; homepage fetch 78,956/hour. Worker RSS ~3 GB.
- Funnel (top-priority domains first): DNS pass 99.5%; fetched 62,800 → live 53,038 (84%).
- Platforms on live pages: WooCommerce 25.7%, WordPress 19.1%, none 15.7%, Squarespace 14.7%, Shopify 14.1%, Wix 5.5%,
  Weebly 2.8%, Webflow 1.0%, GoDaddy 0.6%, Framer 0.2%.
- DNS platform rules derived from data (≥99.5% precision): agree with page fingerprints 99.96% where both known;
  DNS alone identifies 37% of sites. Nameservers too weak (24–93%) → not used. `dns-parking.com` is Hostinger, not parking.
- Sandbox-only: plain http:// blocked by the proxy (405) → `sandbox_http_blocked` (~11% of fetches); DNS needs `DNS_MODE=doh`.
- Bugs found & fixed: "coming soon" as menu label (rule limited to ≤150 words or title); NDJSON staging broke on real
  page text → Parquet writer now uses DuckDB appender; DOMException timeouts misclassified; Date→text for Postgres.
- Disk: HTML ≈ 28 KB/site compressed → retention 3 days + disk guard (`disk.min_free_gb` = 20).
- Not done yet (later phases): re-check schedule (7/21/45 days), parking NS rules (no reliable evidence yet).

## Phases 4–6 — Technologies, store probes, niches, contacts, signals (done 2026-11-25)
Run on real data in this sandbox (1 worker). Numbers below are the drained end state.

**Phase 4 — technologies + store probes**
- Fingerprints: vendored `enthec/webappanalyzer` (GPL-3.0, 7,704 technologies) in `packages/fingerprints`; worker-thread pool (`tech.threads`).
- 111,170 live pages analysed, avg 14.9 technologies per site; ~15–18k pages/hour per worker.
- Shopify 15,892 · WooCommerce 28,090 · WordPress 49,469 · Squarespace 18,952 · Wix 5,458 · Webflow 1,143.
- Marketing tools (HTML only): Facebook Pixel 8,286 · Mailchimp 3,874 · Klaviyo 2,661 · HubSpot 1,345 · Calendly 789.
  TikTok Pixel only 2 → pixels injected later by GTM / Shopify pixel manager are not visible in HTML (browser check in Phase 7).
- Store probes (public endpoints, verified live): Shopify 15,270/15,892 answered, median 77 products, median price 47, 5,848 published a
  product in the last 30 days. WooCommerce Store API 25,918/28,123 answered, median 24 products, median price 60 (Store API gives no dates).
  WordPress REST 18,756/20,728.
- Example segment: Shopify without Klaviyo = 13,648 of 15,892.

**Phase 5 — niches** (rules + keyword dictionaries; embeddings verified feasible, not enabled)
- 111,170 classified → 23,949 in scope (21.5%). DTC 14,709 · other 4,838 · white-label 3,404 · wellness 998.
- Saturated / non-commercial recognised and excluded: non-profit 496, restaurant 494, real estate 409, dental 277, law 228.
- Three review rounds on real samples; precision per niche ≈ 80–100%. Review file: `docs/phase5-niche-samples.csv` (50 per sub-niche).

**Phase 6 — contacts + signals**
- Email found for 80.7% of leads (role 11,192 · named 4,594 · freemail 3,542 · none 4,621). Phone 41–59%, owner 9–29%, address 9–28% by niche.
- Precision check: 45/45 extracted values found again on their source page.
- Country found for 71% (store 7,142 · phone 6,078 · address 3,134 · TLD 609). Top: US 6,902, GB 2,266, IN 1,531, AU 1,339, CA 990.
- Domain age via RDAP (IANA bootstrap, keyless): 92% of leads; no RDAP for some ccTLDs (.co/.io/.de).
- OSM Overpass skipped: no per-website lookup and its fair-use policy forbids bulk use.

**Bugs found & fixed during the end-to-end run**
- DuckDB spilled 19 GB → capped temp dir (`DUCKDB_MAX_TEMP`), HTML loaded only from the files that hold the batch.
- Normalize full rebuild overflowed (CT: 17M rows for 3.5M domains) → incremental chunked merge (full 36 s, incremental 6 s), test proves
  it equals a full rebuild. Priority used the first listed source instead of the best (10,505 domains too low) → fixed.
- Stale reads ("TProtocolException") after the registry was replaced under the same path → DuckDB external file cache off,
  versioned registry files + `CURRENT` pointer, planner snapshots written atomically, each stage planned independently.

## Phase 7 — Website audits (done 2026-11-25)
Run on real data in this sandbox (4 vCPU / 15 GB, 1 worker).

**Light audit (stage 9)** — 27 checks, no browser, all 23,949 in-niche leads in 67 min (~21k leads/hour with the rest of the
pipeline idle; trial batches ran at ~40k/hour). Avg 3.6 findings per lead, median 3; 981 leads with none.
- Top findings: no email marketing tool 11,040 (75% of DTC, HTML only), old image formats 8,820, no reviews 6,631 (45% of DTC),
  missing H1 6,045, render-blocking scripts 5,849, no analytics 4,966, no email signup 4,900, slow server 4,318 (+1,909 very slow).
- By platform: WooCommerce has the most problems (avg 3.9 high/medium, 67% old images, 45% slow server); Shopify, Squarespace
  and Wix convert images automatically (0–2% old images).
- Wellness: 46% have no online booking. White-label: 47% old images, 28% no analytics.
- Browser verification, two rounds: 153 cases first (6 rule errors found and fixed), then 80 fresh cases after the full run:
  no analytics 10/10, no email tool 10/10, no reviews 10/10, no contact form 10/10, no email signup 10/10, missing H1 27/30.
  H1 bug found: only the first H1 was read and Shopify themes wrap the logo image in it → `firstH1()` (first H1 with text,
  else logo alt, ignores `<noscript>`). 3,895 false findings corrected in lake + Postgres. Remaining limit: H1 added by JavaScript (1/20).

**Lighthouse (stage 10)** — Lighthouse 13.6 mobile preset, local headless Chrome, no key.
- Top tier = preliminary score ≥ 70 → 4,571 leads (19%). (≥ 60 would be 49%.)
- 136 sites scored so far: performance avg 47 / median 43.5 (63% "poor" < 50), accessibility 88, best practices 82, SEO 94,
  median LCP 6.9 s (inflated by the sandbox proxy). Findings: TBT poor 110, LCP poor 102, performance poor 86.
- Runtime check removed 7 light findings on 6 of 130 sites (no analytics 3, no reviews 2, email tool 1, signup 1).
- Benchmark: 4 parallel = 384–477 sites/hour (CPU-bound: ~15 s per site alone, 31–43 s with 4 at once on 4 vCPU);
  280/hour while the whole pipeline ran. Target 500/hour needs ~5+ cores. Success 59/60 standalone, 130/140 under full load.
- Bug found: Lighthouse cannot run twice in one process ("performance mark has not been set", plus slowdowns → 16/60 failed).
  Fix: one child process + one Chrome per run (`runner.ts`), killed if it hangs. Timeout 60 → 90 s (heavy pages need 61–65 s alone).
  Failed runs retried after 7 days. Migration 018.
- Docker worker image verified: Debian Chromium 156 installed, Lighthouse ran inside the container (31 s, all 4 scores).

**Other bugs found & fixed in this phase**
- Normalize failed on every run for ~20 h (registry 10.8M domains: regrouping all of it overflowed the 4 GB DuckDB temp cap).
  Fix: merge only domains seen again (anti/semi join), copy the rest. 23 s, no spill; test proves equal to a full rebuild.
  Backlog caught up: 10.84M → 11.77M domains. The planner errors in the same minutes came from the shared temp budget.
- Fingerprint data: upstream "Onsen UI" pattern matched cookie-consent scripts (267 false tags). Local fix in
  `packages/fingerprints/overrides.json` (kept by update.sh), false rows deleted.
- 30-minute full-pipeline run after the fixes: 0 errors, every stage moved data.

## Phase 8 — Brands, scoring, segments, first lines (done 2026-11-26)
5 placeholder brands (Shopify, Webflow, WordPress, white-label dev, design) until the real profiles arrive. Migration 019.

**Scoring** — `score = 100 × fit × need × reach × fresh^0.5`, per lead × brand; breakdown stored. Chosen over a weighted
average because an average let a WordPress site reach tier B for the Shopify brand. Tiers A ≥ 35, B ≥ 20 (first try 60/40
gave almost no A/B: four parts below 1 multiply to small numbers). Full rescore of 24,484 leads × 5 brands: 19 s
(~88k leads/min). Incremental: only leads whose inputs changed (tested: 1 changed → 1 rescored); a brand/template/settings
change (config hash) triggers a full rescore automatically.

| Brand (placeholder) | A | B | C | X (not a fit) | A/B with a first line |
|---|---|---|---|---|---|
| 1 Shopify | 1,382 | 2,604 | 12,093 | 8,405 | 100% |
| 2 Webflow | 99 | 319 | 20,082 | 3,984 | 100% |
| 3 WordPress | 417 | 1,767 | 21,462 | 838 | 100% |
| 4 White-label dev | 81 | 665 | 2,742 | 20,996 | 94% |
| 5 Design | 0 | 69 | 20,644 | 3,771 | 67% |

Brand 5 has no A because its placeholder problem map holds mostly rare/low findings — the real profile decides this.
Top needs among A/B: Klaviyo setup 3,592 and reviews app 2,339 (brand 1); image optimisation 1,796 and speed 1,599 (brand 3);
migration to Webflow 393 (brand 2).

**First lines** — 96,794 lines for 49,009 lead × brand pairs; max 22 words, 0 with "!". Verified against the live sites:
14/14 quoted facts true (WordPress 5.4.14 / 5.6 / 5.7.22, jQuery 3.1.1 / 1.10.2, © 2022 / 2024, Wix ×2, Squarespace ×3).
Three templates softened before the run (claims we cannot measure, e.g. "no follow-up emails" — Shopify Email is invisible in HTML).

**Segments** — 6 example segments, refreshed in 2 s. Spec example "Shopify DTC, US, 50–500 products, Meta Pixel, no Klaviyo,
Lighthouse < 50" = 5 leads (only 136 have Lighthouse so far); all 5 re-checked condition by condition. Independent count for
"Shopify, no email tool, English-speaking, A/B" = 2,439 = segment. Suppression test: 5 → 4 → 5.

**Bugs found & fixed in this phase**
- Broken links: Cloudflare's hidden-email link `/cdn-cgi/l/email-protection` is 404 when fetched but a mailto link in a browser
  → 242 of 862 "broken links" findings were false (28%). Sampling skips `/cdn-cgi/`; findings corrected. Recheck of 10 remaining:
  9 real 404s, 1 behind an anti-bot page (uncertain).
- Company names: HTML entities (`&amp;`, `&#039;`), title taglines, theme placeholders (`#site_title`), names without letters.
  `cleanCompanyName()` (keeps the title part matching the domain); 2,042 names cleaned, 290 dropped (export falls back to domain).

## Phase 9 — Dashboard (done 2026-11-26)
Next.js 16 (App Router, server components + server actions), Tailwind, shadcn-style components written in (no UI library).
Pages: Overview, Explorer, Segments (+ detail), Lead detail, Brands (+ edit), Niches (+ keywords), Sources, Exports (Phase 10 shell),
Settings, System. Migration 020.

**Built for it (worker side)**
- `system.funnel` (hourly, 18 s): lake counts (registry → DNS → pages) + Postgres counts (in niche → email → A/B) per first-seen
  day and source into `funnel_daily`, so the dashboard never scans the lake.
- `system.source-health` (hourly), `system.sync-sources` (every 5 min: schedule/on-off changes from the dashboard reach the worker
  without a restart), fingerprint version recorded at worker start.
- Segment filter split into a pure module (`@lead/shared/segment-filter`) used by both worker and dashboard.
- `classify.reclassify_after`: "Re-classify all" button; the planner re-does anything classified before it.
- Login: HTTP Basic auth in `proxy.ts` (Next 16 name for middleware, Node runtime → password read at start, not baked into the build).
  Production refuses to serve without `DASHBOARD_PASSWORD` (503). Next.js telemetry disabled in the image.

**Verified**
- Every page 200 in a real browser, no browser errors; 404 page for unknown leads. Server times 0.02–0.8 s (explorer count + page over
  24k leads × 5 brands); 2–8 s only while the worker was starting next to it (load average 13 on 4 cores).
- 19 browser checks of every write action on the real database, all reverted afterwards: brand save + validation (tier A < B rejected),
  template rules ("!" and unknown placeholder rejected, valid saved, deleted), segment saved from explorer (852 = explorer count) and
  deleted, suppression (URL → domain, junk rejected, CSV import: 2 added, duplicate and header skipped), settings (type change and
  bad JSON rejected), keyword add/remove, source "Run now" queued, lead delete → 404 + domain and email suppressed.
- Login: 401 without / with a wrong password, 200 with it; Docker web image built and served all pages (503 until a password is set).

**Bugs found & fixed in this phase**
- Overview speed per stage counted runs cut off by a container restart (7.7 h "running") → speed now from successful runs only.
- Explorer table too wide (last columns cut off) → niche + top need and platform + country merged; sub-niches grouped by niche.
- Dead-letter copies carry no job name in pg-boss 12 → Settings shows the failed jobs themselves (name + error).

**Known limits**
- "Delete and suppress" removes the lead from Postgres and blocks it from segments/exports; the raw rows stay in the data lake and a
  re-crawl can bring the lead back into the explorer (still suppressed). Purging the lake and skipping suppressed domains in the
  pipeline: Phase 11.
- Screenshots in `docs/screenshots/phase9-*.png` (pages without contact data; explorer/lead screenshots are not committed because they
  show real business emails).

**Known limits / next**
- One worker shares one DuckDB memory + temp budget; a burst (e.g. CT catching up after downtime + planner + normalize) can fail a job,
  which then retries. Phase 11: limit concurrent heavy DuckDB jobs.
- Sandbox only: `disk.min_free_gb` set to 10 (sandbox disk is ~40 GB); default stays 20.
