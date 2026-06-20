# Investment Portfolio Dashboard

Self-hosted portfolio dashboard: a Node.js service syncs holdings from **SnapTrade** and prices from **Finnhub** into **PostgreSQL**, visualized with **Grafana**. Runs locally, on a NAS, or on a private server via Docker Compose.

## How it works

Data flows in one direction: **SnapTrade** (accounts and holdings) and **Finnhub** (prices) → a Node.js **sync app** → **PostgreSQL** → **Grafana**.

The sync app is two plain Node.js scripts, with no build step:

* `app/sync.js` is a one-shot job. It lists SnapTrade accounts and positions, fully replaces the `holdings` table, appends to `holdings_history` and `portfolio_snapshots`, then fetches Finnhub prices for non-cash, non-mutual-fund tickers and appends them to `prices`. It runs once and exits.
* `app/sync-service.js` is a long-running HTTP service that wraps `sync.js`. It exposes `/health` and `/sync` endpoints, runs the cron schedules, and spawns `sync.js` as a child process. A `running` flag prevents overlapping syncs — a trigger received while a sync is in flight is skipped, not queued.

Price fetching is market-session aware (computed in U.S. Eastern time): `premarket`, `regular`, `afterhours`, or `closed`. When the market is closed (weekends, holidays, overnight) no price calls are made. During pre/after-hours the app prefers 1-minute candle data and falls back to the latest quote; during regular hours it uses the quote directly. Every `prices` row records the `session` and a `source` label identifying where the value came from.

## Built for Fidelity, adaptable to other sources

This dashboard was originally built to pull a Fidelity portfolio into a self-hosted view by way of SnapTrade, which is the only brokerage-facing dependency. Nothing downstream of the sync app is Fidelity-specific: the database schema, Grafana dashboard, and price logic only care about generic accounts, tickers, shares, and values.

An adept user can adapt this to other data sources by replacing the SnapTrade calls in `app/sync.js` with any system that can produce the same shape of data — accounts, positions (ticker + shares + optional cost basis), and account totals — and writing those rows into the existing `holdings`, `holdings_history`, and `portfolio_snapshots` tables. The rest of the stack will work unchanged.

## ⚠️ Landmine: the Grafana dashboard is generated, not hand-edited

The dashboard is **generated from a template at startup**, not hand-edited. On `docker compose up`, a one-shot `grafana-init` container renders `grafana/templates/finance_dashboard.template.json` into the dashboard Grafana provisions, substituting the `__SYNC_PUBLIC_URL__` placeholder with your `SYNC_PUBLIC_URL` from `.env-finance`. You do **not** run any render step by hand — edit the template, not the live dashboard (UI edits are overwritten on the next start).

The template **must be classic Grafana dashboard JSON** (with `panels` and `templating` keys), **not** the newer V2 format (with an `elements` key). Classic provisioning silently fails to load a V2 dashboard. If you re-export from the Grafana UI, export as Classic JSON and restore the `__SYNC_PUBLIC_URL__` placeholder before committing. See [Dashboard rendering](#dashboard-rendering) below for details.

> This project is not affiliated with, endorsed by, or sponsored by Fidelity Investments, SnapTrade, Finnhub, Grafana, PostgreSQL, Yahoo, or any other third-party service referenced in this repository. All trademarks are the property of their respective owners.

## Features

* Scheduled portfolio syncs during U.S. extended market hours
* Manual sync endpoint
* PostgreSQL-backed holdings and price history
* Provisioned Grafana datasource
* Provisioned Grafana dashboard
* Configurable host ports
* Configurable Grafana admin credentials
* Configurable dashboard manual-sync URL
* Yahoo Finance links for ticker symbols

## Repository structure

```text
app/
  sync.js
  sync-service.js
  render-dashboard.js     # renders the dashboard in-container from SYNC_PUBLIC_URL
  init-grafana.sh         # grafana-init entrypoint: provisioning + dashboard
  package.json
  Dockerfile

db/
  init/
    001_schema.sql

grafana/
  dashboards/             # generated at runtime into a volume; not required on disk

  templates/
    finance_dashboard.template.json

  provisioning/
    datasources/
      postgres.yml
    dashboards/
      dashboards.yml
    alerting/
    plugins/

scripts/
  render-dashboard.sh

docker-compose-finance.yml
.env-finance.example
README.md
```

## Services

The Docker Compose stack includes:

* `postgres` / `portfolio-db` - PostgreSQL database
* `grafana-init` / `portfolio-grafana-init` - one-shot init that renders the dashboard and populates the Grafana provisioning volumes, then exits (runs before Grafana)
* `grafana` / `portfolio-grafana` - Grafana dashboard UI
* `sync-service` / `portfolio-sync-service` - HTTP sync service and scheduler
* `sync` - one-shot manual sync job through the `manual` Docker Compose profile

## Requirements

You need:

1. Docker and Docker Compose on the target host.
2. A SnapTrade application and user credentials.
3. A Finnhub API key.
4. A `.env-finance` file based on `.env-finance.example`.

## Docker image

The sync app image is published to GitHub Container Registry:

```text
ghcr.io/businessiq-app/investment-dashboard-sync:latest
```

The image contains the Node.js sync application plus the baked-in Grafana dashboard template and provisioning configs that `grafana-init` uses at startup. PostgreSQL and Grafana themselves use public upstream images.

## Environment setup

Copy the example environment file:

```bash
cp .env-finance.example .env-finance
```

Edit it:

```bash
nano .env-finance
```

Required values:

```bash
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
FINNHUB_API_KEY=
DATABASE_URL=postgres://portfolio:portfolio@postgres:5432/portfolio

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-this-password
GRAFANA_HOST_PORT=3300
SYNC_HOST_PORT=38080

SYNC_PUBLIC_URL=http://localhost:38080/sync
```

Notes:

* `GRAFANA_HOST_PORT` controls the host port for Grafana.
* `SYNC_HOST_PORT` controls the host port for the manual sync API.
* `SYNC_PUBLIC_URL` controls the dashboard’s **Run Sync** link.
* `DATABASE_URL` should normally stay as `postgres://portfolio:portfolio@postgres:5432/portfolio` because containers communicate internally using the Docker service name `postgres`.

The `.env-finance` file contains secrets and must not be committed.

## Exposed ports

Only two services need host access:

| Service      | Default host port | Container port | Purpose         |
| ------------ | ----------------: | -------------: | --------------- |
| Grafana      |            `3300` |         `3000` | Dashboard UI    |
| Sync service |           `38080` |         `8080` | Manual sync API |

PostgreSQL is not exposed to the host by default. Grafana and the sync service reach it internally at:

```text
postgres:5432
```

Be careful exposing the sync endpoint publicly. It triggers live portfolio/API sync activity. If exposed outside your local network, protect it with Cloudflare Access, VPN, or another authentication layer.

## Dashboard rendering

Rendering is **automatic** — you do not run anything by hand. On `docker compose up`, the one-shot `grafana-init` container (built from this project's image) renders the dashboard before Grafana starts:

1. It reads `SYNC_PUBLIC_URL` from `.env-finance` (passed via `env_file`).
2. It substitutes the `__SYNC_PUBLIC_URL__` placeholder in the baked-in template
   (`grafana/templates/finance_dashboard.template.json`).
3. It writes the result, plus the provisioning configs, into the
   `portfolio_grafana_provisioning` and `portfolio_grafana_dashboards` volumes
   that Grafana mounts.

Because the template and provisioning configs are baked into the image, the stack is self-contained: deploying needs only `docker-compose-finance.yml` and `.env-finance` — no host-side `grafana/` directory and no render step.

To re-render after changing `SYNC_PUBLIC_URL` or the template, pull the latest image and bring the stack back up; `grafana-init` runs again and overwrites the volumes:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance up -d
```

### Optional: render locally to preview

`scripts/render-dashboard.sh` produces the same output on the host (handy for inspecting the JSON before committing a template change). It is not part of the deploy flow:

```bash
./scripts/render-dashboard.sh .env-finance
grep -n "Run Sync" -A10 grafana/dashboards/finance_dashboard.json
```

You should see the rendered sync URL, for example `http://localhost:38080/sync`.

## Configuring the Run Sync URL

`SYNC_PUBLIC_URL` is the URL opened by the Grafana dashboard’s **Run Sync** link. It must be reachable from the browser viewing Grafana.

For local use on the same machine:

```bash
SYNC_PUBLIC_URL=http://localhost:38080/sync
```

For another device on the same LAN:

```bash
SYNC_PUBLIC_URL=http://SERVER_IP:38080/sync
```

or:

```bash
SYNC_PUBLIC_URL=http://nas.local:38080/sync
```

For external access through a reverse proxy:

```bash
SYNC_PUBLIC_URL=https://your-domain.example.com/sync
```

If exposing the sync endpoint outside your local network, protect it with authentication.

## Starting the stack

Pull images:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance pull
```

Start the stack. The dashboard is rendered automatically by `grafana-init` before Grafana starts — no separate render step:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance up -d
```

(This starts PostgreSQL, `grafana-init`, Grafana, and the sync service. The one-shot `sync` container is in the `manual` profile and is not started.)

Check container status:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance ps
```

Check sync service health:

```bash
curl http://localhost:38080/health
```

Run the first manual sync so the database has data:

```bash
curl http://localhost:38080/sync
```

Open Grafana locally:

```text
http://localhost:3300
```

Or from another device:

```text
http://SERVER_IP:3300
```

## Grafana login

Default credentials come from `.env-finance`:

```text
username: GRAFANA_ADMIN_USER
password: GRAFANA_ADMIN_PASSWORD
```

Grafana only applies these admin credentials when its database volume is first initialized. If a Grafana volume already exists, changing `.env-finance` will not reset the password.

To reset the admin password manually:

```bash
docker exec -it portfolio-grafana grafana cli admin reset-admin-password NEW_PASSWORD
```

## Grafana provisioning

Provisioning is fully volume-based — Grafana reads it from two named volumes that `grafana-init` populates at startup from assets baked into the image:

* `portfolio_grafana_provisioning` → `/etc/grafana/provisioning`
  (the PostgreSQL datasource `postgres.yml` and the dashboard provider `dashboards.yml`)
* `portfolio_grafana_dashboards` → `/var/lib/grafana/dashboards`
  (the rendered `finance_dashboard.json`)

The source files live at `grafana/provisioning/` and `grafana/templates/` in this repo and are copied into the image at build time. Grafana places the dashboard in the `Portfolio` folder.

## Manual sync

Trigger sync through the HTTP service:

```bash
curl http://localhost:38080/sync
```

Or run the one-shot sync container:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance --profile manual run --rm sync
```

## Scheduled sync

The sync service schedules automatic syncs every 10 minutes during U.S. extended market hours:

* 04:00 ET through 19:50 ET, Monday-Friday
* Final run at 20:00 ET

The sync logic determines the market session and writes prices with session/source labels:

* `premarket`
* `regular`
* `afterhours`
* `closed`

The `source` column identifies whether the row came from quote, candle, or fallback quote data.

## Database tables

The sync job writes to:

* `holdings` - current holdings snapshot
* `holdings_history` - historical holdings snapshots
* `prices` - ticker price history
* `portfolio_snapshots` - account-level portfolio value history

Initial schema:

```text
db/init/001_schema.sql
```

This schema runs automatically only when PostgreSQL starts with a new empty volume.

## Backup and restore

Create a database backup:

```bash
docker exec portfolio-db pg_dump -U portfolio -d portfolio > portfolio_backup.sql
```

Restore a database backup:

```bash
cat portfolio_backup.sql | docker exec -i portfolio-db psql -U portfolio -d portfolio
```

Check row counts:

```bash
docker exec -it portfolio-db psql -U portfolio -d portfolio -c "
SELECT 'holdings' AS table_name, COUNT(*) FROM holdings
UNION ALL
SELECT 'holdings_history', COUNT(*) FROM holdings_history
UNION ALL
SELECT 'prices', COUNT(*) FROM prices
UNION ALL
SELECT 'portfolio_snapshots', COUNT(*) FROM portfolio_snapshots;
"
```

## Updating an existing deployment

Pull latest images:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance pull
```

Restart services. `grafana-init` re-runs and re-renders the dashboard (picking up any `SYNC_PUBLIC_URL` or template change) before Grafana restarts:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance up -d
```

Check sync service logs:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance logs -f sync-service
```

## Building the sync image

Most users can use the published GHCR image. To build the sync image locally, build from the **repo root** (the build context includes both `app/` and the baked `grafana/` assets) with the Dockerfile at `app/Dockerfile`:

```bash
docker build -f app/Dockerfile -t investment-dashboard-sync:local .
```

To run the local image instead, update `docker-compose-finance.yml` to use:

```text
investment-dashboard-sync:local
```

## Safety notes

Never commit:

* `.env`
* `.env-finance`
* API keys
* SnapTrade secrets
* Finnhub keys
* database backups containing private financial data

Before committing, verify:

```bash
git status
git ls-files | grep '^\.env'
git ls-files | grep '^\.env-finance$'
```

Neither `.env` nor `.env-finance` should appear in tracked files.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Fidelity Investments, SnapTrade, Finnhub, Grafana, PostgreSQL, Yahoo, or any other third-party service referenced in this repository. All trademarks are the property of their respective owners.
