#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env-finance}"
TEMPLATE="grafana/templates/finance_dashboard.template.json"
OUTPUT="grafana/dashboards/finance_dashboard.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "Missing dashboard template: $TEMPLATE"
  exit 1
fi

python3 - "$ENV_FILE" "$TEMPLATE" "$OUTPUT" <<'PY'
import json
import sys
from pathlib import Path

env_path, template_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]

def read_env(path):
    env = {}

    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        # Remove simple surrounding quotes, but do not expand shell variables.
        if len(value) >= 2:
            if (value[0] == value[-1]) and value[0] in ("'", '"'):
                value = value[1:-1]

        env[key] = value

    return env

env = read_env(env_path)

sync_public_url = env.get("SYNC_PUBLIC_URL")

if not sync_public_url:
    sync_host_port = env.get("SYNC_HOST_PORT", "8080")
    sync_public_url = f"http://localhost:{sync_host_port}/sync"

text = Path(template_path).read_text(encoding="utf-8")
text = text.replace("__SYNC_PUBLIC_URL__", sync_public_url)

# Validate JSON before writing.
json.loads(text)

Path(output_path).write_text(text, encoding="utf-8")

print(f"Rendered {output_path}")
print(f"SYNC_PUBLIC_URL={sync_public_url}")
PY
