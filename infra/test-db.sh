#!/usr/bin/env bash
# Run the suite against a throwaway database, never the live world.
#
# apps/api integration tests import @grove/domain, which loads dotenv as a side
# effect — so DATABASE_URL is ALWAYS populated and the old "skip without a
# database" guard never fired. Every run wrote real humans, agents and worlds
# into the live Grove. The suite now refuses any database not ending in `_test`;
# this script supplies one, plus a separate Redis logical db so test sessions and
# rate limits cannot collide with live ones.
#
# PARALLEL RUNS (queue #71). Builders run the suite from several worktrees at
# once, each with its own GROVE_TEST_DB. A unique Postgres database is not
# enough: Redis holds sessions and rate-limit windows, and every run used to
# share logical db 1, so two runs refused each other with 429s. Now each run
# CLAIMS a Redis logical db of its own:
#
#   - start at a db derived from GROVE_TEST_DB (cksum → 3..15), probe upwards;
#   - claim = `SET grove:test-claim "<GROVE_TEST_DB> <pid> <epoch>" NX EX 6h`
#     in that db; a claim whose pid is no longer alive is taken over by an
#     atomic compare-and-set (a crashed run does not strand its db);
#   - the claim is released on exit, only if it is still ours;
#   - all 13 busy: wait (up to 30 min), never share.
#
#   db 0      live (never touched)
#   db 1      legacy shared default and CI (.github/workflows/ci.yml)
#   db 2      legacy `pnpm test:soak` default on older branches
#   db 3..15  claimed per run by this script
#
# GROVE_TEST_REDIS_URL still overrides everything (no claim is taken): use it
# only for a db you know nobody else is using. Within one run, test FILES share
# the claimed db and stay apart by owning their own client address and limiter
# keys (`testClient()` in packages/domain/test/support/fixtures.ts).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Swap only the last path segment (the database name), preserving any query string.
LIVE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
BASE="${LIVE_URL%%\?*}"
QS=""
[ "$BASE" != "$LIVE_URL" ] && QS="?${LIVE_URL#*\?}"
# GROVE_TEST_DB lets parallel worktrees each own a database (must end in _test).
TEST_DB="${GROVE_TEST_DB:-grove_test}"
case "$TEST_DB" in *_test) ;; *) echo "refusing: GROVE_TEST_DB must end in _test" >&2; exit 1 ;; esac
TEST_URL="${BASE%/*}/${TEST_DB}${QS}"
case "$TEST_URL" in
  */"$TEST_DB"|*/"$TEST_DB"\?*) ;;
  *) echo "refusing: derived URL does not name $TEST_DB" >&2; exit 1 ;;
esac

db_exists() {
  docker exec -i infra-postgres-1 psql -U grove -d postgres -Atc \
    "SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'" </dev/null | grep -qx 1
}
# Two runs racing to create the same database: the loser's CREATE fails with
# "already exists", which is success for our purposes — so re-check, don't die.
db_exists || docker exec -i infra-postgres-1 psql -U grove -d postgres \
  -c "CREATE DATABASE ${TEST_DB} OWNER grove;" </dev/null >/dev/null 2>&1 || db_exists \
  || { echo "could not create ${TEST_DB}" >&2; exit 1; }

CLAIM_KEY="grove:test-claim"
CLAIM_TTL=21600
CLAIM_DB=""
CLAIM_VALUE=""
rcli() { docker exec -i infra-redis-1 redis-cli -n "$1" "${@:2}" </dev/null; }

# Claim one Redis logical db in 3..15 for this run. Prints nothing; sets CLAIM_DB.
claim_redis_db() {
  local me="$TEST_DB $$ $(date +%s)" start i db got cur pid waited=0
  start=$(( $(printf '%s' "$TEST_DB" | cksum | cut -d' ' -f1) % 13 ))
  while :; do
    for i in $(seq 0 12); do
      db=$(( 3 + (start + i) % 13 ))
      got="$(rcli "$db" SET "$CLAIM_KEY" "$me" NX EX "$CLAIM_TTL")" || return 1
      if [ "$got" != "OK" ]; then
        cur="$(rcli "$db" GET "$CLAIM_KEY")" || return 1
        pid="$(printf '%s' "$cur" | awk '{print $2}')"
        # Taken by a run that is gone: take it over, atomically, only if unchanged.
        if [ -n "$cur" ] && [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; then
          got="$(rcli "$db" EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 'OK' end return ''" 1 "$CLAIM_KEY" "$cur" "$me" "$CLAIM_TTL")" || return 1
        elif [ -z "$cur" ]; then
          continue # expired between SET and GET; the next pass retries it
        fi
      fi
      if [ "$got" = "OK" ]; then CLAIM_DB="$db"; CLAIM_VALUE="$me"; return 0; fi
    done
    [ "$waited" -eq 0 ] && echo "test-db: all Redis test dbs (3..15) are claimed; waiting" >&2
    waited=$((waited + 10))
    [ "$waited" -ge 1800 ] && { echo "refusing: no free Redis test db after 30 min" >&2; return 1; }
    sleep 10
  done
}

release_redis_db() {
  [ -n "$CLAIM_DB" ] || return 0
  rcli "$CLAIM_DB" EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0" \
    1 "$CLAIM_KEY" "$CLAIM_VALUE" >/dev/null 2>&1 || true
}

if [ -n "${GROVE_TEST_REDIS_URL:-}" ]; then
  export REDIS_URL="$GROVE_TEST_REDIS_URL"
else
  claim_redis_db || { echo "refusing: could not claim a Redis test db (is infra-redis-1 up?)" >&2; exit 1; }
  trap release_redis_db EXIT
  export REDIS_URL="redis://localhost:6379/${CLAIM_DB}"
fi
echo "test-db: postgres=${TEST_DB} redis=${REDIS_URL##*/} (db index)" >&2

export DATABASE_URL="$TEST_URL"
pnpm migrate >/dev/null
# Extra args are vitest's (a file filter, --passWithNoTests). The two packages
# whose `test` is not vitest (sdk-py: python unittest; ui: a node no-op) reject
# them, so they sit out a filtered run. apps/web's tests run too.
# Not `exec`: this shell has to outlive the suite to release its Redis claim.
if [ $# -gt 0 ]; then
  pnpm -r --filter './packages/**' --filter @grove/api --filter @grove/web \
    --filter '!@grove/sdk-py' --filter '!@grove/ui' test "$@"
  exit $?
fi
pnpm -r --filter './packages/**' --filter @grove/api --filter @grove/web test
