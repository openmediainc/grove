/**
 * Discovery on Explore (queue #40): Busiest plots, Most-watched agents, Just arrived.
 *
 * Pure, so what a shelf says and where its buttons go can be tested without a
 * browser. What is ON a shelf is the server's (GET /api/v1/explore/discovery):
 * one public listing, already ordered, with private spaces left out for
 * everyone. This file never re-orders and never numbers a position: the words
 * describe activity ("lively now", "12 watching", "new this week"), never a
 * rank, and nothing here knows about money.
 */
import type { CardLink } from "@grove/protocol";
import { agentHref } from "./agent-page";
import type { WireCard } from "./card";
import { buildDeepLink, parseFollow } from "./deep-link";
import { spaceHref } from "./space-page";

export const DISCOVERY_API = "/api/v1/explore/discovery";
/** What a shelf shows before "More". */
export const SHELF_VISIBLE = 8;

type WireCardFields = { working_on: string | null; looking_for: string | null; latest: string | null; links: CardLink[] };

export type WireDiscoverySpace = {
  kind: "space";
  id: string;
  slug: string;
  name: string;
  policy_preset: string;
  owner_handle: string | null;
  plot_index: number | null;
  at: { tx: number; ty: number } | null;
  branding: { accent: string | null; sign_text: string | null; emblem: string | null } | null;
  card: WireCardFields;
  here_now: number;
  created_at: string;
};

export type WireBusyPlot = WireDiscoverySpace & {
  speakers: number;
  spans: number;
  visitors: number;
  last_active_at: string | null;
};

export type WireDiscoveryAgent = {
  kind: "agent";
  id: string;
  slug: string;
  name: string;
  owner_handle: string | null;
  card: WireCardFields;
  followers: number;
  claimed_at: string | null;
};

export type WireWatchedAgent = WireDiscoveryAgent & {
  follows_week: number;
  reactions_week: number;
  last_active_at: string | null;
};

export type WireArrival = (WireDiscoverySpace | WireDiscoveryAgent) & { arrived_at: string };

export type WireDiscovery = {
  busiest_plots: WireBusyPlot[];
  most_watched_agents: WireWatchedAgent[];
  just_arrived: WireArrival[];
  generated_at: string;
  ttl_seconds: number;
};

export type ShelfItem = WireBusyPlot | WireWatchedAgent | WireArrival;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Within this long of the last activity a plot reads as "lively now". */
export const LIVELY_MS = 30 * MIN;

/**
 * A busy plot in at most three short phrases: how alive it is, who is there,
 * and what made it busy. Never its position on the shelf.
 */
export function plotWords(p: WireBusyPlot, now: number = Date.now()): string[] {
  const out: string[] = [];
  const last = p.last_active_at ? Date.parse(p.last_active_at) : NaN;
  const lively = p.here_now > 0 || (!Number.isNaN(last) && now - last <= LIVELY_MS);
  out.push(lively ? "lively now" : "busy today");
  if (p.here_now > 0) out.push(`${p.here_now} here now`);
  const reasons: Array<[number, string]> = [
    [p.speakers, plural(p.speakers, "voice today", "voices today")],
    [p.spans, plural(p.spans, "tool call today", "tool calls today")],
    [p.visitors, plural(p.visitors, "visitor today", "visitors today")],
  ];
  const top = reasons.filter(([n]) => n > 0).sort((a, b) => b[0] - a[0])[0];
  if (top) out.push(top[1]);
  return out;
}

/** A watched agent: how many follow it, and what it earned this week. */
export function agentWords(a: WireWatchedAgent): string[] {
  const out: string[] = [];
  if (a.followers > 0) out.push(`${a.followers} watching`);
  if (a.follows_week > 0) out.push(plural(a.follows_week, "new follower this week", "new followers this week"));
  if (a.reactions_week > 0) out.push(plural(a.reactions_week, "reaction this week", "reactions this week"));
  return out;
}

/** An arrival: new today or new this week, and what it is. */
export function arrivalWords(item: WireArrival, now: number = Date.now()): string[] {
  const at = Date.parse(item.arrived_at);
  const fresh = !Number.isNaN(at) && now - at < 24 * HOUR;
  const when = fresh ? "new today" : "new this week";
  return item.kind === "space" ? [when, "space"] : [when, "agent"];
}

/** Where Visit goes: the space's page, or the agent's. */
export function visitHref(item: ShelfItem): string {
  return item.kind === "space" ? spaceHref(item.slug) : agentHref(item.slug);
}

/**
 * The map jump. A space: centred on its plot (a non-private plot is on the
 * public map). An agent: following it, only when it is on the open map now
 * (`onMap` holds the online agent slugs), otherwise no button.
 */
export function discoveryJumpHref(item: ShelfItem, mapUrl: string, onMap: ReadonlySet<string>): string | null {
  if (item.kind === "space") return item.at ? buildDeepLink(mapUrl, { at: item.at }) : null;
  if (!onMap.has(item.slug) || !parseFollow(item.slug)) return null;
  return buildDeepLink(mapUrl, { follow: item.slug });
}

/** The #5 card's rows, built from the owner's own fields the shelf already carries. */
export function shelfCard(item: ShelfItem): WireCard {
  return {
    subject: item.kind,
    slug: item.slug,
    name: item.name,
    card: item.card,
    sources: { working_on: item.card.working_on ? "owner" : null, latest: item.card.latest ? "owner" : null },
    latest_at: null,
    editable: [],
  };
}

/** Whether the card has anything to show (an empty card on a shelf is noise, not "nothing yet"). */
export function hasCardContent(item: ShelfItem): boolean {
  const c = item.card;
  return Boolean(c.working_on || c.looking_for || c.latest || c.links.length);
}

/** The #33 accent, when the space set one. */
export function shelfAccent(item: ShelfItem): string | null {
  if (item.kind !== "space") return null;
  const hex = item.branding?.accent ?? null;
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : null;
}

/** First SHELF_VISIBLE, or all when opened; and whether a More button is owed. */
export function shelfSlice<T>(items: T[], open: boolean): { shown: T[]; more: number } {
  if (open || items.length <= SHELF_VISIBLE) return { shown: items, more: 0 };
  return { shown: items.slice(0, SHELF_VISIBLE), more: items.length - SHELF_VISIBLE };
}

export const SHELF_EMPTY = {
  busiest: "Quiet on the open plots today. When people talk, visit or agents work in a public space, it shows up here.",
  watched: "No agent has picked up followers or reactions this week yet.",
  arrived: "Nothing new this week. Claim a plot or bring an agent and it will appear here.",
} as const;
