# Investment Portfolio Dashboard

Self-hosted portfolio dashboard: a Node.js service syncs holdings from **SnapTrade** and prices from **Finnhub** into **PostgreSQL**, visualized with **Grafana**. Runs locally, on a NAS, or on a private server via Docker Compose.

I created this primarily out of frustration that fidelity doesn't provide a line graph of all individual holdings plotted against eachother (to identify outliers).

*Screenshots below use sample/demo data, not real holdings.*

<p align="center">
  <img src="screenshots/FauxData_1.jpeg" width="49%" alt="Dashboard overview">
  <img src="screenshots/FauxData_4.jpeg" width="49%" alt="Holdings detail">
  <img src="screenshots/FauxData_2.jpeg" width="49%" alt="Portfolio and account value over time">
  <img src="screenshots/FauxData_3.jpeg" width="49%" alt="Position and price history">
</p>

> This project is not affiliated with, endorsed by, or sponsored by Fidelity Investments, SnapTrade, Finnhub, Grafana, PostgreSQL, Yahoo, or any other third-party service referenced in this repository. All trademarks are the property of their respective owners.

## Quick start (no clone required)

**AT A GLANCE:**
- **Create a Snaptrade account** and link your fidelity account(s) there. 
- **Create a personal Finnhub** account (mine is a free) for credentials to pull current price quotes (**optionally also a free Tiingo account** to add real pre-market/after-hours prices)
- **Create the two files (yml & env) per the instructions below** and update the env file with your created accounts' keys/info
- This project will generate a DB and Grafana dashboard (Dashboards/portfolio/finance_dashboard) accessible at localhost:3300 as soon as you pull & start via the docker compose yml below 👇

**THE FULL DEETS:**
The published image is self-contained, so a deploy needs only **two files** in an empty directory: `docker-compose-finance.yml` and `.env-finance`. The schema, Grafana dashboard, and provisioning are all created automatically at startup.

Fetch both from this repo:

```bash
mkdir investment-dashboard && cd investment-dashboard
curl -O https://raw.githubusercontent.com/BusinessIQ-App/investment-dashboard-sync/main/docker-compose-finance.yml
curl -o .env-finance https://raw.githubusercontent.com/BusinessIQ-App/investment-dashboard-sync/main/.env-finance.example
```

Or create them by hand from the contents below.

<details>
<summary><code>docker-compose-finance.yml</code></summary>

```yaml
services:
  postgres:
    image: postgres:17
    container_name: portfolio-db
    environment:
      POSTGRES_DB: portfolio
      POSTGRES_USER: portfolio
      POSTGRES_PASSWORD: portfolio
    volumes:
      - portfolio_postgres_data:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d
    restart: unless-stopped

  # One-shot init: renders the dashboard from .env-finance and populates the
  # Grafana provisioning + dashboards volumes from assets baked into the image.
  # Runs to completion before Grafana starts, so the stack needs no host-side
  # grafana/ files — just this compose file and .env-finance.
  grafana-init:
    image: ghcr.io/businessiq-app/investment-dashboard-sync:latest
    container_name: portfolio-grafana-init
    env_file: .env-finance
    command: sh /app/init-grafana.sh
    volumes:
      - portfolio_grafana_provisioning:/grafana/provisioning
      - portfolio_grafana_dashboards:/grafana/dashboards
    restart: "no"

  grafana:
    image: grafana/grafana:latest
    container_name: portfolio-grafana
    ports:
      - "${GRAFANA_HOST_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}
    volumes:
      - portfolio_grafana_data:/var/lib/grafana
      - portfolio_grafana_provisioning:/etc/grafana/provisioning
      - portfolio_grafana_dashboards:/var/lib/grafana/dashboards
    depends_on:
      postgres:
        condition: service_started
      grafana-init:
        condition: service_completed_successfully
    restart: unless-stopped

  sync-service:
    image: ghcr.io/businessiq-app/investment-dashboard-sync:latest
    container_name: portfolio-sync-service
    env_file: .env-finance
    command: npm run service
    ports:
      - "${SYNC_HOST_PORT:-8080}:8080"
    depends_on:
      - postgres
    restart: unless-stopped

  sync:
    image: ghcr.io/businessiq-app/investment-dashboard-sync:latest
    env_file: .env-finance
    command: npm run sync
    depends_on:
      - postgres
    profiles:
      - manual

volumes:
  portfolio_postgres_data:
  portfolio_grafana_data:
  portfolio_grafana_provisioning:
  portfolio_grafana_dashboards:
```

The `./db/init` mount is optional — the sync app also creates the schema itself, so the stack works even if that directory does not exist on the host.

</details>

<details>
<summary><code>.env-finance</code> (template — fill in your secrets)</summary>

```bash
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
FINNHUB_API_KEY=
TIINGO_API_KEY=
DATABASE_URL=postgres://portfolio:portfolio@postgres:5432/portfolio

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-this-password
GRAFANA_HOST_PORT=3300
SYNC_HOST_PORT=38080

SYNC_PUBLIC_URL=http://localhost:38080/sync
```

</details>

Then edit `.env-finance` with your SnapTrade/Finnhub credentials (see [Environment file setup](#environment-file-setup-env-finance) and [Getting your Finnhub & SnapTrade API credentials](#getting-your-finnhub-a-snaptrade-api-credentials) for what each value means) and start the stack:

```bash
docker compose -f docker-compose-finance.yml --env-file .env-finance pull
docker compose -f docker-compose-finance.yml --env-file .env-finance up -d
```

Open Grafana at `http://localhost:3300` (or `http://SERVER_IP:3300`). The dashboard lands in the **Portfolio** folder; trigger the first data load with `curl http://localhost:38080/sync`.

## Environment file setup (.env-finance)

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
FINNHUB_API_KEY=
TIINGO_API_KEY=
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
DATABASE_URL=postgres://portfolio:portfolio@postgres:5432/portfolio

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=change-this-password
GRAFANA_HOST_PORT=3300
SYNC_HOST_PORT=38080

SYNC_PUBLIC_URL=http://localhost:38080/sync
```

Notes:

* **Price providers (`FINNHUB_API_KEY` / `TIINGO_API_KEY`)** — set at least one. With
  **both**, Finnhub serves the **regular** session and Tiingo serves **pre-market /
  after-hours** (Tiingo's free IEX feed reflects real extended-hours trades, which
  Finnhub's free tier doesn't). With only **one** set, that provider serves every session.
* `GRAFANA_HOST_PORT` controls the host port for Grafana.
* `SYNC_HOST_PORT` controls the host port for the manual sync API.
* `SYNC_PUBLIC_URL` controls the dashboard’s **Run Sync** link.
* `DATABASE_URL` should normally stay as `postgres://portfolio:portfolio@postgres:5432/portfolio` because containers communicate internally using the Docker service name `postgres`.

The `.env-finance` file contains secrets and must not be committed.

### Getting your FinnHub A& SnapTrade API credentials:

You need five values for `.env-finance`. Four are copy/paste from the two providers' websites; the fifth (`SNAPTRADE_USER_SECRET`) is returned by one command.

**Copy these from the browser:**

- **`FINNHUB_API_KEY`** — register at <https://finnhub.io/register> (the free tier is fine), confirm your email, and copy the key from your [Finnhub dashboard](https://finnhub.io/dashboard).
- **`TIINGO_API_KEY`** (optional, for real pre/post-market prices) — register at <https://www.tiingo.com> (free), copy the token from your account's API page. When set alongside Finnhub, Tiingo's IEX feed supplies pre-market/after-hours prices (Finnhub's free tier only reliably covers the regular session). Note: Tiingo free is IEX-only, so extended-hours prints can be sparse for thinly-traded tickers.
- **`SNAPTRADE_CLIENT_ID`** and **`SNAPTRADE_CONSUMER_KEY`** — sign up at <https://dashboard.snaptrade.com>, verify your email, then on the API Keys page copy the **Client ID** and **Consumer Key** (the Consumer Key is a secret — keep it private).
- **`SNAPTRADE_USER_ID`** — for a personal SnapTrade key this is the **email you signed up with**. SnapTrade auto-creates one user for your account at signup, so you don't invent or register a new id.
- **Link your brokerage (e.g. Fidelity):** SnapTrade needs your brokerage account connected before any holdings appear, through SnapTrade's Connection Portal. You new `http://localhost:38080/sync` API can't pull data until it's linked.

**Get `SNAPTRADE_USER_SECRET` with one command:**

SnapTrade never shows the user secret in the dashboard, and you can't fetch it with `registerUser` (your user already exists). Instead, mint one with the **reset/rotate** endpoint, which returns a fresh secret given just your `userId`. This needs only Python 3 (preinstalled on macOS and most Linux) — no Docker, no SDK, nothing to install. Replace the three bracketed placeholders (keep the double quotes) and run it in your terminal:

```bash
python3 -c '
import json,hmac,hashlib,base64,time,urllib.request,urllib.error
clientId="[REPLACE_WITH_YOUR_SNAPTRADE_CLIENT_ID]"
consumerKey="[REPLACE_WITH_YOUR_SNAPTRADE_CONSUMER_KEY]"
userId="[REPLACE_WITH_YOUR_SNAPTRADE_EMAIL]"
query="clientId="+clientId+"&timestamp="+str(int(time.time()))
body={"userId":userId}
sigContent=json.dumps({"content":body,"path":"/api/v1/snapTrade/resetUserSecret","query":query},separators=(",",":"),sort_keys=True)
sig=base64.b64encode(hmac.new(consumerKey.encode(),sigContent.encode(),hashlib.sha256).digest()).decode()
req=urllib.request.Request("https://api.snaptrade.com/api/v1/snapTrade/resetUserSecret?"+query,data=json.dumps(body).encode(),headers={"Content-Type":"application/json","Signature":sig},method="POST")
try: print("SNAPTRADE_USER_SECRET="+json.load(urllib.request.urlopen(req))["userSecret"])
except urllib.error.HTTPError as e: print("Error",e.code,e.read().decode())
'
```

Paste the resulting `SNAPTRADE_USER_SECRET=…` (UUID format) into `.env-finance`.

> ⚠️ This **rotates** the secret — run it once and save the result. Each call invalidates the previous secret, so if you run it again you must update `.env-finance` with the new value and restart the stack.

## Built for Fidelity, adaptable to other sources

This dashboard was originally built to pull a Fidelity portfolio into a self-hosted view by way of SnapTrade, which is the only brokerage-facing dependency. Nothing downstream of the sync app is Fidelity-specific: the database schema, Grafana dashboard, and price logic only care about generic accounts, tickers, shares, and values.

An adept user can adapt this to other data sources by replacing the SnapTrade calls in `app/sync.js` with any system that can produce the same shape of data — accounts, positions (ticker + shares + optional cost basis), and account totals — and writing those rows into the existing `holdings`, `holdings_history`, and `portfolio_snapshots` tables. The rest of the stack will work unchanged.

## ⚠️ Customizing the dashboard (save a copy)

The provisioned **finance_dashboard** is generated from a template at startup and is **read-only** — Grafana won't let you save edits onto it, and the `grafana-init` step re-renders (overwrites) it every time the stack starts. To keep your own customized version that survives restarts:

1. Open **Portfolio → finance_dashboard** and click **Edit**, then make your changes.
2. Use **Save as copy** (the exact label varies slightly by Grafana version) and give it a new name.

The copy is stored in Grafana's own database (the `portfolio_grafana_data` volume), which the auto-render never touches — so it **survives restarts and image updates**, and keeps querying the same Postgres datasource automatically. It's only lost if you delete that volume (e.g. `docker compose down -v`). The original `finance_dashboard` keeps re-rendering from the template, so you always have a clean reference to copy from again.

See [Dashboard rendering](#dashboard-rendering) for how the template is rendered.

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

## How it works

Data flows in one direction: **SnapTrade** (connected to your accounts and holdings) and **Finnhub** (prices) → a Node.js **sync app** → **PostgreSQL** → **Grafana**.

The sync app is plain Node.js with no JavaScript build step (the Docker image just bundles it and a few support assets):

* `app/sync.js` is a one-shot job. It connects to PostgreSQL, ensures the schema exists (idempotent), fully replaces the `holdings` table, appends to `holdings_history` and `portfolio_snapshots`, then fetches prices for non-cash, non-mutual-fund tickers (from Finnhub and/or Tiingo — see below) and appends them to `prices`. It runs once and exits.
* `app/sync-service.js` is a long-running HTTP service that wraps `sync.js`. It exposes `/health` and `/sync` endpoints, runs the cron schedules, and spawns `sync.js` as a child process. A `running` flag prevents overlapping syncs — a trigger received while a sync is in flight is skipped, not queued.
* `app/render-dashboard.js` and `app/init-grafana.sh` are used by the one-shot `grafana-init` service to render the dashboard and populate Grafana's provisioning at startup (see [Dashboard rendering](#dashboard-rendering)).

Price fetching is market-session aware (computed in U.S. Eastern time): `premarket`, `regular`, `afterhours`, or `closed`. When the market is closed (weekends, holidays, overnight) no price calls are made. The provider is chosen by which keys are configured: with both keys, **Finnhub** serves the regular session and **Tiingo** (IEX) serves pre-market/after-hours; with only one key set, that provider serves every session. During Finnhub extended hours the app prefers 1-minute candle data and falls back to the latest quote. Every `prices` row records the `session` and a `source` label (`finnhub_quote`, `finnhub_candle_1m`, `finnhub_quote_fallback`, or `tiingo_iex`) identifying where the value came from.

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
3. A price-provider key — Finnhub and/or Tiingo (Tiingo adds real pre/post-market prices).
4. A `.env-finance` file based on `.env-finance.example`.

## Docker image

The sync app image is published to GitHub Container Registry:

```text
ghcr.io/businessiq-app/investment-dashboard-sync:latest
```

The image contains the Node.js sync application plus baked-in assets used at startup: the Grafana dashboard template and provisioning configs (for `grafana-init`) and the idempotent database schema (applied by `sync.js`). PostgreSQL and Grafana themselves use public upstream images.

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

### Editing the template (contributors)

The template must stay **classic** Grafana dashboard JSON (with `panels` and `templating` keys), **not** the V2 format (with an `elements` key) — classic provisioning silently fails to load a V2 dashboard. If you re-export from the Grafana UI, export as Classic JSON and restore the `__SYNC_PUBLIC_URL__` placeholder before committing.

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

The `source` column identifies where the price came from: `finnhub_quote`, `finnhub_candle_1m`, `finnhub_quote_fallback` (Finnhub), or `tiingo_iex` (Tiingo IEX, used for extended hours when a Tiingo key is set).

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

The schema is created automatically — you never run it by hand. It is applied two ways:

* On a **fresh** PostgreSQL volume, via the `db/init` mount (Postgres runs it on first init).
* On **every sync**, by the sync app itself. The schema is idempotent
  (`CREATE TABLE/INDEX IF NOT EXISTS`) and baked into the image, and `sync.js` applies it
  right after connecting. This means a compose-only deploy with no `db/init` directory still
  gets its tables on the first sync, and a database created before the schema existed heals
  itself on the next sync.

## Backup and restore

Create a FULL database backup:

```bash
docker exec portfolio-db pg_dump -U portfolio -d portfolio > portfolio_backup.sql
```

Restore a FULL database backup:

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

Backup financial tables only:

```bash
docker exec portfolio-db pg_dump --data-only --no-owner \
    -t holdings -t holdings_history -t prices -t portfolio_snapshots \
    -U portfolio -d portfolio | gzip > portfolio-real-backup.sql.gz
ls -lh portfolio-real-backup.sql.gz
```

Restore financial tables only:

```bash
docker exec -i portfolio-db psql -v ON_ERROR_STOP=1 -U portfolio -d portfolio \
    -c "TRUNCATE holdings, holdings_history, prices, portfolio_snapshots;"
gunzip -c portfolio-real-backup.sql.gz | docker exec -i portfolio-db psql -v ON_ERROR_STOP=1 -U portfolio -d portfolio
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
