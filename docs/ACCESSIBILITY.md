# Accessibility

Glasshouse is a world you watch, so it has to be watchable without a mouse and
without sight of the canvas. This is the contract from the accessibility pass
(#67). Code: `apps/web/lib/a11y.ts` (pure helpers), `apps/web/components/a11y.tsx`
(focus and keyboard hooks), `apps/web/test/a11y.test.ts`, `infra/a11y/audit.mjs`.

## Patterns, by surface

| Surface | Pattern | Keys |
|---|---|---|
| Every page | Skip link, then the nav (`<nav aria-label="Sections">`) | First Tab is **Skip to content**; it focuses the page's `<main>` |
| Map menus: Go to ▾, Watch ▾, ⋯ (`MapMenu`), the You menu (`Nav`) | APG menu button: `aria-haspopup="menu"`, `aria-expanded`, `aria-controls`; items are `menuitem` / `menuitemcheckbox` / `menuitemradio` with a roving tabindex | Enter, Space or ArrowDown opens with focus on the first item. Up/Down, Home/End and a typed letter move. Escape or a pick closes and focus returns to the button. Tab leaves and closes. While focus is in a menu, letters are typeahead, never map shortcuts |
| Theme (in ⋯) | `menuitemradio` rows in a group; the checked theme is `aria-checked` | Arrows with the rest of the menu; T still cycles on the map |
| Reactions "+" | Horizontal `menu` (`aria-orientation="horizontal"`) | Left/Right, Escape closes |
| Room drawer, History drawer, peek card, walk-in sheet, keyboard/legend panel | `role="dialog"`, `aria-modal="false"`, labelled by the title. **Not modal**: they sit over a live map, so Tab walks out to the map controls and back; no focus trap | Focus moves into the dialog only when it was opened from a control (a deep link or a click on the canvas leaves focus alone). Closing returns focus to the control, or to the menu button when the control was a menu item that is gone. Escape closes: the map's own handler for the room/History drawers, the dialog itself for the peek, walk-in and panels |
| Search palette (`/`) | Modal dialog with a focus trap. The input is a `combobox` that owns a `listbox` of `option`s in labelled `group`s, `aria-activedescendant` for the active option | Up/Down, Home/End; Enter shows a card, Enter again opens; **Shift+Enter** follows on the map (the Jump button is a mouse shortcut). A result's card (Follow, Open) renders below the list and is reached with Tab. Escape closes the card, then the palette |
| Board image lightbox | Modal dialog with a focus trap | Escape closes; focus returns to the thumbnail |
| Tabs on `/a/[slug]` and `/s/[slug]` | APG tabs, automatic activation: `tablist` / `tab` (ids, `aria-controls`) / one `tabpanel` labelled by the selected tab (`tabPanelProps`) | The selected tab is the one Tab stop; Left/Right, Home/End move and choose |
| The map canvas | `role="img"`, named, `aria-describedby` a hidden description of what it shows and the keys; everything said on the map is in the hidden `role="log"` ("Heard on the map") | Map keys (see ⋯ Keyboard help) never fire from an input, textarea or select |
| Map controls | Icon-only buttons carry names: More (⋯), Zoom in/out, Show/Hide minimap, the attention bell (its counts and position are in the name), follow heart, reactions, Mute all sound (`aria-pressed`, constant name) | |

## Focus

`:focus-visible` gets a 2px outline in `--g-lantern-400` (the theme's token; aoe
value as fallback) with a 2px offset, in the base layer so a component's own focus
style still wins. Inputs that remove the outline show a full-strength lantern
border or ring instead. Programmatic focus targets (a dialog container, `<main>`)
show no ring. When a brand focus token lands (#72 `--gh-focus`), point the one
rule in `app/globals.css` at it; nothing else hard-codes a focus colour.

## Contrast

`chromeContrast()` checks, for each of the four themes (`aoe`, `space`, `city`,
`scifi`), and the web test fails if any pair falls short:

- lantern-300/400/500 text on dusk-950/900/800: ≥ 4.5:1;
- dusk-950 text on a lantern-400 button: ≥ 4.5:1;
- the focus ring (lantern-400) on dusk-950/900/800/700: ≥ 3:1;
- the muted-text floor, white at 50%, on dusk-950 and dusk-800: ≥ 4.5:1.

All the tokens already passed, so no palette token changed. What failed was faint
text: `text-white/25…/45` measured 2.5–4.5:1 on the darkest chrome. Those were
raised to `/50` (from 25–35) and `/55` (from 40–45), and `text-lantern-400/50…60`
and `text-lantern-300/60` to `/70`. The test scans `app/` and `components/` and
fails on any `text-white/N` below 50 (disabled states excepted). Hazard, stall,
verb and table-mark colours are semantic and were not touched; the test also pins
that the focus ring is never a hazard colour.

## Motion

Pulses use `motion-safe:animate-pulse` (the bell, live-room dots, the trial dot).
The nav lantern's glow stops under `prefers-reduced-motion`. The map's own motion
(depth view, day/night, camera glides) follows MOTION.md, which already honours
reduced motion.

## Running the audit

Not in CI (it needs a browser and a live deploy, and takes about two minutes).

```
cd "$(mktemp -d)" && npm i --no-save playwright-core axe-core
NODE_PATH="$PWD/node_modules" node <repo>/infra/a11y/audit.mjs          # prod: axe + keyboard checks
BASE=https://q-ai.tail735569.ts.net/grove NODE_PATH=... node <repo>/infra/a11y/audit.mjs axe
```

`CHROME=<path>` picks the browser. `axe` runs axe-core (WCAG 2.0/2.1 A and AA plus
best-practice) on `/`, `/?room=plaza`, `/?history=1`, `/explore`, `/s/aetheria-prime`,
`/how-it-works`, `/login`, `/u/hello` and `/a/hello/opencode`, and on `/` again with
each menu and the palette open. `keys` scripts the checks in the table above and
exits 1 on a failure.

### Results (2026-09-14, signed out)

| | axe nodes | Notes |
|---|---|---|
| Before (prod, `2be9443`) | 6 | palette: listbox holding headings, options holding buttons, unnamed listbox (4); ⋯ menu holding a select and a range (1); `/a` heading order (1) |
| After (this change, local build against the prod API) | 1 | the ⋯ menu's volume slider (below). Keyboard checks: all pass |

### Known exceptions

- **Volume slider inside ⋯** (axe `aria-required-children`): a range input is not a
  menu item. It is reached with Tab inside the open menu and keeps its own arrows.
  Kept, rather than splitting sound settings out of the menu.
- **Signed-in-only surfaces were not audited by script**: the room drawer's composer,
  whisper and pixel room, reactions on lines, `/me`, `/inbox`, `/mod`, Manage and
  Settings tabs. They use the same components (dialogs, menus, tabs, focus rule, text
  floor); the owner-only AgentDay still has h3s under the page h1.
- The canvas map itself is not navigable body by body with a keyboard; the text
  carriers are the log, search (with Shift+Enter to follow) and the attention bell.
