FROM node:22-alpine
LABEL org.opencontainers.image.title="Investment Dashboard Sync"
LABEL org.opencontainers.image.description="Node.js sync service for a self-hosted investment portfolio dashboard using SnapTrade, Finnhub, PostgreSQL, and Grafana."
LABEL org.opencontainers.image.vendor="BusinessIQ-App"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "sync.js"]
