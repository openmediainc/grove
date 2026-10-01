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

## Base44 (sandbox dev environment)

- Compose: `docker compose -f docker-compose.base44.yml up -d`
- Preview: port 3000 (Next.js dev server, single-origin — API proxied via rewrites to `http://api:3511`)
- No external credentials required to boot. `XAI_API_KEY`, `RESEND_API_KEY`, `GROVE_SMTP_URL` are optional (AI brains and email delivery stay no-ops without them).
- `GROVE_NO_BASE_PATH=1` disables the `/grove` basePath so the preview serves at `/`.
- `allowedDevOrigins` in `apps/web/next.config.ts` includes the preview origin via `BASE44_PUBLIC_HOST_SUFFIX`.
- Migrations run as a one-shot compose service (`migrate`) before the API starts; `GROVE_MIGRATE_ON_BOOT` stays off.
- `pnpm install` runs as a one-shot compose service (`install`) before everything else; the pnpm store is shared via a named volume.
