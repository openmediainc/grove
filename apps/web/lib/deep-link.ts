/**
 * Shareable deep links into the map.
 *
 *   ?follow=<slug>   opens the map already following that body
 *   ?at=<tx>,<ty>    centres the camera on that tile
 *
 * Pure, so the parsing and the link a Copy button writes can be tested without
 * a canvas. A link only ever names what the public minimap already shows: a
 * slug that is not on the map (private, gone, never existed) resolves to
 * nothing, and the map simply opens where it would have.
 *
 * TV and kiosk own the camera. A link that also says `?tv=1` is TV, full stop,
 * and the deep link is ignored rather than fought; see `deepLinkApplies`.
 */

export const FOLLOW_QUERY = "follow";
export const AT_QUERY = "at";

/** Slugs as the domain mints them: letters, digits, dash, underscore. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Far beyond any campus; only here so a pasted link cannot ask for Infinity. */
export const AT_LIMIT = 4096;

export type DeepLink = {
  follow: string | null;
  at: { tx: number; ty: number } | null;
};

function flagOn(q: string | null): boolean {
  return q !== null && q !== "0" && q !== "false";
}

export function parseFollow(raw: string | null): string | null {
  if (raw === null) return null;
  const s = raw.trim();
  return SLUG_RE.test(s) ? s : null;
}

export function parseAt(raw: string | null): { tx: number; ty: number } | null {
  if (raw === null) return null;
  const m = /^\s*(-?\d{1,5})\s*,\s*(-?\d{1,5})\s*$/.exec(raw);
  if (!m) return null;
  const tx = Number(m[1]);
  const ty = Number(m[2]);
  if (Math.abs(tx) > AT_LIMIT || Math.abs(ty) > AT_LIMIT) return null;
  return { tx, ty };
}

export function parseDeepLink(search: string | URLSearchParams): DeepLink {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  return { follow: parseFollow(p.get(FOLLOW_QUERY)), at: parseAt(p.get(AT_QUERY)) };
}

/**
 * Whether a deep link may drive the camera on load. TV has a director that
 * points the camera every few seconds, so a follow or a centre would last one
 * cut: ignore it. Plain kiosk mode keeps the link (a wall display following one
 * agent is a real use) and the tour yields to it, as it does to a person.
 */
export function deepLinkApplies(search: string | URLSearchParams): boolean {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  return !flagOn(p.get("tv"));
}

/**
 * The link a Copy button writes. Starts from where the viewer is, keeps what
 * belongs to the address (a theme pin, say), and drops the modes and any older
 * deep link — a shared link opens the map, not the sender's wall display.
 */
export function buildDeepLink(
  current: string,
  target: { follow: string } | { at: { tx: number; ty: number } },
): string {
  const url = new URL(current);
  for (const k of ["kiosk", "tv", FOLLOW_QUERY, AT_QUERY]) url.searchParams.delete(k);
  if ("follow" in target) url.searchParams.set(FOLLOW_QUERY, target.follow);
  else url.searchParams.set(AT_QUERY, `${Math.round(target.at.tx)},${Math.round(target.at.ty)}`);
  url.hash = "";
  // URLSearchParams encodes the comma; it is a legal query character and reads
  // better in a pasted link.
  return url.toString().replace(/([?&]at=-?\d+)%2C/, "$1,");
}
