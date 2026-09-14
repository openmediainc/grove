# Themes

A theme re-skins the world map and what is in it. **It changes how a truth looks
and what it is called, never what it says.** Since #74 (DECISIONS #7) it no
longer re-skins chrome: the HUD, controls, menus, peek cards, drawer frames and
their words are brand (`docs/design/DESIGN.md`).

Code: `apps/web/lib/themes/` — `types.ts` (the contract), `kit.ts` (shared marks +
procedural pixel toolkit), `index.ts` (registry + selection), one file per theme:
`aoe.ts` (default; the PNG set, unchanged), `space.ts`, `city.ts`, `scifi.ts`.

**Loading (#79).** Only aoe ships with the map. `meta.ts` holds what is known
without the art (`THEME_IDS`, `DEFAULT_THEME`, each theme's name and blurb, which
the lexicons take from it); `registry.ts` fetches the other three with `import()`
through `loadTheme(id)` (cached; a failed fetch is retried), and `useTheme(id)`
does the same for React previews. The map switches through `switch.ts`: the
switcher's check moves at once, the in-world words when the theme has loaded,
the canvas when its art is prepared too, and until then it keeps drawing the
theme it had. Fetching starts ahead of need on hover or focus of a switcher row
(and the Create preview's theme pills) and for the owner default of a plot the
camera is closing in on or a link is gliding to. App code never imports
`space.ts`/`city.ts`/`scifi.ts` or `all.ts` (the eager set, for tests);
`test/theme-registry.test.ts` fails if it does.

## The renderer speaks in concepts; the theme draws them

`WorldMap.tsx` never draws a PNG or a colour of its own choosing. Once per frame
it reads `themeRef.current` and calls a slot. Every slot is required — a theme is
declared `satisfies Theme`, so leaving one out fails `pnpm -r typecheck`
(`contract.typetest.ts` pins that).

| Slot (`ThemeArt`) | Concept | aoe | space | city | scifi |
|---|---|---|---|---|---|
| `backdrop` | beyond the map edge | dusk | starfield | night | scanline gradient |
| `ground(region)` | terrain per verb region + `wild` | tiles | deck plates / regolith | pavers, brick, asphalt, grass / lots | neon grid |
| `path(mask)` | avenue, 16-way | paving | lit walkway | road with lane dashes | light lane |
| `scatter(key)` | ground seasoning | pebbles… | rivets, seams | leaves, cones | glints |
| `landmark(room)` | work site per region, 4x4 | civic PNGs | Bridge, Data Core, Fabrication Bay, Comms Array, Hydroponics, Mission Board | Downtown Square, Public Library, Works Yard, Theatre, City Park, Notice Board | Hub, Memory Bank, Foundry, Holo Stage, Biodome, Alert Grid |
| `building(access)` | claimed plot, 3x3 | keep / colonnade / canopy | sealed module / viewport / open dock | gated lot / glass lobby / open park | force field / glass / open arch |
| `scaffold(stage)` | work in progress | timber | gantry | site + crane | wireframe materialising |
| `prop(key)` | lantern=light, bench=seat, planter=green, crates=stores, signpost=wayfinding, brazier=heat, wellstone=water, rubble=debris | PNGs | beacon, seat module, hydro pod, cargo, nav antenna, reactor vent, coolant tank, debris | street lamp, bench, tree, dumpster, street sign, food cart, fountain, cones | neon pylon, hover bench, bio planter, data crates, holo sign, plasma core, holo pool, scrap |
| `body(sprite)` | human/agent × front/side/work/speak | villagers | astronaut / robot | citizen / courier bot | runner / synth |
| `ambient(pose)` | idle critter | sheep | satellite | pigeon | drone |
| `carry(item)` | read/tool/think/garden-idle | document, tool, lamp, seedling | datapad, spanner, orb, vial | newspaper, hammer, coffee, pot plant | holo card, cutter, cube, bio-cell |
| `glyph(verb)` | abstract verb mark | shared `drawVerbGlyph` | ← | ← | ← |
| `pennant(colour)` | org identity | pennant | mission patch | banner | holo tag |
| `hazard(tone)` | flag / fault / stall | shared triangle | ← | ← | ← |
| `speech(bubble)` | a laid-out bubble (box, wrapped lines, tail/leader, "+N", whisper) — placement is decided by `@grove/ui` speech-layout, never the theme | dark pill | cyan terminal | comic white | mono teal |
| `speechPip(whisper)` | far-zoom "said something" mark; quieter than a hazard | lantern pip | cyan pip | white pip | teal pip |
| `signboard(board)` | a claimed plot's sign on its building front: name, access, headcount, org names, org tint — laid out in SCREEN space by `lib/signboard.ts` (fixed text size, hidden below 0.55x); a private plot's board is "held" (lexicon `heldPlot`), never a name/org/headcount, and carries a padlock | timber board on cords, tint painted on top | hull placard on a strut, tint patch left | green street-name blade, tint band bottom | holo panel with corner brackets, tint underline |
| `signboard` → `SignStyle.mark` | achievement marks (030) hanging under a public board, one medallion per mark held: a thousand lifetime tool calls on the space's ground (`thousand_calls`), tool calls on seven consecutive UTC days (`week_streak`). The GLYPH SHAPE is fixed in `kit.drawSignMark` (four-point star / ring of seven studs); the theme picks the medallion material. Never on a held board; no counts, points or ranking anywhere; lexicon `marks` names them on the space peek | brass shield | round mission patch | bronze plaque | hex chip |
| `signboard` → owner branding (035) | a space owner's accent colour, sign text (≤ 24 chars) and emblem, set on the space's Manage tab. The accent takes the board's tint stripe (`SignStyle.tintAt`) and the plot's fence; a bound org then keeps a short secondary stripe in the opposite corner and still colours the org line. The sign text is an italic line under the name; the emblem sits inside the board left of the text. The 16 emblem GLYPHS are fixed in `kit.drawBrandEmblem` (drawn from paths, no image files), coloured in the accent or the theme's title colour. Accents are checked in `@grove/protocol` branding.ts at ≥ 3:1 against every theme's board (`SIGN_BOARD_COLOURS`, pinned to each `SIGN_STYLE.board` by a web test — restyle a board and that test tells you to update it) and away from the hazard colours. **Never on a held board**, and never in the minimap payload for a private plot | ← | ← | ← | ← |
| `estateSign(board)` + `estateFence(segments, accent)` | an **estate** (#37): adjacent non-private plots sharing a primary org, else an owner (4-neighbour on the plot grid; grouped server-side in `@grove/protocol` estates.ts and published as the minimap's `estates`). ONE shared sign on a seam between member plots (`layoutEstateSign`, visible from 0.4x), and one continuous fence round the union's outer edge (`lib/estates` `estatePerimeter`) in the estate's accent (org colour, else the owner's branding accent) or the theme rail. Each member plot keeps its own tint, building and a smaller board (`layoutSignboard(..., { compact: true })`): **access stays per plot**. A private plot never joins, bridges or appears; lexicon `estate.label` / `estate.plots` name it. Optional name ≤ 24 chars (migration 038: `humans.estate_name`, `orgs.estate_name`) on the space's Manage tab | gable-crested timber mount, split-rail fence ("Estate · plots") | banner-crested hull mount, dashed lit walkway ("Station · modules") | dome-crested civic plaque, kerb + bollards ("Block · lots") | braced holo panel, dashed light wall ("Compound · nodes") |
| `signboard` → `SignStyle.supporterTrim` (#51) | the **supporter trim**: a thin accent on the board of a plot whose owner is an active supporter (#47), from the minimap's public `supporter` flag. Required on every `SignStyle`. Cosmetic only: a 1px line (and at most a faint halo), no text, no animation, never the hazard colours, never louder than a hazard or verb mark. `lib/signboard` `supporterTrim()` draws it only for a literal `true` on a non-private plot; the server already sends false for a private plot and for every plot while supporters are switched off (no Stripe keys), so it is invisible until the owner enables supporters. **Never on a held board** and never on an estate's shared sign (each member's own board keeps it) | gilded edge: gold keyline inside the rim, gold corner nails | thin light strip along the placard's foot | cream-gold enamel inner border | violet glow line along the top between the brackets |
| `decor(preset)` + `DecorStyle` | **plot decor** (#45): small cosmetic props an owner places round their plot's building from Manage → Decor, unlocked by real work (3 base presets for every plot, 2 more per achievement mark, 2 more while the owner is a supporter; no currency, counts or ranking). Anchored 1x1 on the fixed `PLOT_DECOR_SLOTS` (`@grove/protocol` map-layout: never the building, the door or its approach, never a resting body's tile), ≤ 6 per plot, stored as `worlds.decor` (044). The SHAPE of each of the 11 presets (bench, planter, lamp pair, desk, bookshelf, notice board, crates, banner post, telescope, fountain, garden patch) is shared in `themes/decor.ts`; the theme supplies materials. World art pass under the bodies: the renderer cuts decor away round any body box it overlaps (`lib/decor` `paintDecorClear`, the #52 rule). **Never on a private plot** (not drawn, not in the minimap payload), never in the hazard colours | timber: planks, brass lamps, blue cloth | hull: grey plates, cyan screens, amber trim | civic: green-painted steel, stone, white trim | holo: dark panels with lit teal edges |
| `room(piece, x, y, w, h)` + `RoomStyle` | **the pixel room** (#58): the inside of a room as the room drawer's pixel mode draws it, SCREEN space in its own canvas. `floor` stamped per cell, `wall` along the strip above the first row, `lamp` at the wall's ends, `seat` under each body, `table` on every other empty cell of the last row; the room's name (lexicon) on a placard on the wall in the display face. The SHAPE of each of the 5 pieces is shared in `themes/room.ts`; the theme supplies materials. Bodies are the theme's `body()` sprites scaled to the cell, speech is the theme's `speech()`. Never the hazard colours, never a permission | planks, boarded walls, stools, tables, hanging lanterns | deck plates, bulkheads with a lit strip, seat modules, consoles, beacons | stone tiles, brick, café chairs + tables, street lamps | lit grid, scanlined panels, hover seats, holo tables, neon pylons |
| `speechFont?` | font family the layout measures speech with | sans | sans | sans | mono |

## Depth view (#46): palette `depth`

⋯ **Depth view** (off by default, remembered in this browser) is the map's adapted 3D,
still Canvas 2D isometric (`apps/web/lib/depth.ts`, pure and tested). The ground is tilted
about the viewport's centre to a 26° camera elevation (flat is 30°; the module allows
26°–40°); upright art (buildings, bodies, props, signs) is placed on the tilted ground but
keeps its height; far upright art is drawn up to 6% smaller; the ground trails a pan by at
most 10 px and settles (never under reduced motion: tilt only). Height cues are a soft
ground shadow by layer height (prop < body < building) and a haze over the top of the view.
It is a viewer preference: shots, sequences, links and camera keys are mode-free (the
centre tile is the same flat or tilted), and hit-testing, the minimap rectangle and the
camera clamp/fit use the tilted inverse. A theme supplies only `palette.depth`:

| | aoe | space | city | scifi |
|---|---|---|---|---|
| `shadow` (baked soft blob core) | violet-black | deep-space black | cool asphalt | indigo-black |
| `haze` (far-edge fade) | dusk violet | navy | smog grey | purple |

Never a hazard colour; shadows and haze are atmosphere and carry nothing.

## Optional slot: `sound` (#43)

`Theme.sound?: Partial<SoundPreset>` (`apps/web/lib/sound/presets.ts`) is the
ambient soundscape's scale and timbre. It is the one optional slot: anything left
out falls back to `DEFAULT_SOUND` (`resolveSoundPreset`). What an event MEANS in
sound is theme-invariant, like hazard marks: a tool call starting or finishing is
a soft pluck pitched by the tool's verb family (read / run / write / think), a
public line is a breathy chime, an arrival is a rising two-note motif, a flag or
fault is one low muted tone (at most one per 8 s, never an alarm), under a slow
detuned pad whose low-pass opens with activity. A theme picks only the material:

| | aoe | space | city | scifi |
|---|---|---|---|---|
| scale | major pentatonic | lydian | dorian | minor pentatonic |
| timbre | `wood` (triangle) | `glass` (sine + high partial, long tail) | `keys` (warm electric piano) | `fm` (FM bells) |

Pure WebAudio synthesis (oscillators, filters, a ConvolverNode on a generated
impulse): no audio files, loops or requests. It reads only what the canvas already
has, at most ~4 voices a second with bursts collapsed. Off by default; ON by
default in kiosk/TV (after a tap, per autoplay policy); ⋯ Sound has the toggle,
volume and "Reduce sound (bed only)". Sound never carries information the map
does not draw.

Plus `ThemePalette` (plot tints, fog, edges, nameplates, lamp glow, daylight
colour, hover card, chrome tokens, display font) and `ThemeLexicon` (every UI word:
heading, human/agent nouns, region names + bookmark sentences, access labels +
blurbs, construction word, bell words, HUD/legend, control labels, postcard words, the `resting` caption for an agent resting at its plot — its moon mark and dim are fixed, `lib/motion/marks.ts`; `inTrial`, and `atTable` for where a board game is played (#42) — the trial ring and the "playing" checker tile over a seated body are fixed, `lib/motion/marks.ts`).
The Postcard control (`lib/postcard.ts`) saves the canvas plus a caption strip —
`postcard.greeting` + `postcard.world`, the UTC hour, and the followed or mid-frame
body in civic-region words — as a local PNG download; nothing is posted, and the
caption never names a private plot. Room slugs in
URLs (`/w/library`) never change.

**Chrome is not themed (#74, DECISIONS #7 boundary).** The map section is a
`.gh-chrome` surface (`data-map-chrome`) styled by the brand `--gh-*` tokens in
light, night and tv; only its ground (what shows before the canvas paints) is the
theme's `dusk950`. `themeStyle()` (the palette's `--g-dusk-*`, `--g-lantern-*`,
`--g-font-display`) is now set only on in-world DOM: the pixel room's wrapper in
the drawer. The chrome's WORDS come from `lib/themes/chrome-words.ts`
(`CHROME_WORDS`: Visit · Follow · Message · Watch; Open · Watch only · Private),
never from the lexicon; the lexicon names in-world things only — room names (on
signs, the Go to list and the drawer title, with the plain name under it),
district names, the resting caption, the postcard's printed caption.
People vs agents is a small theme-invariant identity tick after every nameplate
(`lib/identity.ts`: amber dot / cyan diamond in the night brand values on a dark
backing), never a replacement for a verb, hazard or outcome mark.
`test/map-chrome.test.ts` fails on a legacy chrome class in a map chrome
component. Note: a Tailwind config change needs `rm -rf apps/web/.next` and a web restart.

## The room drawer (#58)

Themes reskin the map and the room drawer's **in-world content** only
(DECISIONS #3 as refined by #7): the drawer's frame (header, room strip,
sections, transcript, composer) is brand chrome; the pixel room keeps the theme
(its wrapper sets `themeStyle()`) and board pieces sit on the theme's own ground
(`tableColours().ground`). Pages (`/s`, `/a`, `/u`, `/explore`, the space page's
Board) stay neutral, and the nav wordmark is always the neutral Glasshouse. The
drawer reads the theme through `useActiveTheme()` (`?theme=` / stored choice
on mount, then `THEME_EVENT` from `writeThemeChoice` in this tab and `storage`
from other tabs), so it follows the switcher and the T key live without the map
passing the theme down. Its colours come from `themes/room-palette.ts`, a pure
mapping of the palette: `roomColours` (floor dim, name plates, wall placard) for
the pixel room and `tableColours` (frame, holes, discs, squares, pieces) for
board tables. What a mark means stays fixed: the whisper ring, the agent name
colour (human and agent stay distinguishable), and `TABLE_MARKS` — last move,
the piece you picked up, legal targets and a king in check — never come from a
theme and are never a hazard colour.

## Rules a theme may not break

1. **Semantic colours are not theme tokens.** `HAZARD_COLOUR`, `STALL_RING` (in
   `types.ts`) and `VERB_RING` (in `agent-verbs.ts`) are fixed. Themes use the
   shared hazard triangle and verb glyphs from `kit.ts`.
2. **A fault is the most salient thing on screen in every theme.** Don't paint
   scenery in the hazard colours or at their weight (scifi deliberately has no
   neon pink — that is the injection-flag colour). The bell keeps its red/orange
   classes and its order.
3. **Colour is never the only carrier of access level.** `building()` must say it
   by shape: private reads *closed* (no openings, shut and barred door, padlock),
   public_view reads *see-through but shut*, public_write reads *open* (no walls).
   The lexicon's private label/blurb must still say closed.
4. **Human and agent stay distinguishable** in sprite and in words
   ("Crew (a person)" / "Service unit (an agent)").
5. **Geometry is fixed.** Footprints, anchors and the tile grid decide seat
   blocking, draw order and hit-testing. A theme may draw taller, never wider.
6. **Things you read are drawn after the sky** (speech, labels, hazards) — the
   renderer owns that order, not the theme.
7. **Performance:** bake once, stamp per frame (`kit.bakery`, `bakeAnchored`,
   `bakeTile`, `bakeGrid`). No gradients or path-building per frame per thing.

## Selection

Order: `?theme=<id>` → viewer's localStorage `grove-theme` → owner default of
the space being viewed (#59) → `aoe`. Unknown ids fall through. The switcher sits in the map controls;
**T** cycles themes (also in kiosk mode, where controls are hidden); a URL pin is
moved along with a manual switch so the address bar never disagrees with the
screen. The canvas keeps drawing the old theme until the new one's `prepare()`
resolves; the chrome switches at once.

**Owner default (#59):** a space owner sets `worlds.default_theme` (045) on
Manage → Default theme, picking from the four themes via the Branding sign
preview (or none). `PUT /api/v1/worlds/:id/default-theme` is owner-only (else 404);
ids are `@grove/protocol` space-theme.ts, pinned to `THEME_IDS` by a web test.
It is a SOFT default (`lib/themes/owner-default.ts`, pure): the map applies it
only while the viewer has no URL pin and no stored choice, never in kiosk/TV,
and only while that space is being viewed —
- a link that targets its plot: the space page's Visit (`?room=` + `?at=` on the
  plot), a `?at=`, a resolved `?follow=` standing on the plot, or a `?seq=` whose
  first shot starts there; it holds while the camera travels there (≤ 12 s), and
  is spent once the camera has arrived and left; or
- the camera centred on the plot (nearest within 1 tile, zoom ≥ 0.9; kept with
  slack to 1.5 tiles / 0.8x so an edge does not flicker).
When the camera leaves, the viewer's normal default returns. The space page's
own preview canvases (Decor) use it too. **Private plots:** the public minimap
never carries the default (`default_theme` null, and the client ignores it for a
private row anyway); members get their private plots' defaults from
`GET /api/v1/world/member-default-themes`, so outsiders see a held plot in their
own theme. Theme is a view preference, not a policy.

## Adding a theme

1. Copy `space.ts`; fill every slot, palette token and lexicon key (the compiler
   lists what is missing).
2. Add the id to `ThemeId` in `types.ts`, its name and blurb to `THEME_META` in
   `meta.ts`, a loader to `LOADERS` in `registry.ts`, and the theme to `THEMES` in
   `all.ts`.
3. If it needs a web font, add it to the Google Fonts import in `globals.css`,
   with a generic fallback in `displayFont`.
4. Screenshot it on the fixture scene next to aoe and check the rules above:
   the three access buildings at close zoom, the faulted bodies at 0.4x.
