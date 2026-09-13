#!/bin/bash
# Grove daily steward, local model only (LM Studio qwen/qwen3.5-9b via OpenCode).
# Installed on the Mini at ~/.hermes/scripts/grove_local_steward.sh and run by the Hermes
# cron job grove-daily-slice-local (daily 10:00, no agent). This file is the reviewed copy:
# after changing it, copy it over (and infra/steward/grove-steward.md to
# ~/.config/opencode/agents/).
#
# One task per day from docs/STEWARD-TASKS.md (tiny, file-scoped, with a shell check).
# Works in its own worktree so the tree the Mini serves (WAINES-WORLD on main) is never
# switched or dirtied. Commits on a local steward/<date> branch only. Never pushes.
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
REPO="/Volumes/MacMiniExtended/Local Server/WAINES-WORLD"
WT="${GROVE_STEWARD_WT:-$HOME/grove-steward}"
BASE="${GROVE_STEWARD_BASE:-main}"   # rehearsal: another ref, e.g. a loop branch fetched into the repo
DAY="$(date +%F)"
LOG="$HOME/Library/Logs/grove/steward-$DAY.log"
STATE="${GROVE_STEWARD_STATE:-$HOME/.local/share/grove}"
SKIP="$STATE/steward-skip.txt"      # task lines already attempted (done or failed): never picked again
HISTORY="$STATE/steward-history.tsv" # date, task id, outcome, commit
TASKS="docs/STEWARD-TASKS.md"
AGENT="grove-steward"               # ~/.config/opencode/agents/grove-steward.md (lean prompt, few tools)
CAP="${GROVE_STEWARD_CAP:-1200}"    # seconds for the model run
mkdir -p "$STATE" "$(dirname "$LOG")"; touch "$SKIP" "$HISTORY"
say() { echo "grove steward: $*"; }
note() { printf '%s\t%s\t%s\t%s\n' "$DAY" "$1" "$2" "${3:-}" >> "$HISTORY"; }

# 1) Health of the Mini world (web has basePath /grove) and of the local model server.
if ! curl -fsS -m 5 http://127.0.0.1:3511/ready >/dev/null || ! curl -fsS -m 30 http://127.0.0.1:3510/grove/health >/dev/null; then
  launchctl kickstart -k "gui/$(id -u)/com.grove.api"
  launchctl kickstart -k "gui/$(id -u)/com.grove.web"
  say "api/web unhealthy, restarted them; no slice today."
  exit 0
fi
if ! curl -fsS -m 5 http://127.0.0.1:1234/v1/models | grep -q 'qwen/qwen3.5-9b'; then
  say "LM Studio is not serving qwen/qwen3.5-9b; no slice today (nothing marked as tried)."
  exit 0
fi

# 2) A clean worktree on a fresh branch off main.
git -C "$REPO" fetch -q origin main 2>/dev/null || true
if [ ! -d "$WT" ]; then
  git -C "$REPO" worktree add -q --detach "$WT" "$BASE" || { say "cannot create worktree (disk access?)"; exit 1; }
fi
cd "$WT" || { say "cannot enter $WT"; exit 1; }
[ -z "$(git status --porcelain)" ] || { say "worktree dirty from a previous run; leaving it for review."; exit 0; }
BR="${GROVE_STEWARD_BRANCH_PREFIX:-steward}/$DAY"
if git show-ref -q --verify "refs/heads/$BR"; then say "$BR already exists; one slice per day."; exit 0; fi
git checkout -q --detach "$BASE"
[ -f "$TASKS" ] || { say "no $TASKS on $BASE; nothing to do."; exit 0; }

# 3) The script picks the task and parses it, so the 32K-context model spends no tokens hunting.
ITEM="$(grep -E '^- \[ \] S[0-9]+ · ' "$TASKS" | grep -vxF -f "$SKIP" | head -1 || true)"
if [ -z "$ITEM" ]; then say "no untried task left in $TASKS; add more."; exit 0; fi
ID="$(printf '%s' "$ITEM" | sed -E 's/^- \[ \] (S[0-9]+) .*/\1/')"
WHAT="$(printf '%s' "$ITEM" | sed -E 's/^- \[ \] S[0-9]+ · //; s/ · files: .*//')"
FILES="$(printf '%s' "$ITEM" | sed -n 's/.* · files: \(.*\) · check: .*/\1/p')"
CHECK="$(printf '%s' "$ITEM" | sed -n 's/.* · check: `\(.*\)`$/\1/p')"
SUBJECT="$(printf '%s' "$WHAT" | sed -E 's/[.:] .*//' | cut -c1-72)"
if [ -z "$FILES" ] || [ -z "$CHECK" ]; then
  printf '%s\n' "$ITEM" >> "$SKIP"; note "$ID" malformed
  say "$ID is malformed (needs files: and check:); skipped."; exit 0
fi
if bash -c "$CHECK" >/dev/null 2>&1; then
  printf '%s\n' "$ITEM" >> "$SKIP"; note "$ID" already-true
  say "$ID already passes its check on $BASE; skipped (tick it in the repo)."; exit 0
fi

git checkout -q -B "$BR" "$BASE"
[ -f .env ] || cp -p "$REPO/.env" .env
pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1

PROMPT="Task $ID: $WHAT

Files you may change: $FILES
Do not change any other file.

How to work:
1. For an existing file: grep -n for the exact text named in the task, then read only about 20 lines around it with: sed -n 'A,Bp' <file>. Then make the edit with the edit tool.
2. For a new file: write the whole file in one go with the write tool. No reading needed.
3. Then run this check from the repo root: $CHECK
   It must exit 0. If it fails, read the error, fix your change, and run it again (at most 3 tries).
4. Do not run git, pnpm install, typecheck or any server. When the check passes, reply with one sentence and stop."

{ echo "=== $(date '+%F %T') $ID"; echo "files: $FILES"; echo "check: $CHECK"; } >>"$LOG"
START=$(date +%s)
OPENCODE_DISABLE_EXTERNAL_SKILLS=1 perl -e "alarm $CAP; exec @ARGV" \
  opencode run --agent "$AGENT" --title "steward $ID" "$PROMPT" >>"$LOG" 2>&1
RC=$?
echo "=== model exit rc=$RC after $(( $(date +%s) - START ))s" >>"$LOG"

# 4) Keep only the named files: anything else the model touched is thrown away.
IFS=',' read -r -a ALLOWED <<< "$FILES"
for i in "${!ALLOWED[@]}"; do ALLOWED[$i]="$(echo "${ALLOWED[$i]}" | sed 's/^ *//; s/ *$//')"; done
git status --porcelain --untracked-files=all | while IFS= read -r line; do
  path="${line:3}"; path="${path#\"}"; path="${path%\"}"
  keep=0; for a in "${ALLOWED[@]}"; do [ "$path" = "$a" ] && keep=1; done
  if [ $keep = 0 ]; then
    echo "discarding out-of-scope change: $path" >>"$LOG"
    if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then git checkout -q -- "$path"; else rm -f -- "$path"; fi
  fi
done

if [ -z "$(git status --porcelain)" ]; then
  git checkout -q --detach "$BASE"; git branch -q -D "$BR"
  printf '%s\n' "$ITEM" >> "$SKIP"; note "$ID" no-change
  say "$ID: model made no change (rc=$RC); marked as tried, tomorrow takes the next task. Log: $LOG"
  exit 0
fi

# 5) Commit only when the task's own check AND the typecheck pass. Tick the task on the branch
#    and remember it on the Mini (the branch is never merged automatically).
CHECK_OK=0; TYPES_OK=0
echo "=== check" >>"$LOG"; perl -e 'alarm 600; exec @ARGV' bash -c "$CHECK" >>"$LOG" 2>&1 && CHECK_OK=1
echo "=== typecheck" >>"$LOG"; perl -e 'alarm 900; exec @ARGV' pnpm -r typecheck >>"$LOG" 2>&1 && TYPES_OK=1
printf '%s\n' "$ITEM" >> "$SKIP"
if [ $CHECK_OK = 1 ] && [ $TYPES_OK = 1 ]; then
  ESC_ID="$ID"; perl -i -pe "s/^- \\[ \\] $ESC_ID · /- [x] $ESC_ID · /" "$TASKS"
  git add -A && git commit -q -m "steward($ID): $SUBJECT

Local daily steward, qwen3.5-9b via OpenCode. Check passed: $CHECK
Typecheck passed. Review, then merge."
  SHA="$(git rev-parse --short HEAD)"; note "$ID" committed "$SHA"
  say "$ID done: committed $SHA on $BR (check + typecheck pass), review then merge. $(git show --stat --format= HEAD | tail -1)"
else
  git add -A && git commit -q -m "steward($ID): FAILED (check=$CHECK_OK typecheck=$TYPES_OK), do not merge"
  SHA="$(git rev-parse --short HEAD)"; note "$ID" "failed check=$CHECK_OK typecheck=$TYPES_OK" "$SHA"
  say "$ID change on $BR FAILED (check=$CHECK_OK, typecheck=$TYPES_OK); kept at $SHA for review. Log: $LOG"
fi
git checkout -q --detach "$BASE"
