# DESIGN.md — the Glasshouse brand

The brand for the chrome around the world. Settled in DECISIONS #7 ("B + C": Clear Pane by day,
Nightwatch by night and on TV). This file is the rulebook; the source of truth for values is
`packages/ui/tokens/values.ts`, and `/styleguide` shows every token and component in every mode.

- Tokens: `packages/ui/tokens/` (`values.ts` → generated `tokens.css`, Tailwind mapping in `tailwind.ts`)
- Recipes: `apps/web/lib/brand-ui.ts` (buttons, inputs, tabs, chips, cards, menus, notices)
- Mark: `packages/ui/tokens/mark.ts` → `apps/web/public/brand/*.svg`, `public/favicon.svg`, `public/icons/*.png`
- Live guide: `/styleguide` (linked, small, from the `/how-it-works` footer; not in the nav)

## 1. Principles

1. **The map is the hero.** Chrome recedes. Panels over the world are panes of glass (frost),
   never opaque slabs over the work.
2. **One signal.** `#E2542B` marks activity and the one primary action in a view. If two things are
   signal-coloured, one of them is wrong.
3. **Transparency is literal.** Say what is happening, who is doing it and who can see it. No
   decorative mystery, no hidden state behind a hover.
4. **People vs agents at a glance.** Amber is a person, cyan is an agent. Always with the name
   beside it; colour is never the only signal.
5. **Access reads by word and shape.** Open · Watch only · Private keep their words, building forms
   and the lock glyph. Colour is a second signal.
6. **Precise, calm, legible at 390px and on a wall.** A well-made instrument, not a game HUD.

## 2. The boundary: brand vs map theme

| Layer | Styled by | Examples |
|---|---|---|
| **Chrome** | brand tokens (`--gh-*`) | nav, the room drawer's frame and tabs, menus, cards, pages, HUD pills, toasts, emails, docs |
| **World** | map theme (aoe · space · city · scifi, `THEMES.md`) | map canvas, the pixel room inside the drawer, board pieces, speech bubbles, signboards, decor |
| **Semantics** | fixed, never themed | hazard flag / fault / stall (`HAZARD_COLOUR`, `STALL_RING`), verb glyphs, outcome marks |

- Brand tokens never paint world art; map themes never re-skin chrome (this refines DECISIONS #3).
- `--gh-danger` **is** the fixed fault colour `#f87171` in every mode (a web test pins it to
  `HAZARD_COLOUR.fault`). It is not a theme token and a mode may not change it.
- On the map, people vs agents is at most a small theme-invariant identity tick; it never replaces a
  verb or hazard mark.
- Legacy `dusk-*` / `lantern-*` Tailwind names still resolve exactly as before (map themes set
  `--g-*`) until rollout rows #73–#75 move each usage (see §11).

## 3. Colour

Roles, not colour names. Use the role that says what the thing **is**.

| Role | Tailwind | Use |
|---|---|---|
| `ground` | `bg-ground` | page background |
| `surface` | `bg-surface` | sections, sheets |
| `surface-raised` | `bg-surface-raised` | cards, menus, inputs |
| `tint` | `bg-tint` | hover, selected, quiet fill (Clear Pane "frost" #DCE6EE by day) |
| `frost` / `frost-blur` | `.gh-frost` | panels over the map; `frost` is the denser no-blur fallback, `frost-blur` applies only under `@supports (backdrop-filter)` |
| `ink` | `text-ink` | body text, icons |
| `muted` | `text-muted` | secondary text |
| `line` | `border-line` | decorative dividers (not a control boundary) |
| `line-strong` | `border-line-strong` | input and control borders (3:1) |
| `signal` | `bg-signal` | activity marks, the primary action |
| `signal-ink` | `text-signal-ink` | text on signal |
| `signal-text` | `text-signal-text` | signal as text (unread counts); signal itself fails 4.5:1 by day |
| `sky` | `text-pane` / `bg-pane` | secondary accent (Tailwind name `pane`, because `sky-*` is still Tailwind's palette in use) |
| `human` | `text-human` | people: identity chips, nameplate accents, presence counts |
| `agent` | `text-agent` | agents: same places |
| `focus` | `shadow-gh-ring` | focus ring |
| `danger` | `bg-danger` | the fixed fault mark (night/tv chrome only as a stand-alone mark) |
| `danger-ink` | `text-danger-ink` | error text and error borders in every mode |
| `success` | `text-success` | done, saved |

Values per mode (hex). Day = Clear Pane; night = Nightwatch; tv = night, darker ground, brighter ink,
muted, lines and accents, and type ×1.25.

| Role | Light | Night | TV |
|---|---|---|---|
| ground | #F3F6F8 | #0A0B14 | #05060D |
| surface | #FBFCFD | #12142A | #0E1022 |
| surface-raised | #FFFFFF | #1B1E3A | #171A33 |
| tint | #DCE6EE | #232748 | #20244A |
| frost | rgb(246 249 251 / .94) | rgb(16 18 31 / .94) | rgb(10 11 22 / .96) |
| frost-blur | rgb(246 249 251 / .8) | rgb(16 18 31 / .8) | rgb(10 11 22 / .86) |
| ink | #0E1B2B | #E4E2F0 | #F4F3FA |
| muted | #4A5A6C | #A9A6C0 | #C4C1DA |
| line | #C9D4DD | #2A2E52 | #3A3F6A |
| line-strong | #6E7D8C | #7A7EA8 | #8A8EB8 |
| signal | #E2542B | #E2542B | #E2542B |
| signal-ink | #0E1B2B | #0A0B14 | #05060D |
| signal-text | #A8380F | #F2794F | #F58A64 |
| sky | #3E7CB1 | #B7A6F2 | #C9BCFA |
| human | #8A5200 | #F4B860 | #F7C77E |
| agent | #0A6680 | #7FD1E8 | #96DCEE |
| focus | #3E7CB1 | #B7A6F2 | #D6CCFF |
| danger | #f87171 | #f87171 | #f87171 |
| danger-ink | #B42318 | #f87171 | #FA8C8C |
| success | #1A6B43 | #6FD3A0 | #86DDB0 |

**Day-safe amber and cyan.** Nightwatch's amber `#F4B860` and cyan `#7FD1E8` are 1.6–1.8:1 on
daylight, so day mode uses the same hues darkened to `#8A5200` and `#0A6680`. Both clear 4.5:1 on
every day surface, so a chip may use them as text, not only as a tick.

**Primary button label.** White on signal is 3.79:1 (fails AA text), so the label is ink
(`signal-ink`), 4.57:1 by day, 5.17:1 by night.

### Contrast

Every pair the chrome may use, worst case. Text needs **4.5:1**, marks and control borders **3:1**.
Translucent `frost` is composited over both pure black and pure white (the map under it can be either)
and the lower ratio is shown. `packages/ui/test/tokens-contrast.test.ts` fails the build if any pair
drops below its minimum, and this table is regenerated from the same code (a test keeps it current).
If a pair you need isn't listed, add it to `CONTRAST_PAIRS` and make it pass before using it.

`danger` (the fixed fault colour) is 2.55:1 on daylight, so by day it is never a stand-alone mark:
notices use `danger-ink` for text and border, and hazard triangles carry their own dark keyline.

<!-- CONTRAST:START (generated by contrastTableMarkdown) -->
| Pair | Kind | Min | Light | Night | TV |
|---|---|---|---|---|---|
| ink text on ground | text | 4.5 | 15.99 | 15.35 | 18.34 |
| ink text on surface | text | 4.5 | 16.89 | 14.18 | 17.07 |
| ink text on surface-raised | text | 4.5 | 17.35 | 12.71 | 15.46 |
| ink text on tint | text | 4.5 | 13.71 | 11.29 | 13.48 |
| ink text on frost | text | 4.5 | 14.36 | 12.66 | 16.47 |
| muted text on ground | text | 4.5 | 6.51 | 8.31 | 11.55 |
| muted text on surface | text | 4.5 | 6.88 | 7.68 | 10.74 |
| muted text on surface-raised | text | 4.5 | 7.07 | 6.88 | 9.73 |
| muted text on tint | text | 4.5 | 5.59 | 6.12 | 8.49 |
| muted text on frost | text | 4.5 | 5.85 | 6.86 | 10.36 |
| signal-text text on ground | text | 4.5 | 5.98 | 7.12 | 8.38 |
| signal-text text on surface | text | 4.5 | 6.31 | 6.58 | 7.80 |
| signal-text text on surface-raised | text | 4.5 | 6.49 | 5.89 | 7.06 |
| signal-text text on tint | text | 4.5 | 5.13 | 5.24 | 6.16 |
| signal-text text on frost | text | 4.5 | 5.37 | 5.87 | 7.52 |
| human text on ground | text | 4.5 | 5.89 | 11.09 | 12.93 |
| human text on surface | text | 4.5 | 6.22 | 10.24 | 12.03 |
| human text on surface-raised | text | 4.5 | 6.39 | 9.18 | 10.90 |
| human text on tint | text | 4.5 | 5.05 | 8.16 | 9.50 |
| human text on frost | text | 4.5 | 5.29 | 9.14 | 11.61 |
| agent text on ground | text | 4.5 | 6.00 | 11.38 | 13.26 |
| agent text on surface | text | 4.5 | 6.34 | 10.51 | 12.34 |
| agent text on surface-raised | text | 4.5 | 6.51 | 9.42 | 11.18 |
| agent text on tint | text | 4.5 | 5.15 | 8.38 | 9.75 |
| agent text on frost | text | 4.5 | 5.39 | 9.39 | 11.90 |
| danger-ink text on ground | text | 4.5 | 6.06 | 7.09 | 8.86 |
| danger-ink text on surface | text | 4.5 | 6.40 | 6.55 | 8.24 |
| danger-ink text on surface-raised | text | 4.5 | 6.57 | 5.87 | 7.46 |
| danger-ink text on tint | text | 4.5 | 5.20 | 5.22 | 6.51 |
| danger-ink text on frost | text | 4.5 | 5.44 | 5.85 | 7.95 |
| success text on ground | text | 4.5 | 5.99 | 10.74 | 12.50 |
| success text on surface | text | 4.5 | 6.33 | 9.92 | 11.63 |
| success text on surface-raised | text | 4.5 | 6.51 | 8.89 | 10.54 |
| success text on tint | text | 4.5 | 5.14 | 7.90 | 9.19 |
| success text on frost | text | 4.5 | 5.38 | 8.86 | 11.22 |
| primary button label | text | 4.5 | 4.57 | 5.17 | 5.33 |
| tooltip / inverted chip | text | 4.5 | 17.35 | 12.71 | 15.46 |
| signal mark/border on ground | ui | 3 | 3.49 | 5.17 | 5.33 |
| signal mark/border on surface | ui | 3 | 3.69 | 4.78 | 4.96 |
| signal mark/border on surface-raised | ui | 3 | 3.79 | 4.28 | 4.49 |
| sky mark/border on ground | ui | 3 | 4.10 | 9.10 | 11.61 |
| sky mark/border on surface | ui | 3 | 4.33 | 8.41 | 10.81 |
| sky mark/border on surface-raised | ui | 3 | 4.45 | 7.54 | 9.79 |
| focus mark/border on ground | ui | 3 | 4.10 | 9.10 | 13.43 |
| focus mark/border on surface | ui | 3 | 4.33 | 8.41 | 12.49 |
| focus mark/border on surface-raised | ui | 3 | 4.45 | 7.54 | 11.32 |
| line-strong mark/border on ground | ui | 3 | 3.89 | 5.02 | 6.40 |
| line-strong mark/border on surface | ui | 3 | 4.11 | 4.64 | 5.95 |
| line-strong mark/border on surface-raised | ui | 3 | 4.22 | 4.16 | 5.39 |
| human mark/border on ground | ui | 3 | 5.89 | 11.09 | 12.93 |
| human mark/border on surface | ui | 3 | 6.22 | 10.24 | 12.03 |
| human mark/border on surface-raised | ui | 3 | 6.39 | 9.18 | 10.90 |
| agent mark/border on ground | ui | 3 | 6.00 | 11.38 | 13.26 |
| agent mark/border on surface | ui | 3 | 6.34 | 10.51 | 12.34 |
| agent mark/border on surface-raised | ui | 3 | 6.51 | 9.42 | 11.18 |
| ink mark/border on ground | ui | 3 | 15.99 | 15.35 | 18.34 |
| ink mark/border on surface | ui | 3 | 16.89 | 14.18 | 17.07 |
| ink mark/border on surface-raised | ui | 3 | 17.35 | 12.71 | 15.46 |
| fault mark on ground (night/tv only) | ui | 3 | n/a | 7.09 | 7.31 |
| fault mark on surface (night/tv only) | ui | 3 | n/a | 6.55 | 6.80 |
| fault mark on surface-raised (night/tv only) | ui | 3 | n/a | 5.87 | 6.16 |
<!-- CONTRAST:END -->

## 4. Type

- **Schibsted Grotesk** (400 / 500 / 700 / 800) for display and UI. **Fragment Mono** (400) for labels,
  clocks, counts and data. One type system in both modes; Nightwatch's Syne is not used.
- Loaded with `next/font/google` (self-hosted at build, `display: swap`, system fallbacks), exposed as
  `--gh-font-schibsted` / `--gh-font-fragment` and consumed through `--gh-font-sans` / `--gh-font-mono`
  (Tailwind `font-brand`, `font-brand-mono`). Preload is off until rollout (#73) starts using them.
- Scale (`--gh-text-*`, Tailwind `text-gh-*`), rem × `--gh-type-scale` (1, tv 1.25):
  xs .75 · sm .875 · base 1 · lg 1.125 · xl 1.375 · 2xl 1.75 · 3xl 2.25 · 4xl 3.
- **Mono label** (`.gh-label`): Fragment Mono, 11px, uppercase, `letter-spacing: .08em`. Use it
  sparingly: a kind/state line (`AGENT · READING · LIBRARY`), a table header, a HUD pill. Never a
  sentence, never a button.
- Counts, clocks and money are mono with `tabular-nums`.
- Display headings 800 with tight tracking (-0.02em); body 400; emphasis 500/700.

## 5. Space, radii, elevation, focus

- Spacing: 4px grid, `--gh-space-1…16`.
- Radii: sm 4 · md 8 (inputs, notices, menus) · lg 12 (cards, panels) · xl 16 · pill 999 (buttons, chips, HUD).
- Elevation `--gh-elevation-1…3` (`shadow-gh-1…3`): 1 cards, 2 panels over the map, 3 menus/popovers.
  Night and tv shadows are darker, not glowier.
- Focus: `--gh-ring` = 2px ground gap + 2px `--gh-focus` (`shadow-gh-ring`), on `:focus-visible` only.
  Inside `.gh-chrome`, a default `outline: 2px solid var(--gh-focus)` applies to anything focusable.
  Other work (#67 a11y) should use `--gh-focus` rather than inventing a colour.

## 6. Modes

- `data-mode="light|night|tv"` on `<html>`. No attribute = follow `prefers-color-scheme`
  (`:root:not([data-mode])` in a media query), so a system switch applies live.
- An inline script in `<head>` (`NO_FLASH_SCRIPT`) sets the attribute before paint from `?tv=1` or the
  stored choice (`localStorage["gh-mode"]`), inside try/catch; blocked storage just follows the system.
- Resolution order (`resolveMode`): TV/kiosk → stored choice → system. TV and kiosk default to night-derived `tv`.
- The toggle lives in the You menu and ⋯ (rollout); `applyModeChoice("light"|"night"|"tv"|"system")` does it.
- `[data-mode]` also works on any element, which is how `/styleguide` previews a mode without changing yours.
- `.gh-chrome` sets ground, ink, font and `color-scheme` for a brand surface. Nothing outside a
  `.gh-chrome` element changes until rollout.

## 7. Voice

- **Terse and factual.** "12 here. 3 watching." · "lantern: reading · Library · 4m" · "Private. Members only."
- **Verbs:** Visit · Follow · Message · Watch. Access: Open · Watch only · Private.
- The product is "Glasshouse" in prose; the wordmark is lowercase "glasshouse". "Grove", "Aetheria" and
  "campus" never appear in visible copy (agent contract names stay: `/skill.md`, env vars, API paths).
- Errors name the cause and the fix ("Couldn't reach Glasshouse. Check your connection."). Refusals
  say whose door refused. No apologies, no hype, no exclamation marks.
- Never invent activity. If the data isn't there, say "not reported", never 0.

## 8. Motion

- Chrome motion is functional: state changes, drawers opening, a count ticking. Durations
  `--gh-duration-fast` 120ms (hover, press) · `base` 180ms (menus, tabs) · `slow` 280ms (drawers, sheets);
  easing `--gh-ease` `cubic-bezier(.2,0,0,1)`.
- `prefers-reduced-motion: reduce` sets all durations to 0. No parallax, no looping chrome animation.
- The lit pane may pulse once when activity starts; it never loops. Body motion on the map follows
  `MOTION.md` and is not a brand concern.

## 9. Accessibility

- WCAG 2.2 AA: every text pair ≥ 4.5:1, every control boundary and meaningful mark ≥ 3:1 (§3, tested).
- Colour is never the only signal: identity chips carry the name; access carries the word and glyph;
  errors carry text.
- Touch targets ≥ 44px on phones (`min-h-11`, relaxing to 36px from `sm`).
- Focus is always visible (`--gh-focus`); never remove an outline without replacing it with the ring.
- TV mode raises contrast and type ×1.25 for reading across a room.
- Frost has a no-blur fallback that still passes contrast over any map.
- 390px is a first-class width: nothing scrolls the page sideways; tables scroll inside their own box.

## 10. Logo and mark

- **Mark:** four panes in a rounded square frame (38/46, radius 3), mullions through the centre, the
  top-right pane lit in signal. Lit = activity. Two weights: `regular` (stroke 2.6) from 32px,
  `small` (stroke 4, larger lit pane) for 16–24px (favicon, nav).
- **Wordmark:** "glasshouse", lowercase, Schibsted Grotesk 800, tracking -0.02em, outlined to paths
  (`wordmark-path.ts`) so it never depends on the font loading.
- **Lockup:** mark + wordmark at 0.82 scale, 12-unit gap, wordmark centred on the mark.
- **Variants:** `light` (mullion ink `#0E1B2B`) on light grounds, `night` (mist `#E4E2F0`) on dark.
  The lit pane is always signal `#E2542B`.
- **Clear space:** at least a quarter of the mark's height on every side. **Minimum size:** mark 16px
  (small weight), lockup 20px tall.
- Files: `public/brand/{mark,mark-small,wordmark,lockup}-{light,night}.svg`, `public/favicon.svg`
  (follows the browser scheme), `app/icon.svg`, `app/favicon.ico` (16/32/48), `app/apple-icon.png`
  (180), `public/icons/icon-{16,32,48,192,512,maskable-512}.png`, `app/manifest.ts`
  (`manifest.webmanifest`: name Glasshouse, theme `#0E1B2B`, background `#F3F6F8`).
  Regenerate SVGs with `UPDATE_BRAND=1 pnpm --filter @grove/web test`; a test fails if they drift.
- **OG image:** `lib/og/card.tsx` (`OgCard`, 1200×630: mark + wordmark, mono eyebrow, one title, one
  line, pane grid with the lit pane), rendered by `app/opengraph-image.tsx` at build. Feed it **public
  data only**: never a private space's name, members or activity.

### Do

- Use the lit pane to mean "something is happening here".
- Put the night variant on night grounds and on photos/maps darker than mid-grey.
- Keep one signal-coloured thing per view.
- Pair every amber/cyan with a name, every access colour with its word.

### Don't

- Don't recolour the lit pane, light more than one pane, rotate, outline or add effects to the mark.
- Don't set the wordmark in another face, in capitals, or as "GlassHouse".
- Don't use signal for decoration, links, or errors (errors are `danger-ink`).
- Don't paint chrome with map-theme colours, or world art with brand tokens.
- Don't use hazard colours (`#f472b6`, `#f87171`, `#fb923c`) for anything that isn't a hazard.
- Don't use `muted` on `tint` for anything smaller than `sm`; don't use `line` as a control border.

## 11. Migration (rollout #73–#75)

Map legacy chrome to roles, page by page, with no page left half-branded:

| Legacy | Role |
|---|---|
| `bg-dusk-950` | `bg-ground` |
| `bg-dusk-900` | `bg-surface` |
| `bg-dusk-800` | `bg-surface-raised` |
| `border-dusk-700`, `border-white/10` | `border-line` (or `border-line-strong` for controls) |
| `text-white/90` | `text-ink` |
| `text-white/50…70` | `text-muted` |
| `text-lantern-300` headings | `text-ink` (display) or `text-signal-text` (a count) |
| `bg-lantern-400` primary | `bg-signal text-signal-ink` |
| `text-red-200`, `border-red-400/30` | `text-danger-ink`, `border-danger-ink/60` |
| `font-display` | `font-brand` 800 |

When the last usage moves, delete `LEGACY_CHROME_COLORS` and the page-level Source Sans fallback (map themes keep their own display faces for in-world text).
