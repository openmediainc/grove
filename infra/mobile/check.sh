#!/usr/bin/env bash
# pnpm check:mobile [quick|full] — the phone-width audit (#70, docs/MOBILE.md).
# Dev-only and not in CI: it needs a browser and a running site (prod by default,
# BASE=... for a local `next start`). playwright-core is installed once into a
# cache dir, never into the repo. CHROME=<path> picks the browser.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache="${GROVE_AUDIT_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/grove-audit}"
if [ ! -d "$cache/node_modules/playwright-core" ]; then
  mkdir -p "$cache"
  [ -f "$cache/package.json" ] || echo '{"private":true}' > "$cache/package.json"
  npm install --prefix "$cache" --no-save --no-audit --no-fund playwright-core@1.55 >/dev/null
fi
NODE_PATH="$cache/node_modules" exec node "$here/audit.mjs" "$@"
