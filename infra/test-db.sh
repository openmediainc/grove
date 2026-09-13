#!/usr/bin/env bash
# Run the suite against a throwaway database, never the live world.
#
# apps/api integration tests import @grove/domain, which loads dotenv as a side
# effect — so DATABASE_URL is ALWAYS populated and the old "skip without a
# database" guard never fired. Every run wrote real humans, agents and worlds
# into the live Grove. The suite now refuses any database not ending in `_test`;
# this script supplies one, plus a separate Redis logical db so test sessions and
# rate limits cannot collide with live ones.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Swap only the last path segment (the database name), preserving any query string.
LIVE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
BASE="${LIVE_URL%%\?*}"
QS=""
[ "$BASE" != "$LIVE_URL" ] && QS="?${LIVE_URL#*\?}"
TEST_URL="${BASE%/*}/grove_test${QS}"
case "$TEST_URL" in
  */grove_test|*/grove_test\?*) ;;
  *) echo "refusing: derived URL does not name grove_test" >&2; exit 1 ;;
esac

docker exec -i infra-postgres-1 psql -U grove -d postgres \
  -c "SELECT 1 FROM pg_database WHERE datname='grove_test'" </dev/null | grep -q '1 row' \
  || docker exec -i infra-postgres-1 psql -U grove -d postgres \
       -c "CREATE DATABASE grove_test OWNER grove;" </dev/null

export DATABASE_URL="$TEST_URL"
export REDIS_URL="${GROVE_TEST_REDIS_URL:-redis://localhost:6379/1}"
pnpm migrate >/dev/null
exec pnpm -r --filter './packages/**' --filter @grove/api test "$@"
