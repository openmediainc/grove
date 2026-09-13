import { describe, expect, it } from "vitest";
import { ACCESS, ACCESS_ORDER, ROOM_DOOR_CHOICES, accessCopy, accessWord, roomDoorWord } from "@/lib/access";
import {
  exploreOrder,
  inviteHref,
  readSpaceTab,
  spaceHref,
  spaceRedirects,
  suggestSlug,
  waitingAt,
  waitingLine,
  withSpaceTab,
  type DirectorySpace,
} from "@/lib/space-page";
import { readTabParam, writeTabParam } from "@/lib/tabs";

describe("one access vocabulary", () => {
  it("says Open · Watch only · Private, each with one line", () => {
    expect(ACCESS_ORDER.map(accessWord)).toEqual(["Open", "Watch only", "Private"]);
    for (const p of ACCESS_ORDER) expect(ACCESS[p].line.length).toBeGreaterThan(10);
  });

  it("reads an unknown preset as Private (privacy wins ties)", () => {
    expect(accessCopy("nonsense").word).toBe("Private");
    expect(accessWord(null)).toBe("Private");
  });

  it("names a room door by its own preset, else the space's", () => {
    expect(roomDoorWord(null, "public_view")).toBe("Watch only");
    expect(roomDoorWord("public_write", "private")).toBe("Open");
    expect(ROOM_DOOR_CHOICES.map((c) => c.value)).toEqual([null, "public_write", "public_view", "private"]);
    expect(ROOM_DOOR_CHOICES.slice(1).every((c) => c.label.startsWith(accessWord(c.value)))).toBe(true);
  });
});

describe("space page links and tabs", () => {
  it("links to /s/<slug> with About implicit", () => {
    expect(spaceHref("harbour")).toBe("/s/harbour");
    expect(spaceHref("harbour", "manage")).toBe("/s/harbour?tab=manage");
    expect(spaceHref("the hall", "activity")).toBe("/s/the%20hall?tab=activity");
    expect(inviteHref("ab/c")).toBe("/spaces/join/ab%2Fc");
  });

  it("opens Manage only for the owner", () => {
    expect(readSpaceTab("?tab=activity", false)).toBe("activity");
    expect(readSpaceTab("?tab=manage", true)).toBe("manage");
    expect(readSpaceTab("?tab=manage", false)).toBe("about");
    expect(readSpaceTab("?tab=settings", true)).toBe("about");
    expect(readSpaceTab("", false)).toBe("about");
  });

  it("writes the tab without losing the activity filters", () => {
    expect(withSpaceTab("?win=7d", "activity")).toBe("?win=7d&tab=activity");
    expect(withSpaceTab("?tab=manage&kinds=speech", "about")).toBe("?kinds=speech");
    expect(writeTabParam("", ["a", "b"] as const, "a")).toBe("");
    expect(readTabParam("?tab=b", ["a", "b"] as const, () => false)).toBe("a");
  });
});

describe("join requests live in the Inbox", () => {
  it("counts only this space's asks", () => {
    const reqs = [{ world_id: "w1" }, { world_id: "w2" }, { world_id: "w1" }];
    expect(waitingAt(reqs, "w1")).toBe(2);
    expect(waitingAt(undefined, "w1")).toBe(0);
    expect(waitingLine(1)).toBe("1 person waiting to join. Review in Inbox");
    expect(waitingLine(3)).toMatch(/^3 people waiting/);
  });
});

describe("legacy space routes", () => {
  const table = Object.fromEntries(spaceRedirects().map((r) => [r.source, r.destination]));
  const slugRule = spaceRedirects().find((r) => r.source.startsWith("/spaces/:slug"))!;
  const re = new RegExp(`^${slugRule.source.replace("/spaces/:slug", "/spaces/")}$`);

  it("send /spaces to Explore and /spaces/<slug> to the space page", () => {
    expect(table["/spaces"]).toBe("/explore");
    expect(table["/spaces/join"]).toBe("/explore");
    expect(slugRule.destination).toBe("/s/:slug");
    expect(spaceRedirects().every((r) => r.permanent === false)).toBe(true);
    expect(re.test("/spaces/harbour")).toBe(true);
  });

  it("never swallow the invite utility route", () => {
    expect(re.test("/spaces/join")).toBe(false);
    expect(re.test("/spaces/join/abc123")).toBe(false);
    expect(re.test("/spaces/joiners")).toBe(true);
  });
});

describe("explore", () => {
  const row = (over: Partial<DirectorySpace>): DirectorySpace => ({
    id: over.id ?? "w",
    plot_index: 0,
    policy_preset: "public_write",
    occupancy: 0,
    slug: "s",
    name: "S",
    owner_handle: null,
    is_member: false,
    is_owner: false,
    orgs: [],
    ...over,
  });

  it("puts yours first, then member, then open by headcount, held plots last", () => {
    const out = exploreOrder([
      row({ id: "held", slug: null, name: null, policy_preset: "private", plot_index: 1 }),
      row({ id: "quiet", plot_index: 2, occupancy: 1 }),
      row({ id: "busy", plot_index: 3, occupancy: 9 }),
      row({ id: "member", plot_index: 4, is_member: true }),
      row({ id: "mine", plot_index: 5, is_owner: true, is_member: true }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["mine", "member", "busy", "quiet", "held"]);
  });

  it("suggests a slug the server will accept", () => {
    expect(suggestSlug("  Harbour Workshop!! ")).toBe("harbour-workshop");
  });
});
