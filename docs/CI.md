# CI

Grove's tests used to be enforced by nothing: a green tree depended on somebody
remembering to run `pnpm test:safe` before they pushed. `.github/workflows/ci.yml`
is that memory, made automatic. It runs on every push and every pull request.

## What runs

Three jobs, all on `ubuntu-latest`, all independent so a failure points at itself.

| Job | What it proves | Services |
| --- | --- | --- |
| `test (postgres + redis)` | The whole suite — 301 vitest tests (protocol 9, sdk-js 4, policy 137, domain 110, api 41) plus `packages/sdk-py`'s unittest — against a real Postgres 16 and a real Redis 7 | `postgres:16-alpine`, `redis:7-alpine` |
| `typecheck` | `pnpm -r --if-present typecheck` — every package twice (`tsconfig.json` and `tsconfig.test.json`), plus `apps/web` | none |
| `build` | `pnpm build` — `tsc --noEmit` for `apps/api` and `apps/mcp`, a real `next build` for `apps/web` | none |

The `test` job's steps, in order: install (`--frozen-lockfile`), assert the
database name, `pnpm migrate`, then the suite.

## How CI gets a `*_test` database, with no `.env`

The suite **refuses any database whose name does not end in `_test`**
(`packages/domain/test/support/fixtures.ts`). That guard is deliberate and
load-bearing. `packages/domain/src/config.ts` loads `.env` as a side effect of
being imported, so `DATABASE_URL` is *always* populated — the old
"skip if there is no database" check never fired, and the integration suite wrote
real humans, agents and worlds into the live Grove. **Do not weaken, bypass or
special-case that guard.** Give it a correctly named database instead.

CI does exactly that, and needs no `.env` to do it:

- the Postgres service container is started with `POSTGRES_DB: grove_test`, so
  the only database on the runner is already a throwaway with a legal name;
- `DATABASE_URL` and `REDIS_URL` are set as job `env`, which is the whole of the
  configuration the suite needs — everything else in `packages/domain/src/config.ts`
  falls back to a safe default;
- `REDIS_URL` uses logical db 1, matching `infra/test-db.sh`, so test sessions
  and rate limits never share a keyspace;
- a step asserts the database name ends in `_test` **before** the suite runs, so
  a mistyped url fails the build instead of silently skipping every
  database-backed test and reporting a green run that proved nothing. A second
  check greps the suite output for the guard's own `[grove] … SKIPPED` marker.

`infra/test-db.sh` is the **local** path and cannot run in CI as written: it
reads the live url out of `.env`, and it creates the database with
`docker exec … infra-postgres-1`, a container that only exists on the Mini.
Neither has an equivalent on a runner. CI therefore runs the same inner command
the script ends with — `pnpm -r --filter './packages/**' --filter @grove/api test`
— with the environment supplied directly. **The script was not edited to suit
CI.** If you change its final command, change the `Run the suite` step to match.

`pnpm test` is deliberately wired to fail with a pointer to `pnpm test:safe`.
CI never calls it. Do not "fix" it.

## Reproducing a CI failure locally

Normally, just:

```bash
pnpm test:safe        # creates/uses grove_test in the local Docker Postgres
pnpm -r --if-present typecheck
pnpm build
```

To reproduce CI *exactly* — no `.env`, environment variables only, which is the
difference that usually explains "passes locally, fails in CI":

```bash
export DATABASE_URL=postgres://grove:grove@localhost:5432/grove_test
export REDIS_URL=redis://localhost:6379/1
export GROVE_MAGIC_LINK_STDOUT=1
export GROVE_WEB_ORIGIN=http://localhost:3000
export GROVE_PUBLIC_URL=http://localhost:3000

docker compose -f infra/docker-compose.yml up -d          # if not already up
pnpm install --frozen-lockfile
pnpm migrate
pnpm -r --filter './packages/**' --filter @grove/api test  # the suite CI runs
pnpm -r --if-present typecheck
pnpm build
```

Because a repo-root `.env` exists on the Mini and `config.ts` only fills in
variables that are *unset*, exporting these first is enough — the exports win.

If a database-backed test "passes" suspiciously fast, look for
`[grove] … SKIPPED` in the output: it means `DATABASE_URL` did not name a
`_test` database and the suite quietly did nothing.

Known intermittent: `packages/domain/test/space-access.test.ts` >
"allocates every claimed space a distinct plot" has been seen to fail once with
`GroveError: That campus slug is taken.` and pass on the next two runs against
the same database. If CI goes red on only that test, it is a flaky slug
allocation, not your change — but it is a real bug in the test, not something to
paper over with a retry.

## Runners: `ubuntu-latest`, always

**Never write `runs-on: self-hosted` in this repo.**

Self-hosted runners were removed from this owner's estate. A job that requests
one does not fail — GitHub queues it, waiting for a runner that will never
appear. It sits pending indefinitely and **never goes red**, so the gate looks
like it is still there while enforcing nothing. That is strictly worse than
having no CI at all, because people trust it.

Everything CI needs is in the repo or in a service container. CI must not reach
the Mac Mini, its Tailscale network, or any live service: no deploy step, no
`XAI_API_KEY`, no `RESEND_API_KEY`, no SMTP, no production `DATABASE_URL`.

## Speed

`pnpm/action-setup@v4` runs before `actions/setup-node@v4` so that
`cache: pnpm` can find the store and cache it across runs; the pnpm version
comes from the root `package.json` `"packageManager"` field and the Node version
from `.nvmrc`, so neither is pinned twice. Jobs run in parallel and
`concurrency` cancels superseded runs on the same ref. CI people route around is
CI that does not gate anything.
