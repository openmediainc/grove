# Mobile

Glasshouse on a phone: every page, drawer, sheet and menu at 390px and 360px wide,
checked by script (#70). Code: `app/globals.css` (the phone floors),
`components/KeyboardInset.tsx` + `lib/keyboard.ts` (the on-screen keyboard),
`test/keyboard.test.ts`, `infra/mobile/audit.mjs`. It keeps the accessibility
contract in `docs/ACCESSIBILITY.md` (#67) as it is: only sizes and positions
changed, no roles, names or focus behaviour.

## The rules

Below the `sm` breakpoint (640px), where a finger is the pointer:

| Rule | How it is kept |
|---|---|
| **Tap targets are at least 44×44** | A zero-specificity floor in `globals.css` gives every `button`, `summary`, `select`, text field, tab, menu item, option and checkbox/radio label `min-height: 44px` (buttons and tabs also `min-width`). A component's own bigger size still wins; `min-height` beats a smaller `h-*`. Links are not covered by the floor (a link in a sentence must stay a line of text), so a link that stands on its own carries `min-h-11 … sm:min-h-0`, the pattern the brand recipes already use; `buttonClass(…, "sm")` is now 44px on phones too. A control that sits inside a line of text (“only this”, a notice's “Sign in”) opts out with `tap-inline` and gets an invisible 44px hit area from `tap-hit` instead, which moves nothing |
| **Text fields are 16px** | Same block, `font-size: 16px !important` on text inputs, textareas and selects. Under 16px, iOS Safari zooms the whole page when a field takes focus |
| **No text under 12px** | The brand's mono label (`.gh-label`, 11px in DESIGN.md), the arbitrary `text-[9px]`/`[10px]`/`[11px]` sizes and the nameplate parts (`grove-kind`, `grove-you`, `grove-owner`, `grove-badge`) are 12px on phones. Desktop keeps its small labels |
| **The keyboard never covers the field you are typing in** | `KeyboardInset` publishes `--kb`, the height the keyboard takes from the bottom of the screen (`innerHeight − visualViewport.height − offsetTop`, ignoring under 80px of URL-bar settling). The room drawer, the only bottom sheet with a composer, sits on it: `bottom-[var(--kb,0px)]`, `h-[min(86%,100%−var(--kb))]`, so its header and close stay on screen too. A field in the page itself (sign-in, create a space) is scrolled back above the keys, with the room to scroll into added while the keyboard is up. `viewport.interactiveWidget = "resizes-content"` lets Chrome on Android shrink the layout instead, where `--kb` is then 0 |
| **Sheets stay under 90% of the screen and keep their close control on screen** | The drawers are `h-[86%]` of the map (which is the screen less the 56px nav), the peek card `max-h-[72svh]`, menus `max-h-[60svh]`, the palette `max-h-[80svh]`. The nav is exactly 56px on a phone now (it was 57, and 65 before the brand nav), so the map and every sheet on it end at the bottom of the screen |
| **Floating chrome never overlaps** | The headcount pill is as tall as the controls (44px) and stops short of the minimap button; an open minimap drops below the pill row, and the first-visit card waits (not dismissed) while it is open. In TV and kiosk, “Tap for sound” and “Leave TV” share the bottom row and the clock line sits above the bell |

## The audit

```
pnpm check:mobile                                    # prod, overflow + tap targets, exit 1 on a finding (~3.5 min)
pnpm check:mobile full                               # also text size, input zoom, sheets, overlaps, keyboard (~4.5 min)
BASE=http://127.0.0.1:3510/grove pnpm check:mobile   # a local `next start`
MOCK_ME=1 BASE=... pnpm check:mobile full            # plus the signed-in sheets (see below)
```

Not in CI: it needs a browser and a running site, and takes minutes.
`infra/mobile/check.sh` installs `playwright-core` once into `~/.cache/grove-audit`
(never into the repo) and uses Google Chrome if it is installed (`CHROME=<path>`
otherwise). `ONLY=<regex>` runs some states; `VIEWPORTS=390x844` one size.

Each state is loaded at 390×844 and 360×740 with touch and mobile emulation,
signed out, and walked top to bottom a screen at a time:

- `/` with the first-visit card, Go to ▾, Watch ▾, ⋯, the minimap opened, the ⋯
  Legend panel, Watch ▸ Record a shot, a peek card (a tap on the canvas), and the
  search palette;
- `/?room=plaza`, `/?history=1` (and its reaction picker), `/?tv=1`;
- `/explore`, `/s/aetheria-prime` (About and Activity tabs), `/a/hello/opencode`,
  `/u/hello`, `/how-it-works`, `/login`, and `/styleguide` once it exists (#72).

With `MOCK_ME=1` the browser answers `/api/v1/humans/me` and the Plaza's room read
itself (nothing reaches a server), so the walk-in sheet, the room drawer's composer
and both steps of Create space render too. Those are layout checks only.

| Check | Fails when |
|---|---|
| overflow | the document is wider than the screen; an element runs past either edge; or text or a control is cut off sideways by a container that was not built to scroll sideways |
| tap | an interactive element's **tappable** area is under 44×44: nine points of a 44px square centred on it must land on it (so `tap-hit` counts and a neighbour on top does not). A checkbox or radio is measured by its label. Links inside running text are exempt (WCAG 2.5.8) |
| text | visible text under 12px |
| zoom | a text field under 16px |
| sheet | a dialog taller than 90% of the screen, or its close control off screen |
| overlap | two pieces of floating chrome (a positioned button, panel, canvas or line of text over the map) on top of each other in the same layer. A menu or dialog over the controls is a layer above them and is not counted |
| keyboard | a text field, focused, is not between the top of the screen and the top of the keys once a keyboard of 40% of the height opens. It is emulated the iOS way: the layout keeps its height and only `visualViewport` shrinks and fires `resize` |

## Results (2026-09-14)

Both viewports, `full`, `MOCK_ME=1`. **Before:** https://glasshouse.rendrr.app, i.e.
`main` with the brand rollout (#72–#75) deployed. **After:** this change on the same
`main`, built locally against the prod API.

| Check | Before | After |
|---|---|---|
| overflow | 0 | 0 |
| tap | 253 | 0 |
| text | 74 | 0 |
| zoom | 14 | 0 |
| sheet | 0 | 0 |
| overlap | 8 | 0 |
| keyboard | 12 | 0 |

A first pass on `8238e74` (before the brand rollout) found the same kinds of thing:
315 tap, 67 text, 16 zoom, 9 overlap, 6 keyboard and one clipped control; the brand
rollout fixed many heights on its own, and this change was rebased onto it.

The findings behind the counts, grouped (one row per cause; most appeared in
several states and at both widths):

| Where | Finding (before) | Fix | After |
|---|---|---|---|
| Nav, every page | Lockup link 40px tall; the bar 57px, so the map (sized for 56px) ran 1px past the screen | Lockup `min-h-11`; bar padding only from `sm` | pass |
| Map controls | ⋯ 42px wide, attention bell 36px | Floor | pass |
| Map HUD | Headcount pill 11px; the first-visit card ran 6px under the minimap button; an open minimap covered the pill by up to 127×31 | Pill 12px, 44px tall, stops 3.5rem short of the corner while the minimap is shut; an open minimap drops below the pill row (`max-sm:pt-16`); the first-visit card waits while it is open | pass |
| Minimap | Hide × 32×32 | `h-11 w-11 sm:h-8 sm:w-8` | pass |
| Menus, panels, drawers | Mono labels (Go to, Watch, Rooms, Camera, Theme, Appearance, Legend, Room ·, What happened, First visit) at 11px | `.gh-label` 12px on phones | pass |
| Record a shot | Title input and duration select 40px and 12px (iOS zoom) | Floor, 16px fields | pass |
| Room drawer | Room tabs 28px, Open a table 36px; composer 14px; **the composer sat 290px under the keyboard** (789–833 with the keys at 506) | Floor; Open a table `min-h-11`; drawer lifts by `--kb` and shortens to fit | pass |
| History drawer and Activity | Window and filter chips 30–34px, “only this” 39×20, “Add a reaction” 19×24, picker emoji 26×20; kind tints at 10px | Floor; “only this” `tap-inline tap-hit`; reactions row `mt-3` on phones so the hit areas do not meet; the picker wraps to two rows of three on phones (at 44px each it would run 29px past the drawer at 360) | pass |
| TV (`?tv=1`) | “Tap for sound” and “Leave TV · Esc” under 44px; the clock line ran under Leave TV | Floor; Tap for sound on the bottom row beside Leave TV; the clock line above the bell, full width | pass |
| `/explore` and Create space | Shelf name link 24px, Online now row link 40px, Close, the error notice's “Sign in to continue.”; slug, URL, hours and accent fields 12–14px; **name and slug fields under the keyboard** | `min-h-11` / `py-2.5` on the links, `tap-hit` in the notice, floor and 16px fields; the page scrolls a focused field above the keys | pass |
| `/s/[slug]`, `/a/[...slug]`, `/u/[handle]` | “← Explore” 37px, About/Activity/Card tabs 42px, agent list links 20px, “agent”/“person” chips 9px | `min-h-11`; floor | pass |
| `/how-it-works` | On-this-page links 34px, “Style guide” 15px | Floor on the chips (page recipe), `min-h-11` on the footer link | pass |
| `/login` | “← Keep watching” 36px; **email field under the keyboard** | `min-h-11`; page scroll | pass |
| `/styleguide` | Section chips 31px, mode radios 36px, sample `sm` buttons 32px, labels 11px; sample fields under the keyboard | Chips `min-h-11`, radios `min-h-11 sm:min-h-9`, `buttonClass sm` 44px on phones, label floor, page scroll | pass |

## Not covered

- **Real devices.** The keyboard check emulates iOS Safari's visual viewport; it has
  not been run on a phone. Android relies on `interactive-widget=resizes-content`.
- **Signed-in pages beyond the mocked sheets**: `/me`, `/inbox`, `/mod`, Manage and
  Settings tabs, the pixel room, whisper, the board composer. They get the same
  floors (they are CSS, not per-page), but nothing walks them.
- The search palette opens at the top of the screen, so the keyboard cannot reach its
  input; its result list can run under the keys and scrolls.
- Desktop is untouched by design: every rule sits behind `max-width: 639px`, and the
  class changes restore their old values at `sm:`.
