/**
 * The campus clock, and the light it throws.
 *
 * The scope of work gives Aetheria a 24h clock as flavour with no day/night
 * mechanics, and the art was drawn for ONE hour of it: dusk, lanterns lit, warm
 * windows against a blue-black sky. So this is not a repaint — 19:30 UTC is the
 * neutral frame, where the wash is nothing at all and the world looks exactly as
 * it did before this file existed. Every other hour is a modulation away from
 * that: a pale wash by day, a blue one at night, and a lamp term that says how
 * hard the lanterns are burning.
 *
 * Three rules it must keep.
 *
 *  1. LEGIBILITY BEATS ATMOSPHERE. Neither pass goes past 0.4, and both are
 *     laid over the terrain and the sprites ONLY — never over speech,
 *     nameplates, hazard marks or the hover card, which the renderer draws after
 *     it. There is no hour at which the map stops being readable, because the
 *     things you read are not in the tinted layer. Bodies ARE in it, so they
 *     take a lighter wash: never more than BODY_WASH_CAP (below, #54).
 *  2. NO SHIMMER. Pure function of wall-clock UTC. Two tabs at the same instant
 *     paint the same colour, a reload changes nothing, and nothing here consults
 *     Math.random, array order or poll order.
 *  3. BOUNDED COST. Twelve keyframes, one linear interpolation, called once per
 *     frame — not once per tile. The renderer pays one fillRect for the whole
 *     sky however far out you are zoomed.
 */

export type SkyPhase = "night" | "dawn" | "day" | "dusk";

/**
 * The colour daylight lifts the world toward. Cool and desaturated: the point
 * is to raise the floor of a dusk picture toward daylight, not to paint a sky
 * over the top of it.
 */
export const DAYLIGHT = "rgb(150,164,186)";

export type Sky = {
  /** Fractional UTC hour, 0..24. */
  hour: number;
  /** "03:24" — what the HUD shows beside the phase. */
  clock: string;
  phase: SkyPhase;
  /** "deep night", "golden hour" … the words for the hour. */
  label: string;
  /**
   * Daylight, as a `screen` fill: 0 at night, up to ~0.4 at noon.
   *
   * A translucent pale fill could not do this on its own. The campus is drawn
   * in dusk values — most of the picture is between #0a0e1c and #3a4358 — and
   * laying a pale film over it at any alpha low enough to keep the art legible
   * barely moved it, so midday and midnight looked like the same picture with
   * the lanterns switched off. `screen` lifts the blacks and leaves the
   * highlights alone, which is what daylight actually does to a dark scene.
   */
  lift: number;
  /** Hue wash laid over the world layer as normal alpha, or null when there is none. */
  wash: string | null;
  /** The wash's alpha alone, 0..0.34 (0 when `wash` is null). */
  washAlpha: number;
  /** 0..1, how hard the lanterns and lit windows are burning. */
  lamp: number;
};

type Key = {
  h: number;
  r: number;
  g: number;
  b: number;
  /** Capped at 0.34: past that the world stops reading, and the world wins. */
  a: number;
  /** Screen-fill strength. Capped at 0.4 for the same reason. */
  lift: number;
  lamp: number;
  label: string;
  phase: SkyPhase;
};

/**
 * The day, as twelve moments. Ordered by hour and wrapped below, so the last
 * entry interpolates into the first rather than snapping at midnight.
 *
 * The dusk entry is deliberately a=0: it is not "a very small tint", it is the
 * absence of one. Everything else is measured from there.
 */
const KEYS: readonly Key[] = [
  { h: 0, r: 10, g: 16, b: 48, a: 0.3, lift: 0, lamp: 1, label: "deep night", phase: "night" },
  { h: 3, r: 8, g: 13, b: 42, a: 0.34, lift: 0, lamp: 1, label: "deep night", phase: "night" },
  { h: 5, r: 24, g: 24, b: 62, a: 0.26, lift: 0.04, lamp: 0.92, label: "before dawn", phase: "night" },
  { h: 6.5, r: 74, g: 44, b: 66, a: 0.18, lift: 0.12, lamp: 0.62, label: "dawn", phase: "dawn" },
  { h: 8, r: 150, g: 104, b: 70, a: 0.14, lift: 0.24, lamp: 0.28, label: "sunrise", phase: "dawn" },
  { h: 10, r: 150, g: 170, b: 200, a: 0.08, lift: 0.34, lamp: 0.04, label: "morning", phase: "day" },
  { h: 13, r: 200, g: 212, b: 228, a: 0.08, lift: 0.4, lamp: 0, label: "midday", phase: "day" },
  { h: 16, r: 210, g: 190, b: 152, a: 0.08, lift: 0.32, lamp: 0, label: "afternoon", phase: "day" },
  { h: 18, r: 214, g: 136, b: 62, a: 0.13, lift: 0.16, lamp: 0.18, label: "golden hour", phase: "dusk" },
  { h: 19.5, r: 0, g: 0, b: 0, a: 0, lift: 0, lamp: 0.55, label: "dusk", phase: "dusk" },
  { h: 21, r: 22, g: 24, b: 64, a: 0.13, lift: 0, lamp: 0.82, label: "evening", phase: "dusk" },
  { h: 23, r: 14, g: 18, b: 54, a: 0.25, lift: 0, lamp: 0.96, label: "night", phase: "night" },
];


/** The wrap: midnight again, one full turn on. */
const WRAPPED: readonly Key[] = [...KEYS, { ...KEYS[0]!, h: 24 }];

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The sky at a wall-clock instant, in UTC.
 *
 * UTC and not the viewer's zone on purpose: the campus is one place, and two
 * people watching the same world from two continents must be watching the same
 * hour of it. The HUD says "UTC" so nobody reads it as their own clock.
 */
export function skyAt(nowMs: number): Sky {
  const d = new Date(nowMs);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const hour = hh + mm / 60;
  // Twelve entries: a linear scan is cheaper than the arithmetic to avoid one,
  // and this runs once a frame, not once a tile.
  let i = 0;
  while (i < WRAPPED.length - 2 && WRAPPED[i + 1]!.h <= hour) i += 1;
  const a = WRAPPED[i]!;
  const b = WRAPPED[i + 1]!;
  const span = b.h - a.h;
  const p = span <= 0 ? 0 : (hour - a.h) / span;
  const r = Math.round(a.r + (b.r - a.r) * p);
  const g = Math.round(a.g + (b.g - a.g) * p);
  const bl = Math.round(a.b + (b.b - a.b) * p);
  const al = a.a + (b.a - a.a) * p;
  const lamp = a.lamp + (b.lamp - a.lamp) * p;
  const lift = a.lift + (b.lift - a.lift) * p;
  return {
    hour,
    clock: `${two(hh)}:${two(mm)}`,
    // Words do not blend: an hour is called what the keyframe it has reached
    // calls it, so the HUD never shows a half-named time.
    phase: a.phase,
    label: a.label,
    lift,
    wash: al < 0.004 ? null : `rgba(${r},${g},${bl},${al.toFixed(3)})`,
    washAlpha: al < 0.004 ? 0 : Number(al.toFixed(3)),
    lamp,
  };
}

/* --- bodies through the night (#54) --------------------------------- *
 * The wash dims everything under it by its alpha, and the deepest hour is
 * 0.34: a third. That is right for the ground and the buildings and wrong for
 * the bodies, because a body is the work, and the work is the thing Glasshouse
 * exists to show. So a body only ever takes a lighter version of the same
 * wash, capped at BODY_WASH_CAP. It still reads as night — same hue, and dusk
 * to mid-evening is untouched because the wash is under the cap there — but a
 * body at 03:00 is never a third darker than it is at dusk.
 * ------------------------------------------------------------------- */

/** The most the hour's wash may dim a body. */
export const BODY_WASH_CAP = 0.12;

/** The wash alpha a body actually takes at a world wash of `washAlpha`. */
export function bodyWashAlpha(washAlpha: number): number {
  return Math.max(0, Math.min(washAlpha, BODY_WASH_CAP));
}

/**
 * How much of the wash to cut out where a body is, as a `destination-out`
 * alpha over the wash layer: 0 when the wash is already under the cap (no
 * body pass at all), else 1 − cap / wash, which leaves exactly the cap
 * (`wash · (1 − erase) = cap`) on a fully opaque body pixel.
 */
export function bodyWashErase(washAlpha: number): number {
  if (!(washAlpha > BODY_WASH_CAP)) return 0;
  return 1 - BODY_WASH_CAP / washAlpha;
}
