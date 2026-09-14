# Performance budget (web)

The map at `/` is the first thing anyone sees, and a wall display keeps it open
all day. This note records what the web client costs, what #68 changed, and the
budget that stops it creeping back. The server side of the map's poll is in
[MINIMAP-PERF.md](MINIMAP-PERF.md).

## The budget

```
cd apps/web && VERCEL=1 npx next build   # or `pnpm build` (CI's shape)
pnpm perf:budget                          # check
pnpm perf:budget -- --record              # accept the current sizes as the new baseline
```

`apps/web/scripts/perf-budget.mjs` reads `.next/app-build-manifest.json`, takes
every JS file a route's page and the root layout load, gzips and sums them, and
compares with `apps/web/perf-budget.json`.

- **Fails** (exit 1) if `/` grows more than **10%** over the baseline.
- **Warns** for `/explore`, `/s/[slug]`, `/a/[slug]` and `/me`.
- CI runs it after the build (`.github/workflows/ci.yml`, job `build`).
- The number includes the root layout's chunks, so it is larger than Next's own
  "First Load JS" column. It is the same measure every time, which is the point.

Over budget? Split the new weight (below). If the growth is deliberate,
re-record and say why in the commit message.

## Lazy map themes (#79)

Only aoe (the default, and the fallback while another theme loads) ships with
the map now. space, city and scifi are separate chunks fetched through
`loadTheme` (lib/themes/registry) on a switch, on hover or focus of a switcher
row, for the owner default of a plot the camera is nearing, and by the Manage
and Create previews. Ids, names and blurbs stay synchronous in
`lib/themes/meta.ts`. How the map swaps without a frame of missing art:
`lib/themes/switch.ts` and docs/design/THEMES.md.

Measured on `6852065` (#74, before) and the #79 branch, `VERCEL=1 next build`,
Next's "First Load JS" with the budget script's page + layout gzip figure in
brackets:

| Route | Before | After | Change |
|---|---|---|---|
| `/` | 219 kB (233.5 KiB) | **207 kB** (221.2 KiB) | −12 kB, −5% |
| `/explore` | 159 kB (171.5 KiB) | 145 kB (158.5 KiB) | −14 kB, −8% |
| `/s/[slug]` | 163 kB (175.7 KiB) | 150 kB (162.7 KiB) | −13 kB, −8% |
| `/a/[slug]` | 169 kB (184.3 KiB) | 156 kB (171.2 KiB) | −13 kB, −8% |
| `/me` | 124 kB (177.6 KiB) | 125 kB (164.6 KiB) | −13 KiB with the layout (the themes left the root layout's chunks) |

Also `/u/[handle]` 148→135 kB. The three chunks that left first load are
~6.5–6.9 kB gz each (space, city, scifi), downloaded only when one is wanted.
The remaining theme weight on `/` is aoe itself plus `kit.ts` (the procedural
toolkit every theme shares), which the default needs anyway. The routes other
than `/` shrank as much because `Card`, `ResourceBar` and the Manage/Create
previews imported the full set too.

`perf-budget.json` was re-recorded after rebasing onto #75 (page routes on brand tokens, which landed alongside): `/` is 221.5 KiB (207 kB), `/explore` 158.8, `/s/[slug]` 162.6, `/a/[slug]` 171.0, `/me` 165.8 KiB.

## Before and after (#68)

### First-load JS per route

Next's "First Load JS" column from `VERCEL=1 next build`, with the budget
script's page + layout gzip figure in brackets.

| Route | Before | After | Change |
|---|---|---|---|
| `/` | 262 kB (264.2 KiB) | **208 kB** (222.5 KiB) | −54 kB, −21% |
| `/explore` | 181 kB (185.0 KiB) | 158 kB (162.5 KiB) | −23 kB, −13% |
| `/s/[slug]` | 196 kB (199.5 KiB) | 161 kB (165.9 KiB) | −35 kB, −18% |
| `/a/[slug]` | 190 kB (193.7 KiB) | 161 kB (168.2 KiB) | −29 kB, −15% |
| `/me` | 143 kB (181.2 KiB) | 124 kB (167.5 KiB) | −19 kB, −13% |

The recorded baseline in `perf-budget.json` was taken after rebasing onto
#60, #65, #67 and #72, which landed alongside #68 and added their own weight:
`/` is 213 kB (228.7 KiB) there.

Other routes shrank too, from the package change below: `/inbox` 142→125 kB,
`/login` 130→112 kB and `/mod` 140→122 kB.

**Largest things on `/` before:**
- the page chunk (85 kB gz): `WorldMap` itself, plus `RoomDrawer` (with
  `RoomTables`, `PixelRoom`, `FirstFiveMinutes`, `StageTrial`, `ReadAloud`),
  `SpectatorPeek`, `ReplayBar`, `HistoryDrawer`, `CinemaChrome`, the TV director
  and the sound engine;
- React/Next (100 kB, shared by every route);
- the four map themes (30 kB gz, `lib/themes/*`);
- the whole `@grove/protocol` + `@grove/ui` barrel (21 kB gz), chess engine
  included, on every route.

### Runtime

Measured on a production build of each commit (`next start` on the laptop,
proxied to the Mini's API, so both runs see the same live world). Headless
Chrome at 1440×900, Plaza view (`?at=11,8`), frame intervals over 20 s,
network over 60 s, signed out.

| | Before | After |
|---|---|---|
| Frame interval, default view (p50 / p95) | 33.1 / 34.5 ms | 33.0 / 34.6 ms |
| Frame interval, depth view on | 33.4 / 41.8 ms | 33.4 / 41.8 ms |
| Frame interval, TV mode | 25.4 / 33.7 ms | 25.0 / 33.4 ms |
| Polls, tab visible | 16 req/min, ~21 KB/min | 16 req/min, ~21 KB/min |
| Polls, tab hidden | **9 req/min, ~17 KB/min** | **0** |

- **Frame time did not move, and was not expected to.** Nothing in the draw loop
  changed. Headless Chrome draws in software and settles near 30 fps, so treat
  these as a regression baseline, not a real device's frame rate.
- **The visible poll mix is unchanged by design:**
  - minimap every 8 s;
  - the chronicle's injection flags every 4th minimap poll;
  - tables and the Stage trial every 20 s.
- **Hidden tabs** used to keep polling the minimap and chronicle. They now send
  nothing, and catch up with one request when shown again.

## What was split

### Map chrome (`components/WorldMapLazy.tsx`)

All `next/dynamic` with `ssr: false`. None of these is on the map's first paint.

| Piece | Loads when |
|---|---|
| Room drawer (#36 board, #42 tables and chess, pixel room, read aloud #44, whisper, trials) | a room opens; also warmed on idle |
| Peek card (card, Follow, Message) | a body or plot is clicked; also warmed on idle |
| History drawer (#28/#63) and its Activity list | `?history=1` |
| Replay scrubber and REPLAY pill | replay is actually on |
| Walk-in sheet | the walk-in is offered |
| Sequence recorder and letterbox (#39) | recording or playing a sequence |

**Other lazy loads on the map:**
- **TV director** (`lib/tv/director`): imported when TV is switched on. Before
  that, lines were handed to a director that TV threw away on entry anyway.
- **Sound engine** (#43): `lib/sound/lazy-soundscape.ts` stands in until sound is
  on. The synth is fetched as soon as sound is enabled, before the first tap, so
  the tap still starts audio inside the gesture. Until then every call is a
  no-op; the map samples nothing while sound is off anyway.
- **Chess** (#42): `lib/boards-map.ts` holds only what the map needs (the playing
  glyph and TV's game moments). `@grove/protocol`'s game names and end words
  moved to `board-words.ts`, which has no chess import, so the engine now ships
  only with the room drawer's board.

### Pages

- **`/s/[slug]`:** the board (lightbox and composer), the Activity tab and every
  Manage panel load on demand:
  - branding;
  - estate;
  - decor editor (#45);
  - default theme;
  - relocate and transfer.
- **`/a/[slug]`:** the owner's day view and Settings (with the permission tree).
- **`/explore`:** the create-space flow and its preview canvas (#48).

These pages already render after their own fetch, so they keep SSR (plain
`dynamic()`) and nothing visible arrives later than it did.

### Packages

`@grove/protocol` and `@grove/ui` are now `"sideEffects": false`. Neither has
import-time side effects: they are types, constants and pure functions. This
lets webpack skip the modules a route doesn't use instead of shipping the whole
barrel everywhere, which accounts for most of the gains on routes other than `/`.
The server (Node) ignores the field.

**If you add a module with a real import-time side effect to either package**
(registering something, patching a global), list it in `sideEffects` instead of
`false`.

## Poll hygiene (`lib/poll.ts`)

`startPoll(fn, ms)` is the one rule for timers that fetch:
- it doesn't run while the tab is hidden;
- on return it runs once if a tick was missed;
- each wait is jittered ±10%, so viewers who opened the same link don't land on
  the same second.

It's pinned by `test/poll.test.ts`.

**Now used by:**
- the map's minimap poll;
- the TV Stage poll;
- the resource bar;
- the agent page's day view;
- `/mod` Overview.

**Already paused when hidden, and left alone:**
- nav unread (`lib/unread`);
- the map's table and trial polls;
- the room drawer's polls.

**Decisions:**
- **The minimap poll does not back off while the SSE stream is open.** The
  stream carries Plaza pulses, tool calls and speech, but not positions.
  Movement comes only from the poll, so a slower poll would make bodies jump.
- **The SSE stream stays open while hidden.** It costs a connection, not
  queries, and keeps speech and pulse state warm for the return.
- **There is still one minimap poll, not a store.** HUD, headcount, minimap
  inset, sound and TV already read the same pull in `WorldMap`, so there was no
  double fetch to share. The agent page's day view is a different page.

## Not done (next candidates)

- **`WorldMap.tsx` itself:** most of the 66 kB page chunk. Splitting the draw
  loop is a refactor, not a boundary.
- **Frame time on real devices:** the numbers above are headless. A pass on a
  phone and on the Mini's wall display would say more.
