FROM node:22-alpine
LABEL org.opencontainers.image.title="Investment Dashboard Sync"
LABEL org.opencontainers.image.description="Node.js sync service for a self-hosted investment portfolio dashboard using SnapTrade, Finnhub, PostgreSQL, and Grafana."
LABEL org.opencontainers.image.vendor="BusinessIQ-App"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY app/package*.json ./

RUN npm install

COPY app/ ./

# Bake the Grafana provisioning configs and dashboard template into the image so
# the grafana-init container can render and provision the dashboard at startup
# with no host-side files — the stack ships from compose + .env-finance alone.
COPY grafana/provisioning ./grafana-assets/provisioning
COPY grafana/templates/finance_dashboard.template.json ./grafana-assets/template.json

# Bake the idempotent DB schema so sync.js can ensure tables exist on every run,
# making the stack self-contained even without a host db/init bind mount.
COPY db/init/001_schema.sql ./schema.sql

CMD ["node", "sync.js"]
