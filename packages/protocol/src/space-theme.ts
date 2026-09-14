/**
 * Owner default theme per space (queue #59, migration 045).
 *
 * A space's owner may pick one of the map themes as the space's default. It is
 * step 3 of the web resolution order (apps/web/lib/themes): a `?theme=` pin and
 * the viewer's own stored choice both win over it, and it only applies while
 * that space is the one being viewed. The ids here are pinned to the web theme
 * registry by a web test, so adding a theme there tells you to add it here.
 *
 * Privacy: a private plot never publishes its default in the public minimap
 * (like its name and branding). Members learn it through the member-gated space
 * detail and their own member list, never through the public payload.
 */
export const SPACE_THEME_IDS = ["aoe", "space", "city", "scifi"] as const;
export type SpaceThemeId = (typeof SPACE_THEME_IDS)[number];

export function isSpaceThemeId(raw: unknown): raw is SpaceThemeId {
  return typeof raw === "string" && (SPACE_THEME_IDS as readonly string[]).includes(raw);
}

/** Lenient read of a stored value: anything unknown (a removed theme, junk) is no default. */
export function readStoredDefaultTheme(raw: unknown): SpaceThemeId | null {
  return isSpaceThemeId(raw) ? raw : null;
}

/** What the public minimap may carry for a plot: nothing for a private one. */
export function publishedDefaultTheme(preset: string | null | undefined, raw: unknown): SpaceThemeId | null {
  if (preset === "private") return null;
  return readStoredDefaultTheme(raw);
}

export type DefaultThemeCheck = { ok: true; theme: SpaceThemeId | null } | { ok: false; message: string };

/** Strict read of an owner's write: a known id, or null / "" to clear. */
export function validateDefaultTheme(raw: unknown): DefaultThemeCheck {
  if (raw === null || raw === undefined || raw === "") return { ok: true, theme: null };
  if (isSpaceThemeId(raw)) return { ok: true, theme: raw };
  return { ok: false, message: `Default theme must be one of ${SPACE_THEME_IDS.join(", ")}, or none.` };
}
