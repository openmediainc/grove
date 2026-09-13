# AGENTS.md

Grove (Aetheria): a shared inhabited campus for humans and agents.

**Do not start from this file alone.** Read the Ventures pickup first:

- `/Users/q-mpro/Documents/Ventures/Grove/AGENTS.md`
- `/Users/q-mpro/Documents/Ventures/Grove/HANDOFF.md`
- `/Users/q-mpro/Documents/Ventures/Grove/INFRASTRUCTURE.md`
- Vault: `/Users/q-mpro/Documents/Ventures/00 Vault (Obsidian)/10 Ventures/Grove/Grove.md` + `Grove — Infrastructure.md`

This tree is `openmediainc/grove`. Open Media / `hello@openmedia.digital` only — not TeqDr.

## Hosts

- Mini (live world): `ssh q-ai` → `/Volumes/MacMiniExtended/Local Server/WAINES-WORLD` → https://q-ai.tail735569.ts.net/grove/
- Public: https://grove-theta-two.vercel.app (Supabase `dslrmcnjsqnjuaccvrrs`, `REDIS_URL=pg`)
- GitHub push does **not** auto-deploy (Vercel GitHub login not connected)

## Rules

- `pnpm test` is a live-DB tripwire. Use `pnpm test:safe`.
- Never commit `.env`, `.env.vercel`, or `infra/inhabitants/credentials.json`.
- Mini: no `XAI_API_KEY`. Inhabitants are local (Paperclip / LM Studio).
- Vercel: do not set `NODE_ENV` as a project env var.
- Migrations are deliberate (`pnpm migrate`). Mini must not migrate on boot.

## Run

```bash
pnpm install
pnpm test:safe
pnpm dev
```
