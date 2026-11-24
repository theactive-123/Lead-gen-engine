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
