/**
 * The theme registry, and how a viewer's choice is read and kept.
 *
 * Resolution order, most specific first:
 *
 *   1. `?theme=<id>` in the URL — so a kiosk bookmark or a shared link pins one;
 *   2. this viewer's own choice, from localStorage;
 *   3. (designed for, not built) the default the owner of the space being
 *      viewed has set — see docs/design/THEMES.md;
 *   4. DEFAULT_THEME.
 *
 * Anything that is not a known id falls through to the next step rather than
 * erroring: a stale bookmark to a theme that has since been removed lands on the
 * default, not on a blank map.
 */

import type { CSSProperties } from "react";
import { aoe } from "./aoe";
import type { Theme, ThemeId } from "./types";

export type { Theme, ThemeId } from "./types";

export const THEMES: Readonly<Record<ThemeId, Theme>> = { aoe };

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export const DEFAULT_THEME: ThemeId = "aoe";

export const THEME_STORAGE_KEY = "grove-theme";
export const THEME_QUERY = "theme";

export function isThemeId(s: unknown): s is ThemeId {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(THEMES, s);
}

export function getTheme(id: string | null | undefined): Theme {
  return isThemeId(id) ? THEMES[id] : THEMES[DEFAULT_THEME];
}

/** Pure half of the resolution order, so it can be reasoned about without a window. */
export function resolveThemeId(input: {
  query?: string | null;
  stored?: string | null;
  ownerDefault?: string | null;
}): ThemeId {
  if (isThemeId(input.query)) return input.query;
  if (isThemeId(input.stored)) return input.stored;
  if (isThemeId(input.ownerDefault)) return input.ownerDefault;
  return DEFAULT_THEME;
}

/** Whether the URL is pinning a theme (a pinned kiosk should not be re-persisted over). */
export function readThemeQuery(): ThemeId | null {
  try {
    const q = new URLSearchParams(window.location.search).get(THEME_QUERY);
    return isThemeId(q) ? q : null;
  } catch {
    return null;
  }
}

export function readThemeChoice(): ThemeId {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return resolveThemeId({ query: readThemeQuery(), stored });
}

export function writeThemeChoice(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* private mode: the choice lasts as long as the tab */
  }
}

/**
 * The chrome tokens as CSS custom properties. Set on the map's section, they
 * re-skin every `dusk-*` / `lantern-*` utility inside it without a reload; the
 * Tailwind config falls back to the aoe values wherever no theme is set.
 */
export function themeStyle(theme: Theme): CSSProperties {
  const c = theme.palette.chrome;
  return {
    "--g-dusk-950": c.dusk950,
    "--g-dusk-900": c.dusk900,
    "--g-dusk-800": c.dusk800,
    "--g-dusk-700": c.dusk700,
    "--g-lantern-300": c.lantern300,
    "--g-lantern-400": c.lantern400,
    "--g-lantern-500": c.lantern500,
    "--g-font-display": theme.palette.displayFont,
  } as CSSProperties;
}
