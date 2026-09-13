/**
 * The one agent page, `/a/[slug]`: its tabs, its links, and the legacy routes
 * that now land on it.
 *
 * Pure, so the tab a URL opens (and who may open Settings) is testable. Hiding
 * Settings from a non-owner is tidiness: every owner write is refused by the API.
 */

import { TAB_PARAM, readTabParam, writeTabParam } from "./tabs";

export { TAB_PARAM };

export const AGENT_TABS = ["activity", "card", "settings"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const CLAIM_PARAM = "claim";

/**
 * The unprefixed in-app link to an agent. Slugs are `handle/name` and travel
 * as path segments, so only each segment is encoded. Activity is the default
 * tab and never written.
 */
export function agentHref(slugOrId: string, tab: AgentTab = "activity", extra?: Record<string, string>): string {
  const path = slugOrId
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
  const qs = new URLSearchParams();
  if (tab !== "activity") qs.set(TAB_PARAM, tab);
  for (const [k, v] of Object.entries(extra ?? {})) qs.set(k, v);
  const q = qs.toString();
  return `/a/${path}${q ? `?${q}` : ""}`;
}

/** The tab a query string asks for, as this viewer may see it. */
export function readTab(search: string, isOwner: boolean): AgentTab {
  return readTabParam(search, AGENT_TABS, (t) => t !== "settings" || isOwner);
}

/** The query string with `tab` written (activity = removed); other params kept. */
export function withTab(search: string, tab: AgentTab): string {
  return writeTabParam(search, AGENT_TABS, tab);
}

export function wantsClaim(search: string): boolean {
  return new URLSearchParams(search).get(CLAIM_PARAM) === "1";
}

/** The query string without the claim flag, once the claim is settled. */
export function withoutClaim(search: string): string {
  const qs = new URLSearchParams(search);
  qs.delete(CLAIM_PARAM);
  const out = qs.toString();
  return out ? `?${out}` : "";
}

/** The catch-all param back into the slug (or id) the API resolves. */
export function slugFromParam(parts: string[] | string | undefined): string {
  const list = Array.isArray(parts) ? parts : parts ? [parts] : [];
  return list
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    })
    .join("/");
}

/**
 * Old routes, redirected rather than 404'd (DECISIONS #5). `/a/<id>` resolves
 * an agent id as well as a slug, and the page then swaps the id for the slug in
 * the address bar, so a redirect never needs to look anything up.
 *
 * `/studio/preview` is a fixture harness: kept off the public deploy, reachable
 * on the Mini.
 */
export type LegacyRedirect = { source: string; destination: string; permanent: false };

export function legacyRedirects(opts: { publicDeploy: boolean }): LegacyRedirect[] {
  const r = (source: string, destination: string): LegacyRedirect => ({ source, destination, permanent: false });
  return [
    r("/agents", "/me"),
    r("/agents/:id", "/a/:id"),
    r("/studio", "/me"),
    ...(opts.publicDeploy ? [r("/studio/preview", "/me")] : []),
    r("/studio/:id((?!preview$)[^/]+)", "/a/:id?tab=settings"),
    r("/claim/:id", "/a/:id?claim=1"),
  ];
}
