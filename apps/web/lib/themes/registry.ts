/**
 * The theme registry (#79): only the theme on screen is downloaded.
 *
 * aoe is imported statically — it is DEFAULT_THEME, it draws the first frame,
 * and it is what the map keeps drawing while another theme is on its way. The
 * other three are separate chunks behind `import()`, fetched the first time
 * anything asks for them: a switch, a hover or focus on the switcher, an owner
 * default on a plot the camera is nearing, a preview on Manage or Create.
 *
 * Every consumer goes through `loadTheme` (or `useTheme`, lib/themes/useTheme);
 * nothing outside tests imports space/city/scifi directly, and a test
 * (test/theme-registry.test.ts) keeps it that way.
 */

import { aoe } from "./aoe";
import { DEFAULT_THEME, isThemeId } from "./meta";
import type { Theme, ThemeId } from "./types";

export type ThemeLoaders = Readonly<Record<ThemeId, () => Promise<Theme>>>;

export type ThemeRegistry = {
  /** The theme, from cache once fetched. An unknown id resolves to the default. A failed fetch rejects and may be retried. */
  loadTheme(id: string | null | undefined): Promise<Theme>;
  /** The theme if it is already here, else undefined. Synchronous. */
  peekTheme(id: string | null | undefined): Theme | undefined;
  /** Fetch and prepare a theme ahead of need. Never throws; a failure is retried on the real load. */
  preloadTheme(id: string | null | undefined): void;
  /** Whether a theme is already here. */
  isThemeLoaded(id: string | null | undefined): boolean;
};

export function createThemeRegistry(loaders: ThemeLoaders, eager: Partial<Record<ThemeId, Theme>> = {}): ThemeRegistry {
  const loaded = new Map<ThemeId, Theme>();
  const pending = new Map<ThemeId, Promise<Theme>>();
  for (const [id, theme] of Object.entries(eager) as [ThemeId, Theme][]) loaded.set(id, theme);

  const norm = (id: string | null | undefined): ThemeId => (isThemeId(id) ? id : DEFAULT_THEME);

  const loadTheme = (raw: string | null | undefined): Promise<Theme> => {
    const id = norm(raw);
    const have = loaded.get(id);
    if (have) return Promise.resolve(have);
    const inFlight = pending.get(id);
    if (inFlight) return inFlight;
    const p = loaders[id]().then(
      (theme) => {
        loaded.set(id, theme);
        pending.delete(id);
        return theme;
      },
      (err: unknown) => {
        // A dropped chunk request must not poison the cache: the next ask tries again.
        pending.delete(id);
        throw err;
      },
    );
    pending.set(id, p);
    return p;
  };

  return {
    loadTheme,
    peekTheme: (raw) => loaded.get(norm(raw)),
    isThemeLoaded: (raw) => loaded.has(norm(raw)),
    preloadTheme: (raw) => {
      void loadTheme(raw)
        .then((t) => t.art.prepare())
        .catch(() => {
          /* offline or a stale deploy: the switch itself will try again */
        });
    },
  };
}

const LOADERS: ThemeLoaders = {
  aoe: () => Promise.resolve(aoe),
  space: () => import("./space").then((m) => m.space),
  city: () => import("./city").then((m) => m.city),
  scifi: () => import("./scifi").then((m) => m.scifi),
};

export const DEFAULT_THEME_OBJECT: Theme = aoe;

export const { loadTheme, peekTheme, preloadTheme, isThemeLoaded } = createThemeRegistry(LOADERS, { aoe });
