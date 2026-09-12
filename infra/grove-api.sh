#!/bin/bash
set -euo pipefail
ROOT="/Volumes/MacMiniExtended/Local Server/WAINES-WORLD"
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/q-mac}"
cd "$ROOT"
docker compose -f infra/docker-compose.yml up -d
# wait for postgres
for i in $(seq 1 30); do
  if docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U grove -d grove >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
exec pnpm --filter @grove/api start
