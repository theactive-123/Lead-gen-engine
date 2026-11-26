# Going live — step by step

You need one computer that stays on. Pick **A** to try it on your own PC, or **B** for a free server that runs 24/7
(that is what reaching 1M domains a month needs). Nothing here needs an API key or a paid service.

---

## What the computer needs

| | Minimum | Comfortable |
|---|---|---|
| CPU | 2 cores | 4 cores |
| Memory | 8 GB | 16 GB |
| Free disk | 100 GB | 150–200 GB |
| Internet | always on | always on |

Why the disk: every fetched homepage is kept compressed for 3 days (≈ 20–30 GB at full speed), plus the data lake
(≈ 6 GB per ~12 million domains found) and the database.

---

## A. Your own PC (Windows or Mac) — to try it

Crawling only runs while the PC is on and awake.

1. **Install Docker Desktop**: go to <https://www.docker.com/products/docker-desktop/>, click **Download** for your
   system, run the installer, accept the defaults, restart when asked. Open Docker Desktop once and wait until it says
   *Engine running* (bottom left). On Windows it may ask to install **WSL** — click **Install** / **Restart**.
2. **Download the project**: on <https://github.com/theactive-123/Lead-gen-engine> click the green **Code** button →
   **Download ZIP**. Unzip it, e.g. to `Documents\Lead-gen-engine`.
3. **Create your settings file**: in that folder, copy `.env.example` and rename the copy to `.env`
   (Windows: turn on *View → File name extensions* first, so it is not called `.env.txt`). Open `.env` with
   Notepad / TextEdit and change these lines (no spaces around `=`):
   - `POSTGRES_PASSWORD=` a long random password
   - `CRAWLER_CONTACT_EMAIL=` an inbox website owners can write to (shown to every site we visit)
   - `DASHBOARD_PASSWORD=` another long random password
   Save the file.
4. **Start it**: open a terminal in the folder (Windows: right-click the folder → *Open in Terminal*;
   Mac: right-click → *New Terminal at Folder*) and run:
   ```bash
   docker compose up -d --build
   ```
   The first start downloads and builds everything (10–20 minutes).
5. **Open the dashboard**: <http://localhost:3000> — user `admin`, password = your `DASHBOARD_PASSWORD`.

Stop: `docker compose down` (your data stays in the `data` folder and the database volume).
Start again: `docker compose up -d`.

---

## B. Free cloud server (Oracle Cloud "Always Free") — runs 24/7

Checked on Oracle's own page on 2026-11-26
(<https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>):
the free Arm server (Ampere A1) is **2 CPU cores and 12 GB memory in total**, **200 GB disk in total**
(the server's own disk counts), **10 TB outbound traffic a month**, only in your **home region**. Oracle may take back a
free server that is idle (CPU, network and memory all under 20% for 7 days) — a running engine is busy, so this does
not apply while it works. Oracle asks for a card to verify the sign-up; Always Free resources are not charged.

### 1. Create the server
1. Sign up at <https://www.oracle.com/cloud/free/> → **Start for free**. Choose a home region close to you
   (you cannot change it later, and the free server must be in it).
2. In the console: **☰ menu → Compute → Instances → Create instance**.
3. **Name**: `leadengine`.
4. **Image and shape → Edit**:
   - **Change image** → *Canonical Ubuntu* → **24.04** → *Select image*.
   - **Change shape** → *Ampere* → **VM.Standard.A1.Flex** → OCPUs **2**, Memory **12 GB** → *Select shape*.
5. **Networking**: keep the defaults (new virtual cloud network, **Assign a public IPv4 address** = yes).
6. **Add SSH keys**: choose **Generate a key pair for me** → click **Save private key** (keep this file safe; it is your
   login) and **Save public key**.
7. **Boot volume**: tick **Specify a custom boot volume size** → **150** GB.
8. Click **Create**. When the state turns *Running*, copy the **Public IP address**.

If Oracle says "Out of capacity" for the Ampere shape, try again later or pick another *availability domain* in step 5.

### 2. Log in to the server
On your PC, in a terminal (in the folder where the key file is):
```bash
ssh -i YOUR-KEY.key ubuntu@SERVER-IP
```
(Replace `YOUR-KEY.key` with the file name Oracle gave your private key, and `SERVER-IP` with the IP from step 1. On Mac/Linux first run `chmod 600 YOUR-KEY.key`.
Answer `yes` the first time.)

### 3. Install Docker (official script from docker.com)
```bash
curl -fsSL https://get.docker.com | sudo sh
```
```bash
sudo usermod -aG docker ubuntu
```
Log out (`exit`) and log in again (step 2), so you can use Docker without `sudo`.

### 4. Download the project and set it up
```bash
git clone https://github.com/theactive-123/Lead-gen-engine.git
```
```bash
cd Lead-gen-engine && cp .env.example .env && nano .env
```
In the editor change `POSTGRES_PASSWORD`, `CRAWLER_CONTACT_EMAIL`, `DASHBOARD_PASSWORD`, and — because the free server
has 2 cores and 12 GB — these:
```
WORKER_CONCURRENCY=3
DUCKDB_MEMORY_LIMIT=2GB
DUCKDB_THREADS=2
```
Save with **Ctrl+O**, **Enter**, then **Ctrl+X**.

### 5. Start everything
```bash
docker compose up -d --build
```
First build: 15–30 minutes on the free server. Check that all four parts run (`postgres`, `worker`, `web`, `backup`):
```bash
docker compose ps
```
Then, in the dashboard **Settings**, set `lighthouse.parallel` to `1` (one Chrome at a time on 2 cores).

### 6. Open the dashboard (private by default)
Oracle blocks every port except SSH, so the dashboard is not on the internet — good. Open it through your SSH login:
```bash
ssh -i YOUR-KEY.key -L 3000:localhost:3000 ubuntu@SERVER-IP
```
Keep that window open and visit <http://localhost:3000> on your PC (user `admin` + your `DASHBOARD_PASSWORD`).

### 7. Everyday
| Want to… | Run (on the server, in `Lead-gen-engine`) |
|---|---|
| See if everything runs | `docker compose ps` |
| See the worker's log | `docker compose logs -f --tail 50 worker` |
| 7-day report (volume, funnel, bottleneck) | `docker compose exec worker pnpm --filter @lead/worker jobs report 7` |
| Update to the newest code | `git pull && docker compose up -d --build` |
| Copy last night's backup to your PC (run on your PC) | `scp -i YOUR-KEY.key "ubuntu@SERVER-IP:Lead-gen-engine/data/backups/*.dump" .` |

Everything restarts by itself after a reboot of the server (Docker starts the containers again).

---

## The first 7 days (Phase 11 test)

Leave it running. After 7 days run the report command above and send me the output — it shows new domains per source
and per day (vs the 1M/month target), the funnel, the speed of every stage, what is waiting, and the slowest stage.
I tune the settings from those real numbers.

What to expect on the free server (estimate from this project's measurements on 4 cores, scaled to 2): DNS
≈ 400k/hour, homepages ≈ 15–20k/hour, technology detection a little slower than fetching. Sources deliver far more
than 1M new domains a month, so the homepage fetch is the stage that decides how many become leads; the report shows it.

---

## Backups and restore

The `backup` service writes `data/backups/lead-YYYYMMDD-HHMM.dump` every 24 hours and keeps 7 days
(`BACKUP_KEEP_DAYS` in `.env`). It covers the lead database: brands, segments, scores, contacts, do-not-contact list,
export history. The data lake (`data/lake`) can be rebuilt by the engine from public sources, but copying the whole
`data` folder elsewhere now and then is a good idea.

Restore a backup (replaces the current lead database):
```bash
docker compose stop worker web
```
```bash
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
```
```bash
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < data/backups/lead-YYYYMMDD-HHMM.dump
```
```bash
docker compose up -d
```

## Not tested in this project yet
- The Docker images were built and run on a normal (x86) server. Every part has an official Arm build (Node.js,
  Postgres, Debian Chromium, DuckDB, Next.js — all Arm packages are in the lock file), but the first real Arm build
  happens on your Oracle server. If step 5 fails, send me the last 30 lines it printed.
