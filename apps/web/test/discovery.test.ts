import { describe, expect, it } from "vitest";
import {
  SHELF_EMPTY,
  SHELF_VISIBLE,
  agentWords,
  arrivalWords,
  discoveryJumpHref,
  hasCardContent,
  plotWords,
  shelfAccent,
  shelfCard,
  shelfSlice,
  visitHref,
  type WireArrival,
  type WireBusyPlot,
  type WireWatchedAgent,
} from "@/lib/discovery";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const card = { working_on: null, looking_for: null, latest: null, links: [] };

function plot(over: Partial<WireBusyPlot> = {}): WireBusyPlot {
  return {
    kind: "space",
    id: "wld_1",
    slug: "harbour",
    name: "Harbour",
    policy_preset: "public_write",
    owner_handle: "ada",
    plot_index: 3,
    at: { tx: 40, ty: 12 },
    branding: null,
    card,
    here_now: 0,
    created_at: "2026-09-01T00:00:00Z",
    speakers: 0,
    spans: 0,
    visitors: 0,
    last_active_at: null,
    ...over,
  };
}

function agent(over: Partial<WireWatchedAgent> = {}): WireWatchedAgent {
  return {
    kind: "agent",
    id: "agt_1",
    slug: "lantern",
    name: "Lantern",
    owner_handle: "ada",
    card,
    followers: 0,
    claimed_at: null,
    follows_week: 0,
    reactions_week: 0,
    last_active_at: null,
    ...over,
  };
}

describe("discovery shelves (#40)", () => {
  it("describes a plot by activity, never by position or money", () => {
    const lively = plotWords(plot({ speakers: 2, spans: 7, visitors: 1, here_now: 3, last_active_at: "2026-09-13T11:59:00Z" }), NOW);
    expect(lively).toEqual(["lively now", "3 here now", "7 tool calls today"]);
    const quiet = plotWords(plot({ visitors: 1, last_active_at: "2026-09-13T06:00:00Z" }), NOW);
    expect(quiet).toEqual(["busy today", "1 visitor today"]);
    for (const w of [...lively, ...quiet]) expect(w).not.toMatch(/#\d|\bno\.\s*\d|rank|top \d|\$|£|cost/i);
  });

  it("describes an agent by watchers and this week's attention", () => {
    expect(agentWords(agent({ followers: 12, follows_week: 1, reactions_week: 4 }))).toEqual([
      "12 watching",
      "1 new follower this week",
      "4 reactions this week",
    ]);
    expect(agentWords(agent())).toEqual([]);
  });

  it("says new today or new this week", () => {
    const a: WireArrival = { ...agent(), arrived_at: "2026-09-13T02:00:00Z" };
    expect(arrivalWords(a, NOW)).toEqual(["new today", "agent"]);
    const s: WireArrival = { ...plot(), arrived_at: "2026-09-10T02:00:00Z" };
    expect(arrivalWords(s, NOW)).toEqual(["new this week", "space"]);
  });

  it("visits the space or agent page, and jumps only where the map can land", () => {
    const map = "https://glasshouse.example/?kiosk=1&theme=space";
    expect(visitHref(plot())).toBe("/s/harbour");
    expect(visitHref(agent())).toBe("/a/lantern");
    expect(discoveryJumpHref(plot(), map, new Set())).toBe("https://glasshouse.example/?theme=space&at=40,12");
    expect(discoveryJumpHref(plot({ at: null }), map, new Set())).toBeNull();
    expect(discoveryJumpHref(agent(), map, new Set())).toBeNull();
    expect(discoveryJumpHref(agent(), map, new Set(["lantern"]))).toBe("https://glasshouse.example/?theme=space&follow=lantern");
  });

  it("caps a shelf at eight with More, and has an empty line for each shelf", () => {
    const items = Array.from({ length: 11 }, (_, i) => i);
    expect(shelfSlice(items, false)).toEqual({ shown: items.slice(0, SHELF_VISIBLE), more: 3 });
    expect(shelfSlice(items, true)).toEqual({ shown: items, more: 0 });
    expect(shelfSlice([], false)).toEqual({ shown: [], more: 0 });
    expect(shelfSlice(items.slice(0, 8), false).more).toBe(0);
    expect(Object.values(SHELF_EMPTY).every((s) => s.length > 0)).toBe(true);
  });

  it("reuses the card and the space's accent", () => {
    const p = plot({ branding: { accent: "#38bdf8", sign_text: "Dock 3", emblem: null }, card: { ...card, working_on: "a ferry" } });
    expect(shelfAccent(p)).toBe("#38bdf8");
    expect(shelfAccent(plot({ branding: { accent: "red;x", sign_text: null, emblem: null } }))).toBeNull();
    expect(shelfAccent(agent())).toBeNull();
    expect(hasCardContent(p)).toBe(true);
    expect(hasCardContent(plot())).toBe(false);
    expect(shelfCard(p)).toMatchObject({ subject: "space", slug: "harbour", card: { working_on: "a ferry" }, editable: [] });
  });
});
