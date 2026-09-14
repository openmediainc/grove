import type { ModeChoice } from "@grove/ui/tokens";

/** The viewer-facing modes, in menu order. TV is not offered: it comes from ?tv=1 and kiosk. */
export const APPEARANCE_CHOICES = ["system", "light", "night"] as const satisfies readonly ModeChoice[];

export const APPEARANCE_LABEL: Record<(typeof APPEARANCE_CHOICES)[number], string> = {
  system: "System",
  light: "Light",
  night: "Night",
};

/**
 * Routes whose page body is on the brand tokens. Everything else renders in a
 * `[data-brand-legacy]` frame that keeps the tokens at night (rollout #74–#75
 * add routes here as they migrate; a prefix covers the subtree).
 */
export const BRANDED_ROUTES: readonly string[] = [
  "/styleguide",
  // The map (#74).
  "/",
  // Page bodies (#75).
  "/explore",
  "/s",
  "/a",
  "/u",
  "/me",
  "/inbox",
  "/how-it-works",
  "/login",
  "/mod",
  "/spaces/join",
  "/studio/preview",
];

export function isBrandedRoute(pathname: string | null | undefined, routes: readonly string[] = BRANDED_ROUTES): boolean {
  if (!pathname) return false;
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  return routes.some((r) => (r === "/" ? path === "/" : path === r || path.startsWith(`${r}/`)));
}
