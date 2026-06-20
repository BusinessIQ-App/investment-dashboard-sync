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

CMD ["node", "sync.js"]
