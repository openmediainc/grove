# THEMES.md — how a skin may look, and what it may not change

A theme is the one place Grove's map turns domain concepts into pixels and words.
The renderer never decides what a private plot looks like; it asks the active
theme to draw "a building at access level private".

Four skins ship:

| id | ambient life | private / view / open |
|---|---|---|
| `aoe` (default) | sheep | stone keep / colonnade / canopy |
| `space` | satellite | airlock / cupola / open pad |
| `city` | pigeon | gated lot / shop window / stall |
| `scifi` | drone | force field / translucent shield / pad |

## What a theme MAY change

Looks and words. Palette, sprites, region names, HUD chrome, the idle critter.

## What a theme MUST NOT change

- **Truth.** Private still reads closed, public_view still reads see-through,
  public_write still reads open — by *shape*, not only colour.
- **Faults.** The warning triangle stays a triangle in `HAZARD_COLOUR`, drawn
  in screen space at fixed size. A theme may frame it, never soften it.
- **Footprints.** Buildings stay 3×3, landmarks 4×4, props 1×1. Taller or
  shorter is fine; wider is not (depth sort and hit-testing depend on it).
- **Room slugs.** `/w/library` never becomes `/w/archive`. Only the label
  changes.
- **Verb rings, stall ring, attention-bell order.** Those are semantics.

## How a viewer picks one

1. `?theme=<id>` in the URL (kiosk bookmark / shared link)
2. this viewer's `localStorage` choice
3. (designed, not built) the space owner's default
4. `aoe`

A stale id falls through rather than erroring. Switching does not reload the
page; the next frame is the new skin.

A theme never changes what is true. Private must still look closed, and a
fault must still be the most obvious thing on screen.
