/**
 * Every theme, imported eagerly. FOR TESTS AND TOOLING ONLY (#79): importing
 * this from a component puts all four themes back into the map's first load.
 * App code asks the registry instead (`loadTheme`, `useTheme`).
 */

import { aoe } from "./aoe";
import { city } from "./city";
import { scifi } from "./scifi";
import { space } from "./space";
import type { Theme, ThemeId } from "./types";

export const THEMES: Readonly<Record<ThemeId, Theme>> = { aoe, space, city, scifi };
