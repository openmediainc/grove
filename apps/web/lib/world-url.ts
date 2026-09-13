/**
 * The map-first world's address (DECISIONS #1, #5).
 *
 * Rooms and the History are drawers on the map, not pages, so what is open is
 * written into the query string of `/`:
 *
 *   /?room=<slug>        the room drawer (`/w/<slug>` redirects here)
 *   /?history=1          the History drawer (`/chronicle` redirects here, and
 *                        its `win`, `kinds` and `actor` filters come along)
 *
 * One drawer at a time: opening a room closes the History and drops its
 * filters, and opening the History closes the room. Everything else in the
 * address (a theme pin, `?follow=`, `?at=`, kiosk, TV) is left alone.
 *
 * Pure, so the links other pages write and the redirects that keep old links
 * working are testable without a browser.
 */

export const ROOM_PARAM = "room";
export const HISTORY_PARAM = "history";
/** Walked straight in from the walk-in sheet (the old `/enter`), for the Plaza's welcome. */
export const ARRIVED_PARAM = "arrived";
/** The History's filters, owned by <Activity> (lib/activity). Dropped when the drawer closes. */
export const HISTORY_FILTER_PARAMS = ["win", "kinds", "actor"] as const;

/** Room slugs as the domain mints them (civic names, space rooms, `lounge`). */
const ROOM_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type WorldUrl = {
  /** The room drawer's slug, or null. */
  room: string | null;
  history: boolean;
  arrived: boolean;
};

function flagOn(v: string | null): boolean {
  return v !== null && v !== "0" && v !== "false";
}

export function parseRoomSlug(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  return ROOM_SLUG_RE.test(s) ? s : null;
}

/** What a query string opens. A room wins over the History if a link names both. */
export function readWorldUrl(search: string | URLSearchParams): WorldUrl {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const room = parseRoomSlug(p.get(ROOM_PARAM));
  return {
    room,
    history: !room && flagOn(p.get(HISTORY_PARAM)),
    arrived: Boolean(room) && p.get(ARRIVED_PARAM) === "1",
  };
}

function out(qs: URLSearchParams): string {
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** The query string with the room drawer open on `slug` (or closed for null). */
export function withRoom(search: string, slug: string | null, opts: { arrived?: boolean } = {}): string {
  const qs = new URLSearchParams(search);
  qs.delete(ARRIVED_PARAM);
  const clean = parseRoomSlug(slug);
  if (clean) {
    qs.set(ROOM_PARAM, clean);
    qs.delete(HISTORY_PARAM);
    for (const k of HISTORY_FILTER_PARAMS) qs.delete(k);
    if (opts.arrived) qs.set(ARRIVED_PARAM, "1");
  } else {
    qs.delete(ROOM_PARAM);
  }
  return out(qs);
}

/** The query string with the History open or closed. Closing drops its filters. */
export function withHistory(search: string, on: boolean): string {
  const qs = new URLSearchParams(search);
  if (on) {
    qs.set(HISTORY_PARAM, "1");
    qs.delete(ROOM_PARAM);
    qs.delete(ARRIVED_PARAM);
  } else {
    qs.delete(HISTORY_PARAM);
    for (const k of HISTORY_FILTER_PARAMS) qs.delete(k);
  }
  return out(qs);
}

/** The unprefixed in-app link to a room: the map with its drawer open. */
export function roomHref(slug: string, opts: { arrived?: boolean } = {}): string {
  const clean = parseRoomSlug(slug) ?? "plaza";
  return `/${withRoom("", clean, opts)}`;
}

/** The unprefixed in-app link to the History, with any Activity filters. */
export function historyHref(filters: { actor?: string | null; win?: string | null; kinds?: string[] } = {}): string {
  const qs = new URLSearchParams({ [HISTORY_PARAM]: "1" });
  if (filters.win) qs.set("win", filters.win);
  if (filters.kinds?.length) qs.set("kinds", filters.kinds.join(","));
  if (filters.actor) qs.set("actor", filters.actor);
  return `/?${qs.toString()}`;
}

/**
 * Old routes, redirected rather than 404'd (DECISIONS #5). Next passes the
 * request's own query through to the destination, so `/chronicle?actor=@ada`
 * lands on `/?history=1&actor=@ada` and `/w/plaza?arrived=1` keeps `arrived`.
 */
export type WorldRedirect = { source: string; destination: string; permanent: false };

export function worldRedirects(): WorldRedirect[] {
  return [
    { source: "/w/:room", destination: `/?${ROOM_PARAM}=:room`, permanent: false },
    { source: "/chronicle", destination: `/?${HISTORY_PARAM}=1`, permanent: false },
    { source: "/enter", destination: "/", permanent: false },
  ];
}
