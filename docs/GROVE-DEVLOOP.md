# Grove continuous improvement

Grove does not improve by hoping a 200-body SoW gets built. It improves by a **four-layer loop**. Local work happens on this Mini (Tailscale). Public deploys happen on Vercel + Supabase. Grok is rare and tiny.

## Layers

| Layer | Tokens | Cadence | Job |
|---|---|---|---|
| 0 Stay alive | 0 | always | LaunchAgents `com.grove.api/web/inhabitants` + `com.local.service-watchdog` |
| 1 Feel alive | 0 Grok | 45s | Local inhabitants (`lantern` / later `ivy` `spark`). LM Studio if a model is loaded; else canned lines |
| 2 See | 0 | 6h | `grove-pulse` no-LLM. Empty stdout when healthy |
| 2b Ship local | **0 Grok** | **hourly** | `grove-hourly-lms` → `lms chat llama3.2-3b` + Python handlers on `docs/GROVE-BACKLOG.md` |
| 3 Ship local steward | **0 Grok** | daily 10am | Hermes `grove-daily-slice-local` → `~/.hermes/scripts/grove_local_steward.sh` → OpenCode on LM Studio `qwen/qwen3.5-9b`, one backlog item in `~/grove-steward` on branch `steward/<date>`, commit only (never push). Grok job `grove-daily-slice` is paused (xAI credits ran out 2026-09-13) |

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

Source of truth: `docs/GROVE-BACKLOG.md`. One line = one slice. Steward always takes the first unchecked item that is still true.

## Steward rules (the daily local steward)

Self-contained. Cannot ask the user.

1. `curl -sS http://127.0.0.1:3510/grove/health` (web has basePath `/grove`) and `http://127.0.0.1:3511/ready` must be 200. If not, kickstart launchd wrappers under `~/.local/bin/grove-*.sh` and stop.
2. Read `docs/GROVE-BACKLOG.md`. Do the first `- [ ]` item only.
3. Touch the smallest files. No architecture rewrites. No `XAI_API_KEY`.
4. Verify with a curl or a page load. Check the box. One sentence in the daily delivery: what changed.
5. If it will not fit in this run, write a 5-line note under the item and stop. Do not start a second item.

## Local director (optional, 0 Grok)

If LM Studio `GET :1234/v1/models` is non-empty, inhabitants already speak. Do not load Gemma 12B for Grove. `llama3.2-3b` / Nemotron 4B only if the user already has LM Studio open.

## What this is not

- Not "the Mini is production" — Vercel is. The Mini is local / test.
- Not 200 concurrent bodies
- Not “cron writes a new room every hour”
- Not babysitting: if you never open chat, layers 0–2 still run; layer 3 still ships one slice a day
