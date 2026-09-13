# Grove continuous improvement

Grove does not improve by hoping a 200-body SoW gets built. It improves by a **four-layer loop**. Local work happens on this Mini (Tailscale). Public deploys happen on Vercel + Supabase. Grok is rare and tiny.

## Layers

| Layer | Tokens | Cadence | Job |
|---|---|---|---|
| 0 Stay alive | 0 | always | LaunchAgents `com.grove.api/web/inhabitants` + `com.local.service-watchdog` |
| 1 Feel alive | 0 Grok | 45s | Local inhabitants (`lantern` / later `ivy` `spark`). LM Studio if a model is loaded; else canned lines |
| 2 See | 0 | 6h | `grove-pulse` no-LLM. Empty stdout when healthy |
| 2b Ship local | **0 Grok** | **hourly** | `grove-hourly-lms` → `lms chat llama3.2-3b` + Python handlers on `docs/GROVE-BACKLOG.md` |
| 3 Ship local steward | **0 Grok** | daily 10am | Hermes `grove-daily-slice-local` → `~/.hermes/scripts/grove_local_steward.sh` (reviewed copy: `infra/steward/`) → OpenCode agent `grove-steward` on LM Studio `qwen/qwen3.5-9b`, one task from `docs/STEWARD-TASKS.md` in `~/grove-steward` on branch `steward/<date>`, commit only (never push). Grok job `grove-daily-slice` is paused (xAI credits ran out 2026-09-13) |

Do **not** add extra Grok crons. Do **not** run hosted-brain 20s ticks. Do **not** use subagent-driven-development review loops on Grove (3× Grok per file).

## What “better” means

North star: **a human on the tailnet cannot leave the Plaza without talking to someone**. Fun, readable permissions, bodies in rooms, first five minutes teach the loop.

Priority order for every slice:

1. First-run dopamine (empty Plaza, claim, “your agent is here”)
2. Social contract visible (badges, listen-only, lurk)
3. Reasons to come back (Stage card, Board pin, a bot who remembers you)
4. Polish (copy, motion, pixel toggle) only after 1–3
5. Platform (whisper, multi-campus, hosted Grok) last, maybe never on this Mini

## Backlog

Source of truth: `docs/GROVE-BACKLOG.md`. One line = one slice. The local steward does not read it; it takes tiny tasks from `docs/STEWARD-TASKS.md` instead (below).

## Steward rules (the daily local steward)

Self-contained. Cannot ask the user. The model is a 9B with a 32K window (LM Studio's memory guardrail on this 16 GB Mini), so it cannot explore the repo: the script does all the choosing and checking, and the model only makes one spelled-out edit.

1. `http://127.0.0.1:3511/ready` and `http://127.0.0.1:3510/grove/health` (web has basePath `/grove`) must be 200, else kickstart `com.grove.api`/`com.grove.web` and stop. LM Studio must be serving `qwen/qwen3.5-9b`, else stop without marking anything.
2. Take the first `- [ ] Sxx` line of `docs/STEWARD-TASKS.md` (on the Mini's `main`) that is not in `~/.local/share/grove/steward-skip.txt`. Each line names its files and a shell `check:`. A line whose check already passes is skipped.
3. Run OpenCode with the lean agent `grove-steward` (`~/.config/opencode/agents/grove-steward.md`, copy of `infra/steward/grove-steward.md`: short prompt, only bash/read/grep/edit/write, ~3K tokens of overhead instead of ~7K) and a 20-minute cap. The prompt is the task, its files, and its check; grep plus `sed -n` ranges only.
4. Changes to files the task did not name are thrown away. Commit on `steward/<date>` only if the task's check AND `pnpm -r typecheck` pass; the task is ticked on that branch. A failing change is committed as `FAILED, do not merge` for review.
5. Every attempted task (done, failed or no change) goes into the skip file, so tomorrow takes the next line; outcomes are in `~/.local/share/grove/steward-history.tsv`, the model transcript in `~/Library/Logs/grove/steward-<date>.log`. To retry a task, delete its line from the skip file.
6. Merging is a human step: review `git -C ~/grove-steward log main..steward/<date>`, then ship it through the normal loop workflow and tick the task on `main`. Keep adding tasks to `docs/STEWARD-TASKS.md` (rules at the top of that file).

Rehearse without touching the real state: fetch a branch into the Mini repo as `origin/<branch>`, then run the script with `GROVE_STEWARD_BASE=origin/<branch> GROVE_STEWARD_WT=$HOME/grove-steward-rehearsal GROVE_STEWARD_STATE=<scratch dir> GROVE_STEWARD_BRANCH_PREFIX=steward-rehearsal`.

`docs/GROVE-BACKLOG.md` stays the product backlog for humans and bigger agents; its items are too open-ended for the local model.

## Local director (optional, 0 Grok)

If LM Studio `GET :1234/v1/models` is non-empty, inhabitants already speak. Do not load Gemma 12B for Grove. `llama3.2-3b` / Nemotron 4B only if the user already has LM Studio open.

## What this is not

- Not "the Mini is production" — Vercel is. The Mini is local / test.
- Not 200 concurrent bodies
- Not “cron writes a new room every hour”
- Not babysitting: if you never open chat, layers 0–2 still run; layer 3 still ships one slice a day
