# LeadEngine

A free, self-hosted engine that collects business websites from public data sources,
enriches them (tech stack, store size, niche, contacts, site quality) and turns them into
scored leads for each of your brands. No API keys, no paid services.

> Status: **Phases 1–6** done (sources, DNS, fetch, technologies, store probes, niches, contacts, business signals). See `docs/PROGRESS.md` for what is built and verified.

---

## What runs where

| Part | What it does | Where its data lives |
|---|---|---|
| **postgres** | The lead database: refined leads, settings, run history, job queue | Docker volume `pgdata` |
| **worker** | Does all the work (collecting, crawling, enriching) by taking jobs from the queue | Writes bulk data to `./data/lake` |
| **web** | The dashboard at `http://localhost:3000` | Reads the database |

**Why two kinds of storage?** Millions of raw domains go into Parquet files in `./data/lake`
(cheap, fast to scan with DuckDB). Only the good, enriched leads go into Postgres, so the
dashboard stays fast and the database stays small.

---

## Start it (one command)

You need **Docker** installed (Docker Desktop on Windows/Mac, Docker Engine on Linux).

1. Download the project:
   ```bash
   git clone https://github.com/theactive-123/Lead-gen-engine.git
   ```
   ```bash
   cd Lead-gen-engine
   ```
2. Create your settings file and open it in any text editor:
   ```bash
   cp .env.example .env
   ```
   Change `POSTGRES_PASSWORD`. Set `CRAWLER_CONTACT_EMAIL` (needed from Phase 3).
3. Start everything:
   ```bash
   docker compose up -d --build
   ```
4. Open **http://localhost:3000** (on a server: `http://SERVER-IP:3000`).

Stop: `docker compose down` (your data is kept). Update after pulling new code: run step 3 again.

---

## Settings (`.env`)

| Variable | Meaning | Default |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database login, only used inside this machine | `lead` / `lead` / `lead` |
| `CRAWLER_CONTACT_EMAIL` | Shown to website owners in every request so they can reach you. Use a separate inbox. | placeholder |
| `WORKER_CONCURRENCY` | Jobs one worker process runs at once | `4` |
| `DUCKDB_MEMORY_LIMIT` / `DUCKDB_THREADS` | Memory and CPU threads for bulk data scans. Lower on small machines | `2GB` / `4` |
| `DUCKDB_MAX_TEMP` | Most disk DuckDB may use for very big queries (a query fails and retries instead of filling the disk) | `4GB` |
| `DNS_MODE` | Empty = use the dashboard setting (`udp`, fastest). `doh` = DNS over HTTPS, only if your network blocks normal DNS | empty |
| `CHROME_PATH` | Chrome/Chromium for Lighthouse. The Docker worker already has Chromium; set this only when running the worker outside Docker | empty |
| `WEB_PORT` | Dashboard port | `3000` |
| `LOG_LEVEL` | How much the worker writes to its log: `error`, `warn`, `info`, `debug` | `info` |

Crawl speed, rate limits and batch sizes are **not** in `.env`: they live in the `settings`
table and will be editable from the dashboard (Settings page, Phase 9).

---

## Everyday commands

| Want to… | Run |
|---|---|
| See if everything is up | `docker compose ps` |
| Watch the worker's log | `docker compose logs -f worker` |
| See job queues | `docker compose exec worker pnpm --filter @lead/worker jobs list` |
| Run a job now | `docker compose exec worker pnpm --filter @lead/worker jobs run system.lake-selftest '{"rows":1000000}'` |
| Run more workers (more speed) | `docker compose up -d --scale worker=3` |
| Rescore every lead now (after editing brands) | `docker compose exec worker pnpm --filter @lead/worker jobs score full` |
| Refresh saved segments now | `docker compose exec worker pnpm --filter @lead/worker jobs segments` |
| Count a filter without saving it | `docker compose exec worker pnpm --filter @lead/worker jobs count brand_1 '{"platforms":["Shopify"],"tiers":["A","B"]}'` |

---

## Data sources (all free, no keys)

| Source | What it gives | Schedule (UTC) |
|---|---|---|
| `commoncrawl` | Domains from the monthly Common Crawl index that have shop, booking or agency pages (patterns in the `source_url_signals` table) | daily 04:23 (only new index files are scanned) |
| `ct` | Domains that just got an HTTPS certificate (= site going live), from Certificate Transparency logs | every 10 min |
| `whoisds` | Newly registered domains (free daily list, capped at 70,000/day) | every 6 h |
| `tranco` | Top 1 million sites (used later to spot big brands and estimate size) | daily 03:17 |

Every source writes to `data/lake/candidates/dt=<day>/` and remembers where it stopped (the `checkpoints` table),
so it continues after a restart. Turn a source on/off or change its options in the `sources` table
(dashboard page in Phase 9).

Useful commands:

| Want to… | Run |
|---|---|
| Check every source is reachable | `docker compose exec worker pnpm --filter @lead/worker jobs health` |
| Run a source now | `docker compose exec worker pnpm --filter @lead/worker jobs source whoisds` |
| See the volume report | `docker compose exec worker pnpm --filter @lead/worker exec tsx src/reports/phase2.ts` |

---

## Pipeline stages (Phase 3)

| Stage | What it does | Output |
|---|---|---|
| 1 Normalise (`stage.normalize`, every 15 min) | Merges all sources into one row per domain, scores a **priority** (best leads first) and drops junk | `data/lake/registry/current/` (a new `registry-<time>.parquet` each run; `CURRENT` names the live one) |
| 2 DNS (`stage.dns`) | Website address, www, mail (MX) and nameservers; mail provider and platform from DNS rules | `data/lake/dns/` |
| 3 Homepage fetch (`stage.fetch`) | Checks robots.txt, fetches the homepage politely (1 request/second per website), extracts features, tags parked/placeholder pages, detects the platform | `data/lake/pages/` (features), `data/lake/html/` (compressed HTML, kept 3 days), live sites → Postgres `domains` |

The planner (`stage.plan`, every minute) hands out work in batches. A domain counts as done once it has an
output row, so restarts never lose or repeat work. If free disk drops below `disk.min_free_gb` (default 20 GB),
planning pauses until space is freed.

Rules you can edit (dashboard in Phase 9; tables today):
- `normalize.rules` setting: priority points per source, preferred TLDs, junk filters.
- `platform_signatures`: DNS rules for platform and mail provider (each with its measured evidence).
- `page_tag_rules`: what counts as parked / coming soon / default page.

Commands: `jobs normalize`, `jobs plan` (see "Everyday commands").

---

## Enrichment stages (Phases 4–6)

| Stage | What it does | Output |
|---|---|---|
| 4 Technologies (`stage.tech`) | Detects ~7,700 technologies (Shopify apps, pixels, email tools, page builders, booking widgets…) from the stored homepage, using the open fingerprint data in `packages/fingerprints` | `data/lake/tech/`, Postgres `technologies` |
| 5 Store probe (`stage.probe`) | Shopify: product count, location, prices of the 30 newest products, last product date. WooCommerce: product count, prices, categories. WordPress: installed plugin APIs | `data/lake/store_probe/`, Postgres `store_profiles` |
| 6 Niche (`stage.classify`) | Scores every live site against your niche list (keywords in title/description/products, store / booking / services evidence) | `data/lake/classified/`, Postgres `classifications` |
| 7 Contacts (`stage.contacts`) | For in-niche leads: homepage + up to 5 pages (contact, about, team, privacy, terms…) → emails, phones, address, founder/owner, social links. Emails are checked for a mail server (MX), never by sending | `data/lake/contacts/`, Postgres `contacts` |
| 8 Business signals (`stage.signals`) | Country (and where it came from), size, freshness (domain age via RDAP), marketing tools | `data/lake/signals/`, Postgres `companies` |

**How a niche is decided** (all editable in the `niches`, `sub_niches`, `keywords`, `url_patterns`, `niche_tech_hints` tables):
- Keywords count more in the title (×3) and description / product names (×2) than in body text (×1, at most 2 points).
- DTC brands need **real store evidence** (store platform, products, or shop pages). Agencies get a boost from services /
  portfolio pages; studios from booking software. Boosts only add to real keyword evidence.
- Dentists, restaurants, real estate, law firms and non-profits are recognised and **excluded** (not mislabelled).
- Leads outside every niche are removed from Postgres and kept in the data lake.

**Things to know**
- Technology detection reads the HTML only. Tools that load later (e.g. pixels added by Google Tag Manager or Shopify's
  pixel manager) can be missed, so "no pixel found" is not proof of "no ads" — the browser check in Phase 7 confirms.
- Fingerprint data is vendored from `enthec/webappanalyzer` (`packages/fingerprints/update.sh` refreshes it). Upstream
  patterns we found wrong on real pages are corrected in `packages/fingerprints/overrides.json`, which the update keeps.
- Pages are fetched politely: robots.txt is respected, at most 1 request per second per website.
- Backpressure: fetching pauses while many pages wait for technology detection (HTML is kept 3 days), and DNS
  pauses while many domains wait for fetching.

---

## Website audits (Phase 7)

Two audit stages run after contacts and signals:

| Stage | Runs on | What it does | Output |
|---|---|---|---|
| 9 Light audit (`stage.audit`) | every in-niche lead | 27 fast checks without a browser, from the saved homepage plus a few small requests (≤1 per second per site, robots.txt respected) | `data/lake/audits/`, Postgres `audits` + `audit_findings` (source `light`) |
| 10 Lighthouse (`stage.lighthouse`) | top tier only | Google Lighthouse, run **locally** in headless Chrome (mobile preset, no API key): performance, accessibility, best practices and SEO scores, plus load speed (LCP), layout shift (CLS) and blocking time (TBT) | `data/lake/lighthouse/`, Postgres `audits.lighthouse` + `audit_findings` (source `lighthouse`) |

**Light audit checks:** title / meta description / H1 / viewport, slow server, heavy page, too many or render-blocking
scripts, old image formats (JPG/PNG where the platform does not convert them), images without alt text, mixed content,
outdated jQuery / WordPress, old copyright year, broken links (sample, only 404/410 count), favicon, http→https,
contact form, and per-niche gaps: no email marketing tool / no email signup / no reviews (stores), no online booking
(studios), no analytics. Website builders (Wix, Squarespace, Weebly, GoDaddy) are tagged as information.
Every finding has a `code`, `severity` (high / medium / low / info), a plain-English message and the evidence.

**Who gets Lighthouse:** a preliminary score from data we already have (email found, named email, niche confidence,
completeness, recent activity, number of problems). Leads at or above `lighthouse.prelim.min_score` (default 70,
about the top 20%) are audited, best first. A failed run (timeout, crash) is tried again after 7 days.

**Lighthouse also corrects the light audit:** the browser sees tools that load later (e.g. Klaviyo or a pixel added by a
tag manager). Those are saved as technologies with source `runtime`, and a light finding they disprove
(e.g. "no email marketing tool") is removed.

**Settings** (in the `settings` table): `audit.rules` (every threshold and list above), `lighthouse.prelim`,
`lighthouse.rules` (Google's "poor" thresholds), `lighthouse.parallel` (Chrome instances, about 1 per CPU core),
`lighthouse.timeout_ms` (90 s; heavy pages need 60+ s).

**Things to know**
- Lighthouse scores move between runs (network, server load); treat a score as a range of about ±10, not an exact number.
- The light audit reads the HTML the server sends. A heading or form added later by JavaScript can be missed
  (seen on 1 of 20 checked "no H1" sites). Lighthouse runs a real browser, so top-tier leads are checked properly.
- Each Lighthouse run is its own process with its own Chrome: Lighthouse cannot run twice in one process.

---

## Brands, scoring and first lines (Phase 8)

Every in-niche lead is scored for **each of your 5 brands** every 15 minutes (only leads whose data changed;
everything when you change a brand). The 5 brands are **placeholders** (Shopify, Webflow, WordPress, white-label
development, design) until you fill in the real profiles.

**What a brand profile holds** (tables `brands`, `brand_niche_weights`, `brand_problem_map`, `brand_templates`):
services, price range, target niches / sub-niches (weight 0–1; 0 = excluded), platforms (weight per platform),
countries (target / excluded), catalog size, which audit findings the brand can fix and the service it sells for each,
first-line templates, scoring weights and tier cut-offs.

**The score** — four parts, each 0 to 1, multiplied:

| Part | Asks | Comes from |
|---|---|---|
| Fit | Is this the brand's kind of customer? | niche weight × platform weight × country × catalog size × niche confidence |
| Need | Does the site have problems this brand fixes? | findings in the brand's problem map (weight × severity) |
| Reach | Can we contact them? | email type (named > role > freemail), phone only, plus completeness |
| Freshness | Is the business active? | recent product, current copyright year, young domain; old copyright lowers it |

`score = 100 × fit × need × reach × freshness^0.5` (the powers are the brand's editable weights). Multiplying means
one weak part pulls the score down: a niche the brand does not serve scores 0 (tier **X**, not a fit).
Tiers: **A ≥ 35**, **B ≥ 20**, else **C** — an A lead is roughly fit 0.8, one clear problem, a usable email and recent
activity. Every match stores its **breakdown** (each part, the matched problems and services), so you can see why.

**First lines** — up to 3 per lead and brand, from templates (no AI, no key). Each one quotes one real finding with
its measured value ("scores 29/100 for mobile speed", "the footer still says © 2022", "runs WordPress 5.4.14").
A template whose value is missing is skipped — lines are never filled with guesses. Every line is checked against
`first_lines.rules`: at most 25 words, no "!", no banned phrases ("I hope this finds you well", "game-changer"…).
Placeholders: `{domain}`, `{company}`, `{score}`, `{lcp_s}`, `{tbt_s}`, `{ttfb_s}`, `{cls}`, `{year}`, `{version}`,
`{scripts}`, `{count}`, `{broken_path}`, `{platform}`, `{product_count}`. A template with code `niche:<sub-niche>`
talks about the lead's business instead (used by the white-label brand, which sets `lead_with_niche`).

**Segments** (table `segments`) are saved filters per brand, e.g. *Shopify DTC, US, 50–500 products, Meta Pixel,
no Klaviyo, Lighthouse < 50*. Filter keys: `tiers`, `min_score`, `niches`, `sub_niches`, `platforms`, `tech_has`,
`tech_any`, `tech_not`, `countries`, `exclude_countries`, `product_count_min/max`, `price_median_min/max`,
`lighthouse_perf_max`, `completeness_min`, `has_email`, `email_types`, `findings_has`, `findings_any`, `findings_not`,
`first_seen_after`. Members are refreshed daily (03:17 UTC) and keep the date they joined. Anything in the
`suppression` table (domain or email) is never in a segment, and is checked again before every export.

---

## How it stays reliable

- **Jobs survive crashes.** Each job is stored in Postgres. If a worker dies mid-job, the job is
  retried automatically about a minute later (tested: killed during a 6M-row job → retried → finished).
- **Failed jobs retry 3 times** with growing delays, then move to `system.dead-letter` for review.
- **Every run is logged** in the `runs` table: records in/out, drops by reason, errors, speed per minute.
- **Resume points** (`checkpoints` table) let each source continue where it stopped.
- **Disk monitor** records free space and data-lake size every 15 minutes.

---

## Project layout

```
apps/worker     the worker (jobs, sources, pipeline stages)
apps/web        the dashboard (Next.js)
packages/shared shared code: settings, database, queue, data lake, run logging
packages/shared/migrations   database tables (applied automatically on start)
data/lake       Parquet data lake (created at runtime, not in git)
docs/           progress log and screenshots
```

## Server size

For ~1M records/month: **4 CPU cores, 16–24 GB RAM, 150–200 GB disk** (e.g. Oracle Cloud Always Free ARM).
