/**
 * `/` search: the pure half.
 *
 * What opens the palette, what it asks the API, the order the keyboard walks
 * the results in, and where each result goes. Visibility is the server's: the
 * API never returns a private space, its rooms, or where its members stand to
 * someone outside it, so nothing here has anything to hide.
 *
 * The jump button reuses the map's deep link (`?follow=<slug>`, lib/deep-link):
 * only a body that is on the public commons map right now can be followed, and
 * only when its slug is one the map's parser accepts.
 */
import type { CardTarget } from "./card";
import { accessWord } from "./access";
import { buildDeepLink, parseFollow } from "./deep-link";
import { spaceHref } from "./space-page";

/** A body on the commons map, as the API sends it. */
export type WireOnline = {
  kind: "agent" | "human";
  slug: string;
  name: string;
  room_slug: string | null;
  room_name: string | null;
  doing: string | null;
  stalled: boolean;
};

export type WireSearch = {
  query: string;
  agents: Array<{ slug: string; name: string; owner_handle: string | null; online: boolean; room_slug: string | null; room_name: string | null }>;
  humans: Array<{ handle: string; name: string; online: boolean; room_slug: string | null; room_name: string | null }>;
  spaces: Array<{ slug: string; name: string; policy_preset: string; owner_handle: string | null; occupancy: number; is_member: boolean }>;
  rooms: Array<{ slug: string; name: string; kind: string; occupancy: number; space_slug: string | null; space_name: string | null }>;
  online: WireOnline[];
};

export type SearchItem =
  | { type: "agent"; key: string; slug: string; name: string; detail: string; online: boolean; roomSlug: string | null }
  | { type: "human"; key: string; slug: string; name: string; detail: string; online: boolean; roomSlug: string | null }
  | { type: "space"; key: string; slug: string; name: string; detail: string }
  | { type: "room"; key: string; slug: string; name: string; detail: string; spaceSlug: string | null };

export type SearchGroup = { label: string; items: SearchItem[] };

export const SEARCH_EVENT = "grove:search";
export const SEARCH_DEBOUNCE_MS = 180;

type KeyLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: unknown;
};

/** An element the viewer is typing into. `/` there is a character, not a shortcut. */
export function isTypingTarget(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const e = el as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof e.tagName === "string" ? e.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable === true;
}

/** The bare `/` key, outside any field. A modified `/` belongs to someone else. */
export function opensSearch(ev: KeyLike): boolean {
  if (ev.key !== "/") return false;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  return !isTypingTarget(ev.target);
}

export function searchApiPath(query: string): string {
  const q = query.replace(/\s+/g, " ").trim();
  return q ? `/api/v1/search?q=${encodeURIComponent(q)}` : "/api/v1/search";
}

function where(online: boolean, room: string | null): string {
  return online && room ? `here now · ${room}` : "";
}

/** Results in the order they are drawn and walked. No query: online now only. */
export function groupResults(r: WireSearch | null): SearchGroup[] {
  if (!r) return [];
  if (!r.query) {
    return r.online.length ? [{ label: "Online now", items: r.online.map(onlineItem) }] : [];
  }
  const groups: SearchGroup[] = [
    {
      label: "Agents",
      items: r.agents.map((a) => ({
        type: "agent",
        key: `agent:${a.slug}`,
        slug: a.slug,
        name: a.name,
        detail: [a.owner_handle ? `@${a.owner_handle}` : "", where(a.online, a.room_name)].filter(Boolean).join(" · "),
        online: a.online,
        roomSlug: a.room_slug,
      })),
    },
    {
      label: "People",
      items: r.humans.map((h) => ({
        type: "human",
        key: `human:${h.handle}`,
        slug: h.handle,
        name: h.name,
        detail: [`@${h.handle}`, where(h.online, h.room_name)].filter(Boolean).join(" · "),
        online: h.online,
        roomSlug: h.room_slug,
      })),
    },
    {
      label: "Spaces",
      items: r.spaces.map((s) => ({
        type: "space",
        key: `space:${s.slug}`,
        slug: s.slug,
        name: s.name,
        detail: [accessWord(s.policy_preset), s.is_member ? "member" : "", `${s.occupancy} here`]
          .filter(Boolean)
          .join(" · "),
      })),
    },
    {
      label: "Rooms",
      items: r.rooms.map((m) => ({
        type: "room",
        key: `room:${m.space_slug ?? ""}:${m.slug}`,
        slug: m.slug,
        name: m.name,
        detail: [m.space_name ?? "Commons", `${m.occupancy} here`].join(" · "),
        spaceSlug: m.space_slug,
      })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}


function onlineItem(b: WireOnline): SearchItem {
  const doing = b.stalled ? `${b.doing ?? "working"} · gone quiet` : b.doing;
  return {
    type: b.kind,
    key: `online:${b.kind}:${b.slug}`,
    slug: b.slug,
    name: b.name,
    detail: [b.room_name, doing && doing !== "idle" ? doing : ""].filter(Boolean).join(" · "),
    online: true,
    roomSlug: b.room_slug,
  };
}

export function flatItems(groups: SearchGroup[]): SearchItem[] {
  return groups.flatMap((g) => g.items);
}

/** Wraps at both ends; -1 (nothing selected) steps onto the first or last. */
export function stepSelection(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Path segments encoded one at a time, as lib/card does. */
function enc(s: string): string {
  return s.split("/").map(encodeURIComponent).join("/");
}

/** Where a result opens: a profile, a space page, or the room itself. */
export function resultPath(item: SearchItem): string {
  switch (item.type) {
    case "agent":
      return `/a/${enc(item.slug)}`;
    case "human":
      return `/u/${encodeURIComponent(item.slug)}`;
    case "space":
      return spaceHref(item.slug);
    case "room":
      // A space's room is reached through its space, whose door decides.
      return item.spaceSlug ? spaceHref(item.spaceSlug) : `/w/${encodeURIComponent(item.slug)}`;
  }
}

/** The card a result shows. Rooms have none. */
export function cardTargetFor(item: SearchItem): CardTarget | null {
  if (item.type === "agent") return { subject: "agent", slug: item.slug };
  if (item.type === "human") return { subject: "human", slug: item.slug };
  if (item.type === "space") return { subject: "space", ref: item.slug };
  return null;
}

/**
 * The follow-cam jump: the map, opened already following this body. Null when
 * the body is not on the commons map (offline, or somewhere private) or its slug
 * is not one `?follow=` accepts — no button rather than a link that lands nowhere.
 */
export function jumpHref(item: SearchItem, mapUrl: string): string | null {
  if (item.type !== "agent" && item.type !== "human") return null;
  if (!item.online || !parseFollow(item.slug)) return null;
  return buildDeepLink(mapUrl, { follow: item.slug });
}
