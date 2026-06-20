#!/bin/sh
# One-shot init for the self-contained stack: populates the Grafana provisioning
# and dashboards volumes from assets baked into this image, rendering the
# dashboard with SYNC_PUBLIC_URL from .env-finance (passed via env_file).
# Runs to completion before Grafana starts (see docker-compose depends_on).
set -eu

PROV_DEST="${GRAFANA_PROVISIONING_DIR:-/grafana/provisioning}"
DASH_DEST="${GRAFANA_DASHBOARDS_DIR:-/grafana/dashboards}"

mkdir -p "$PROV_DEST" "$DASH_DEST"

# Copy provisioning configs (datasource + dashboard provider) into the volume.
cp -a /app/grafana-assets/provisioning/. "$PROV_DEST/"

# Render the dashboard JSON into the volume Grafana provisions from.
node /app/render-dashboard.js /app/grafana-assets/template.json "$DASH_DEST/finance_dashboard.json"

echo "Grafana provisioning and dashboard initialized."
