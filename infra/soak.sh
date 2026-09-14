#!/usr/bin/env bash
# Soak the suite: run it N times against its own throwaway database and report
# how often each test failed. A test that is not N/N is a defect until proven
# otherwise — every flake found in Grove so far has been a real bug.
#
#   pnpm test:soak                      # 20 full runs against soak_test
#   pnpm test:soak 50 civic-rooms       # 50 runs, vitest file filter
#   SOAK_DB=mine_test pnpm test:soak 30   # parallel soaks: give each its own SOAK_DB
#
# Redis: each run claims its own logical db through infra/test-db.sh, so two
# soaks from two worktrees cannot share rate-limit windows. SOAK_REDIS_URL pins
# one instead (no claim; only for a db you know is free).
#
# Extra args go to vitest in every package (with --passWithNoTests, so a filter
# that matches nothing in one package is not an error there).
# Logs: $SOAK_DIR (default: a fresh mktemp dir), one file per run, kept.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUNS="${1:-20}"
[ $# -gt 0 ] && shift
case "$RUNS" in ''|*[!0-9]*) echo "usage: soak.sh [runs] [vitest args...]" >&2; exit 2 ;; esac

# Never the shared default: a soak hammers its database, so it gets its own.
export GROVE_TEST_DB="${SOAK_DB:-soak_test}"
if [ -n "${SOAK_REDIS_URL:-}" ]; then export GROVE_TEST_REDIS_URL="$SOAK_REDIS_URL"; else unset GROVE_TEST_REDIS_URL; fi
DIR="${SOAK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/grove-soak.XXXXXX")}"
mkdir -p "$DIR"

# Extra args are for vitest. The `--` stops pnpm -r parsing them as its own
# flags; --passWithNoTests stops a filter that misses a package failing there.
# A full run passes nothing. sdk-py runs unittest, which rejects vitest flags,
# so test-db.sh leaves it out whenever it is handed arguments.
if [ $# -gt 0 ]; then set -- -- --passWithNoTests "$@"; fi

echo "soak: $RUNS runs, db=$GROVE_TEST_DB redis=${GROVE_TEST_REDIS_URL:-claimed per run} logs=$DIR"
red=0
for i in $(seq 1 "$RUNS"); do
  log="$DIR/run-$i.log"
  start=$(date +%s)
  if bash infra/test-db.sh "$@" >"$log" 2>&1; then status=ok; else status=RED; red=$((red + 1)); fi
  printf 'run %3d/%d  %-3s  %3ss\n' "$i" "$RUNS" "$status" "$(( $(date +%s) - start ))"
done

# Every "FAIL  <file> > <describe> > <test>" vitest prints, keyed with the pnpm
# package prefix (it disambiguates identical file names), plus the first line
# of the error, counted across runs.
echo
echo "== failures by test: $red/$RUNS runs red =="
for f in "$DIR"/run-*.log; do
  # vitest prints tests that died of the same error as consecutive FAIL lines
  # followed by that one error, so every name in the run gets the message.
  sed -E 's/\x1b\[[0-9;]*m//g' "$f" | awk '
    / FAIL  / { line=$0; sub(/ test: +FAIL +/, " :: ", line); sub(/^ *FAIL +/, "", line); names[++k]=line; next }
    k > 0 { msg=$0; sub(/^[^ ]+ test: */, "", msg); for (i = 1; i <= k; i++) print names[i] "\t" substr(msg, 1, 160); k=0 }'
done | awk -F'\t' '{ n[$1]++; err[$1]=$2 } END { for (k in n) printf "%4d\t%s\t%s\n", n[k], k, err[k] }' \
  | sort -t$'\t' -k1,1nr -k2 | awk -F'\t' '{ printf "%4d  %s\n        %s\n", $1, $2, $3 }'

# A red run with no FAIL line died outside a test (migrate, pnpm, a crash).
for f in "$DIR"/run-*.log; do
  if ! grep -q ' FAIL  ' "$f" && grep -qE 'ERR_PNPM|Unhandled|Error:' "$f"; then
    echo "  red with no FAIL line, read it: $f"
  fi
done
[ "$red" -eq 0 ] && echo "  none"
[ "$red" -eq 0 ]
