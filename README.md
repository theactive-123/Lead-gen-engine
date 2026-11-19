# LeadEngine

A free, self-hosted engine that collects business websites from public data sources,
enriches them (tech stack, store size, niche, contacts, site quality) and turns them into
scored leads for each of your brands. No API keys, no paid services.

> Status: **Phase 1 (Foundation)** done. See `docs/PROGRESS.md` for what is built and verified.

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
