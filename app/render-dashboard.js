#!/usr/bin/env node
'use strict';

// Renders the Grafana dashboard from the committed template by substituting the
// __SYNC_PUBLIC_URL__ placeholder with SYNC_PUBLIC_URL from the environment.
// Used by the grafana-init container at startup (reads process.env, populated
// from .env-finance) so no host-side render step is required.
//
// Usage: node render-dashboard.js <template-path> <output-path>

const fs = require('fs');

const [, , templatePath, outputPath] = process.argv;

if (!templatePath || !outputPath) {
  console.error('Usage: node render-dashboard.js <template-path> <output-path>');
  process.exit(1);
}

let syncPublicUrl = (process.env.SYNC_PUBLIC_URL || '').trim();

if (!syncPublicUrl) {
  const syncHostPort = (process.env.SYNC_HOST_PORT || '8080').trim();
  syncPublicUrl = `http://localhost:${syncHostPort}/sync`;
}

const template = fs.readFileSync(templatePath, 'utf8');
const rendered = template.split('__SYNC_PUBLIC_URL__').join(syncPublicUrl);

// Validate JSON before writing so a broken template fails the init, not Grafana.
JSON.parse(rendered);

fs.writeFileSync(outputPath, rendered, 'utf8');

console.log(`Rendered ${outputPath}`);
console.log(`SYNC_PUBLIC_URL=${syncPublicUrl}`);
