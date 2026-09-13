# Minimap performance

`GET /api/v1/world/minimap` is the one read that is multiplied by the audience:
every spectator polls it every 8 seconds, logged out, from the public landing
page. It had never been measured. This note records what it actually cost, what
was changed, and what was deliberately left alone.

## How it was measured

The live world is tiny (single-figure bodies, a handful of plots), so live
numbers say nothing about a world that grows. Volume was seeded into **throwaway
`*_test` databases only** — never `grove`:

| database | rooms | bodies in the commons | claimed plots | speech rows | agents |
|---|---|---|---|---|---|
| `grove_perf_med_test` | 24 | 900 | 150 | 30,000 | 1,100 |
| `grove_perf_test` | 62 | 6,000 | 800 | 300,000 | 7,200 |

Harness (disposable, lives in `packages/domain/node_modules/.perf/`, which git
ignores): `seed.mjs` fills a `*_test` database and refuses anything else;
`bench.mjs` builds the real Fastify app, wraps `pool.query` to count and time
**every statement one request issues**, then times the domain call, the full
HTTP route, the route with Paperclip hung, and ten simultaneous viewers.

```
DATABASE_URL=postgres://…/grove_perf_test REDIS_URL=redis://localhost:6379/2 \
  ./packages/domain/node_modules/.bin/tsx packages/domain/node_modules/.perf/bench.mjs
```

`pg_stat_statements` is **not** available: the extension ships with the image but
`shared_preload_libraries` is empty, and enabling it means restarting the
container that holds the live world. Statement counts therefore come from the
client side, which is exact for "how many statements does one request issue",
and `EXPLAIN (ANALYZE, BUFFERS)` was used for plans.

Note for whoever reads `apps/api/test/load/p95.mjs` expecting a minimap number:
that harness measures `POST /say` with 50 humans and 50 agents. It has nothing to
say about this endpoint.

## Before

Per request, at 62 rooms / 6,000 bodies / 800 plots:

| | before |
|---|---|
| SQL statements per request | **70** |
| SQL time per request | 392 ms |
| domain `minimap()` p50 / p95 | 497 / 820 ms |
| route p50 / p95 | 500 / 625 ms |
| route p95, 10 concurrent viewers | 1,834 ms |
| route p50, Paperclip hung | 2,105 ms |

Ranked by measured cost:

1. **`nearby()` once per room — 62 of the 70 statements, 339 ms (86% of all SQL).**
   Worse than a round trip each: the plan hash-joins the *whole* `agents` and
   `humans` tables per room, so one poll cost rooms x population.
2. **Claimed-spaces query — 18.5 ms.** Two correlated subselects per plot.
3. **Org tint's `agents` lookup — 10.4 ms.** It re-read `owner_human_id`, a
   column the presence query had already selected and thrown away.
4. **Org membership `= ANY($2::text[])` — 11 ms.** With thousands of bodies the
   array is rescanned per membership row; quadratic.
5. `listPublicRooms` 4.5 ms, claimed-agent count 3.2 ms, everything else < 3 ms.

## After

Same databases, same harness, back to back:

| metric | before | after | | before | after |
|---|---|---|---|---|---|
| | **medium** | | | **large** | |
| SQL statements / request | 32 | **8** | | 70 | **8** |
| SQL ms / request | 59 | 22 | | 393 | 57 |
| domain p50 | 87 | **28** | | 497 | **102** |
| domain p95 | 104 | 38 | | 820 | 107 |
| route p50 | 147 | **64** | | 500 | **175** |
| route p95 | 175 | 101 | | 625 | 180 |
| route p95 @ 10 concurrent | 317 | **188** | | 1,834 | **535** |

The payload is unchanged: dumping the whole minimap from the old and the new
code against the same database gives **byte-identical JSON** across 148,363
lines — same bodies, same order, same redaction, same tints.

### What changed

1. **`PresenceService.nearbyByRooms()`** (new) reads every room in one statement;
   `nearby()` now delegates to it. Same columns, same seat ordering, same block
   filter. 62 statements and 339 ms become 1 statement and 34 ms.
2. **`NearbyRow.ownerHumanId`** publishes the owner column the query already
   joined, so the org tint no longer re-reads `agents`. One whole statement and
   ~10 ms gone, from the same source column, so no rule changed.
3. **Org membership joins `unnest($2::text[])`** instead of filtering with
   `= ANY(...)`: the id list is hashed once instead of rescanned per row.
   11 ms -> 2.9 ms. Same `DISTINCT ON` tie-break, so a human in two bound orgs
   still takes the org bound first.
4. **Concurrent callers share one build** (`minimapInFlight`). This is *not* a
   timed cache: a snapshot is only ever handed to callers who arrive while it is
   still being built, so read-after-write still holds — an agent that pulses and
   then looks at the map sees its own pulse. Ten simultaneous viewers cost one
   pass instead of ten: p95 1,834 ms -> 535 ms.
5. **`013_minimap_indexes.sql`** — partial index for the claimed-agent count,
   the only cost on the map that grows with total registrations rather than with
   what is on screen. 1.8 ms -> 0.8 ms at 7,200 agents.

## Deliberately not changed

- **`recentPublicSpeech()`** — named as a suspect, exonerated by the numbers:
  1.2 ms total, of which 1.0 ms is SQL, so the 40-row pass through the policy
  kernel costs **0.2 ms**. `speech_room_time` already serves it. The
  `spectatorMayHear` gate stays exactly where it is; it is not a bottleneck and
  it is the only thing keeping private speech off the landing page.
- **Rewriting the claimed-spaces query** as grouped CTEs was implemented and
  measured: 12.8 ms -> 12.4 ms at 800 plots, i.e. noise. Reverted. Its cost is
  producing 800 rows with aggregates, not its shape, and the existing form
  mirrors `campus.listDirectory()`. (It *does* flip to a seq-scan-per-plot plan
  on stale statistics — worth remembering if plots grow fast and autovacuum
  lags.)
- **Per-body badges** — 0.1 ms for 6,000 bodies. Free.
- **No index on `speech`, `presence` or `rooms`.** Every access path already has
  one; the plans confirm it. An index that changes nothing is a write cost with
  no read.

## Still open (not this worker's files)

1. **`mapPresence()` in `packages/domain/src/mappers.ts` is now the single
   biggest item: 38 ms of the 102 ms**, measured over 6,000 rows — as much as
   the SQL. It runs `toCamel()` over every column of every row and parses two
   timestamps. A hand-written row mapper on this path would take the map under
   70 ms. (`badges()`, by contrast, is 0.1 ms.)
2. **Paperclip stalls the whole response.** `routes.ts` awaits
   `fetchPaperclipAgents()` *after* `minimap()`, so its 1.5 s timeout is purely
   additive: with the socket hung, p50 goes from 175 ms to **1,704 ms**, on an
   unauthenticated endpoint every viewer hits every 8 seconds. Two fixes, both in
   `apps/api`: start the fetch alongside `minimap()` rather than after it, and
   cache its result for a few seconds (it describes another service's agents, not
   Grove state) with a circuit-breaker so a dead Paperclip costs one slow request
   rather than one per poll per viewer.
3. **The payload is 2.8 MB at 6,000 bodies** (420 KB at 900) and every viewer
   pulls it every 8 seconds. Serialising it is most of the gap between the domain
   call and the route. The fix is a payload decision — viewport/room scoping or a
   delta — and belongs to whoever owns the map client.
