import { describe, expect, it } from "vitest";
import {
  historyHref,
  parseRoomSlug,
  readWorldUrl,
  roomHref,
  withHistory,
  withRoom,
  worldRedirects,
} from "@/lib/world-url";
import { readActivityFilters } from "@/lib/activity";
import { legacyRedirects } from "@/lib/agent-page";
import { spaceRedirects } from "@/lib/space-page";
import { parseDeepLink } from "@/lib/deep-link";

/** Next's redirect, reduced to what these three rules use: one `:param`, query passed through. */
function applyRedirect(path: string): string | null {
  const [pathname, query = ""] = path.split("?");
  for (const r of worldRedirects()) {
    const m = new RegExp(`^${r.source.replace(/:([a-z]+)/g, "(?<$1>[^/]+)")}$`).exec(pathname!);
    if (!m) continue;
    let dest = r.destination;
    for (const [k, v] of Object.entries(m.groups ?? {})) dest = dest.replace(`:${k}`, v);
    if (!query) return dest;
    return `${dest}${dest.includes("?") ? "&" : "?"}${query}`;
  }
  return null;
}

describe("the map's address", () => {
  it("opens a room drawer, the History, or nothing", () => {
    expect(readWorldUrl("?room=plaza")).toEqual({ room: "plaza", history: false, arrived: false });
    expect(readWorldUrl("?room=plaza&arrived=1")).toEqual({ room: "plaza", history: false, arrived: true });
    expect(readWorldUrl("?history=1&win=7d")).toEqual({ room: null, history: true, arrived: false });
    expect(readWorldUrl("?history=0")).toEqual({ room: null, history: false, arrived: false });
    expect(readWorldUrl("")).toEqual({ room: null, history: false, arrived: false });
    // A link naming both opens the room.
    expect(readWorldUrl("?room=board&history=1").history).toBe(false);
  });

  it("refuses slugs that are not slugs", () => {
    expect(parseRoomSlug("plaza")).toBe("plaza");
    expect(parseRoomSlug("lounge_0b5c6a8e-1d2f-4c3b-9a8d-7e6f5a4b3c2d")).toBe("lounge_0b5c6a8e-1d2f-4c3b-9a8d-7e6f5a4b3c2d");
    expect(parseRoomSlug("../mod")).toBeNull();
    expect(parseRoomSlug("a b")).toBeNull();
    expect(parseRoomSlug("")).toBeNull();
    expect(readWorldUrl("?room=%2F%2Fevil").room).toBeNull();
  });

  it("keeps one drawer open at a time and leaves the rest of the address alone", () => {
    expect(withRoom("?theme=space&follow=lantern", "garden")).toBe("?theme=space&follow=lantern&room=garden");
    expect(withRoom("?history=1&win=7d&actor=%40ada&theme=city", "stage")).toBe("?theme=city&room=stage");
    expect(withRoom("?room=stage&arrived=1&theme=city", null)).toBe("?theme=city");
    expect(withRoom("", "plaza", { arrived: true })).toBe("?room=plaza&arrived=1");
    expect(withHistory("?room=plaza&arrived=1&at=3,4", true)).toBe("?at=3%2C4&history=1");
    expect(withHistory("?history=1&win=7d&kinds=speech&actor=x&tv=1", false)).toBe("?tv=1");
  });

  it("writes the links other pages use", () => {
    expect(roomHref("workshop")).toBe("/?room=workshop");
    expect(roomHref("plaza", { arrived: true })).toBe("/?room=plaza&arrived=1");
    expect(roomHref("no good")).toBe("/?room=plaza");
    expect(historyHref()).toBe("/?history=1");
    expect(historyHref({ actor: "@ada", win: "7d", kinds: ["speech", "notice"] })).toBe(
      "/?history=1&win=7d&kinds=speech%2Cnotice&actor=%40ada",
    );
  });

  it("does not collide with the deep-link or TV params", () => {
    const qs = withRoom("?follow=lantern&tv=0&at=2,3", "library");
    expect(parseDeepLink(qs)).toEqual({ follow: "lantern", at: { tx: 2, ty: 3 } });
    expect(readWorldUrl(qs).room).toBe("library");
  });
});

describe("old routes redirect onto the map (DECISIONS #5)", () => {
  it("sends /w/<room> to the room drawer, keeping its query", () => {
    expect(applyRedirect("/w/plaza")).toBe("/?room=plaza");
    expect(readWorldUrl(applyRedirect("/w/board?arrived=1")!.split("?")[1]!)).toEqual({
      room: "board",
      history: false,
      arrived: true,
    });
  });

  it("sends /chronicle to the History drawer with its filters", () => {
    const dest = applyRedirect("/chronicle?actor=%40ada&kinds=speech&win=7d")!;
    const qs = dest.split("?")[1]!;
    expect(readWorldUrl(qs).history).toBe(true);
    expect(readActivityFilters(`?${qs}`, { win: "24h" })).toEqual({ win: "7d", kinds: ["speech"], actor: "@ada" });
  });

  it("sends /enter to the map", () => {
    expect(applyRedirect("/enter")).toBe("/");
  });

  it("are temporary and never shadow another page's redirect", () => {
    for (const r of worldRedirects()) expect(r.permanent).toBe(false);
    const others = new Set([...legacyRedirects({ publicDeploy: true }), ...spaceRedirects()].map((r) => r.source));
    for (const r of worldRedirects()) expect(others.has(r.source)).toBe(false);
  });
});
