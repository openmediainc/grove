#!/bin/bash
set -euo pipefail
ROOT="/Volumes/MacMiniExtended/Local Server/WAINES-WORLD"
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/q-mac}"
cd "$ROOT"
exec pnpm --filter @grove/web dev
