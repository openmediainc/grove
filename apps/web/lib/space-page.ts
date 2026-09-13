/**
 * The one space page, `/s/[slug]` (About · Activity · Manage), and `/explore`,
 * plus the legacy `/spaces*` routes that now land on them.
 *
 * Pure, so the tab a URL opens, who may open Manage, and where the old routes
 * go are testable. Hiding Manage from a non-owner is tidiness: every owner
 * write is refused by the API, and a private space you are not inside is a 404
 * on the page and on its activity.
 */
import { readTabParam, writeTabParam } from "./tabs";

export const SPACE_TABS = ["about", "activity", "manage"] as const;
export type SpaceTab = (typeof SPACE_TABS)[number];

export const SPACE_TAB_LABEL: Record<SpaceTab, string> = { about: "About", activity: "Activity", manage: "Manage" };

export const EXPLORE_PATH = "/explore";

/** The unprefixed in-app link to a space. About is the default tab and never written. */
export function spaceHref(slug: string, tab: SpaceTab = "about"): string {
  const q = tab === "about" ? "" : `?tab=${tab}`;
  return `/s/${encodeURIComponent(slug)}${q}`;
}

/** The tab a query string asks for, as this viewer may see it. */
export function readSpaceTab(search: string, isOwner: boolean): SpaceTab {
  return readTabParam(search, SPACE_TABS, (t) => t !== "manage" || isOwner);
}

export function withSpaceTab(search: string, tab: SpaceTab): string {
  return writeTabParam(search, SPACE_TABS, tab);
}

/** The invite link an owner copies. `/spaces/join/<code>` stays a utility route. */
export function inviteHref(code: string): string {
  return `/spaces/join/${encodeURIComponent(code)}`;
}

/**
 * How many join requests wait at this space's door, read from the inbox (the
 * one place that approves and declines them). Only pending asks are listed
 * there, and only for doors this human holds.
 */
export function waitingAt(requests: Array<{ world_id: string }> | null | undefined, worldId: string): number {
  return (requests ?? []).filter((r) => r.world_id === worldId).length;
}

export function waitingLine(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"} waiting to join. Review in Inbox`;
}

/**
 * Old routes, redirected rather than 404'd (DECISIONS #5). `/spaces/join/<code>`
 * is NOT a space: it is the invite utility and keeps its own page. A bare
 * `/spaces/join` (no code) has nothing to accept, so it goes to Explore.
 */
export type SpaceRedirect = { source: string; destination: string; permanent: false };

export function spaceRedirects(): SpaceRedirect[] {
  const r = (source: string, destination: string): SpaceRedirect => ({ source, destination, permanent: false });
  return [
    r("/spaces", EXPLORE_PATH),
    r("/spaces/join", EXPLORE_PATH),
    r("/spaces/:slug((?!join$)[^/]+)", "/s/:slug"),
  ];
}

/** The slug the create form suggests; the server lowercases and dashes it anyway. */
export function suggestSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** A directory row as the API sends it; a private plot you are not in has no slug or name. */
export type DirectorySpace = {
  id: string;
  plot_index: number;
  policy_preset: string;
  open_rooms?: Array<{ id: string; slug: string; name: string; room_preset: string; occupancy: number }>;
  occupancy: number;
  slug: string | null;
  name: string | null;
  owner_handle: string | null;
  is_member: boolean;
  is_owner: boolean;
  orgs: Array<{ id: string; slug: string; name: string; colour: string }>;
};

/**
 * Explore's order: yours first, then the ones you belong to, then open ground
 * by who is there, held plots last (they say nothing, so they never crowd out a
 * space you could visit). Stable within a group by plot number.
 */
export function exploreOrder(spaces: DirectorySpace[]): DirectorySpace[] {
  const rank = (s: DirectorySpace) => (!s.slug ? 3 : s.is_owner ? 0 : s.is_member ? 1 : 2);
  return [...spaces].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.occupancy - a.occupancy : 0) || a.plot_index - b.plot_index,
  );
}
