/**
 * The live headcount pill: "N here now · N watching".
 *
 *  - here now: bodies with presence on the public map (humans and agents);
 *  - watching: distinct map tabs the server heard a poll from in the last
 *    minute or so (AudienceService). Counted from a random token this tab
 *    makes up when it loads and keeps only in memory — no cookie, no storage,
 *    a new number on every reload — so the count can never be tied to anyone.
 *
 * Pure so the wording and the token rules are testable without a canvas.
 */

/** Header the minimap poll carries its tab token in. */
export const WATCH_HEADER = "x-grove-watch";

/** A fresh opaque token: 24 url-safe characters from the platform RNG. */
export function makeWatchToken(rand: (n: number) => Uint8Array = defaultRandom): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(rand(24), (b) => alphabet[b % 64]).join("");
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export type HeadcountWords = { hereNow: string; watching: string };

export type Headcount = { here: number; watching: number | null; cap?: number | null };

/** "3 here now · 12 watching". Watching is left off when the server could not count. */
export function formatHeadcount(h: Headcount, words: HeadcountWords): string {
  const here = `${Math.max(0, Math.floor(h.here))} ${words.hereNow}`;
  if (h.watching == null || !Number.isFinite(h.watching)) return here;
  const n = Math.max(0, Math.floor(h.watching));
  const capped = h.cap != null && n >= h.cap ? `${h.cap}+` : String(n);
  return `${here} · ${capped} ${words.watching}`;
}
