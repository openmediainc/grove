/**
 * What is known about every theme WITHOUT loading its art (#79).
 *
 * The four theme modules are large (sprites drawn in code, palettes, lexicons),
 * and a viewer only ever draws one. So the ids, the default, and the name and
 * blurb the switcher and the Manage pickers show live here, in a module with no
 * imports, and the art itself is loaded on demand through `loadTheme`
 * (lib/themes/index). Each theme's lexicon takes its name and blurb from here,
 * so the two cannot disagree.
 */

import type { ThemeId } from "./types";

export const THEME_META: Readonly<Record<ThemeId, { readonly name: string; readonly blurb: string }>> = {
  aoe: { name: "Age of Empires", blurb: "Stone, timber and lanterns at dusk. Villagers and sheep." },
  space: { name: "Space", blurb: "An orbital station on a rock. Crew in suits, robots, drifting satellites." },
  city: { name: "City", blurb: "A downtown block at dusk. Citizens, courier bots and pigeons." },
  scifi: { name: "Sci-fi", blurb: "Neon on black glass. Runners, synths, drones and holograms." },
};

/** In switcher order (T walks them in this order too). */
export const THEME_IDS = Object.keys(THEME_META) as ThemeId[];

/** Bundled eagerly: drawn first, and the fallback while another theme loads. */
export const DEFAULT_THEME: ThemeId = "aoe";

export function isThemeId(s: unknown): s is ThemeId {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(THEME_META, s);
}
