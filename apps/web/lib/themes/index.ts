/**
 * The theme registry, and how a viewer's choice is read and kept.
 *
 * Resolution order, most specific first:
 *
 *   1. `?theme=<id>` in the URL — so a kiosk bookmark or a shared link pins one;
 *   2. this viewer's own choice, from localStorage;
 *   3. the default the owner of the space being viewed has set (#59,
 *      `worlds.default_theme`) — a soft default, applied only while neither of
 *      the above exists; what counts as "being viewed" is lib/themes/owner-default;
 *   4. DEFAULT_THEME.
 *
 * Anything that is not a known id falls through to the next step rather than
 * erroring: a stale bookmark to a theme that has since been removed lands on the
 * default, not on a blank map.
 *
 * Only the ids and names are here synchronously (lib/themes/meta); the art is
 * fetched per theme by lib/themes/registry (#79).
 */

import type { CSSProperties } from "react";
import { DEFAULT_THEME, isThemeId } from "./meta";
import { DEFAULT_THEME_OBJECT, peekTheme } from "./registry";
import type { Theme, ThemeId } from "./types";

export type { Theme, ThemeId } from "./types";
export { DEFAULT_THEME, THEME_IDS, THEME_META, isThemeId } from "./meta";
export { DEFAULT_THEME_OBJECT, createThemeRegistry, isThemeLoaded, loadTheme, peekTheme, preloadTheme } from "./registry";

export const THEME_STORAGE_KEY = "grove-theme";
export const THEME_QUERY = "theme";

/**
 * Synchronous: the theme if it is already loaded, else the default (#79). Only
 * aoe is bundled, so for anything else call `loadTheme` (or `useTheme`) and
 * use this for "whatever is here right now".
 */
export function getTheme(id: string | null | undefined): Theme {
  return (isThemeId(id) ? peekTheme(id) : undefined) ?? DEFAULT_THEME_OBJECT;
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

/** This viewer's own stored choice, if it is a known theme. */
export function readStoredTheme(): ThemeId | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Whether the viewer has pinned or chosen a theme themselves (steps 1–2), so an owner default must not apply. */
export function hasOwnThemeChoice(): boolean {
  return readThemeQuery() !== null || readStoredTheme() !== null;
}

/** The full resolution order for this window, with the owner default of the space being viewed, if any. */
export function readThemeChoice(ownerDefault: string | null = null): ThemeId {
  return resolveThemeId({ query: readThemeQuery(), stored: readStoredTheme(), ownerDefault });
}

/**
 * Same-tab signal that the viewer switched theme (#58). The map's switcher and
 * its T key write the choice through `writeThemeChoice`, so anything else on
 * the page that draws in the theme — the room drawer, its pixel room and board
 * tables — follows the switch live without the map passing it down. Other tabs
 * hear the `storage` event instead.
 */
export const THEME_EVENT = "grove-theme-change";

export function writeThemeChoice(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* private mode: the choice lasts as long as the tab */
  }
  announceActiveTheme(id);
}

/** What the map is showing right now in this tab, including a soft owner default (#59); null before the map says. */
let activeThemeId: ThemeId | null = null;

/**
 * Tell the rest of the page what the map is showing without persisting it —
 * the owner default of the space being viewed (#59) is not the viewer's
 * choice, but the room drawer must still match the map (DECISIONS #3).
 */
export function announceActiveTheme(id: ThemeId): void {
  activeThemeId = id;
  try {
    window.dispatchEvent(new CustomEvent<ThemeId>(THEME_EVENT, { detail: id }));
  } catch {
    /* no window (tests, server) */
  }
}

/** The theme on screen in this tab: what the map last announced, else the viewer's resolved choice. */
export function readActiveTheme(): ThemeId {
  return activeThemeId ?? readThemeChoice();
}

/**
 * Follow the viewer's theme: calls `onChange` with the id on a same-tab switch,
 * and on a switch in another tab unless this tab's URL pins one. Returns the
 * unsubscribe.
 */
export function subscribeThemeChoice(onChange: (id: ThemeId) => void): () => void {
  const same = (e: Event) => {
    const id = (e as CustomEvent<unknown>).detail;
    if (isThemeId(id)) onChange(id);
  };
  const other = (e: StorageEvent) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    onChange(resolveThemeId({ query: readThemeQuery(), stored: e.newValue }));
  };
  window.addEventListener(THEME_EVENT, same);
  window.addEventListener("storage", other);
  return () => {
    window.removeEventListener(THEME_EVENT, same);
    window.removeEventListener("storage", other);
  };
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

/**
 * The map's subline. Paperclip bodies are mirrored only on the Mini (served
 * under `/grove`); the public deployment never says so, so the line is added
 * here at runtime instead of living in every theme's lexicon.
 */
export function mapSubline(lex: Pick<Theme["lexicon"], "subline">, onMini: boolean = process.env.NEXT_PUBLIC_GROVE_BASE === "/grove"): string {
  return onMini ? `${lex.subline} Paperclip agents on this Mini walk here too.` : lex.subline;
}
