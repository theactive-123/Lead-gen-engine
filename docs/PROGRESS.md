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
- WhoisDS daily NRD zip: `https://www.whoisds.com/whois-database/newly-registered-domains/<base64(YYYY-MM-DD.zip)>/nrd`,
  ~70k domains/day. Terms page still to be checked before Phase 2 plugin.
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
- Phase 2 — Volume sources: next
