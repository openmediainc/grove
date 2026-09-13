import { describe, expect, it } from "vitest";
import {
  activityQuery,
  activitySince,
  detailChips,
  groupActivity,
  readActivityFilters,
  writeActivityFilters,
  type ActivityEntry,
} from "@/lib/activity";

function entry(id: string, kind: string, at: string): ActivityEntry {
  return {
    id,
    type: kind,
    kind,
    moderation: false,
    created_at: at,
    actor: null,
    room_id: null,
    room_name: null,
    summary: id,
    body: null,
    body_withheld: false,
    detail: {},
  };
}

describe("activity windows", () => {
  const now = new Date("2026-09-13T15:30:00Z");
  it("counts back from now, today is local midnight, everything is unbounded", () => {
    expect(activitySince("1h", now)).toBe("2026-09-13T14:30:00.000Z");
    expect(activitySince("7d", now)).toBe("2026-09-06T15:30:00.000Z");
    expect(activitySince("all", now)).toBeNull();
    const today = new Date(activitySince("today", now)!);
    expect(today.getHours()).toBe(0);
    expect(today.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("activity grouping", () => {
  it("folds three or more same-kind collapsible rows and keeps talk whole", () => {
    const at = "2026-09-13T10:00:00Z";
    const blocks = groupActivity(
      [entry("m1", "movement", at), entry("m2", "movement", at), entry("m3", "movement", at), entry("s1", "speech", at), entry("m4", "movement", at)],
      new Date("2026-09-13T12:00:00Z"),
    );
    expect(blocks.map((b) => b.block)).toEqual(["day", "run", "one", "one"]);
    const run = blocks[1]!;
    expect(run.block === "run" && run.entries.length).toBe(3);
  });

  it("starts a new day heading when the date changes", () => {
    const blocks = groupActivity([entry("a", "speech", "2026-09-13T10:00:00Z"), entry("b", "speech", "2026-09-10T10:00:00Z")]);
    expect(blocks.filter((b) => b.block === "day")).toHaveLength(2);
  });

  it("turns a policy into words and drops fields already in the sentence", () => {
    expect(detailChips({ detail: { policy: { speak_to_agents: true, listen_to_humans: false }, seat: 2, room: "garden" } })).toEqual([
      "may speak to agents",
      "room: garden",
    ]);
  });
});

describe("activity filters in the URL", () => {
  const defaults = { win: "24h" as const };
  it("reads window, known kinds and actor; ignores junk", () => {
    expect(readActivityFilters("?win=7d&kinds=speech,bogus,speech&actor=%40ada", defaults)).toEqual({
      win: "7d",
      kinds: ["speech"],
      actor: "@ada",
    });
    expect(readActivityFilters("?win=forever", defaults)).toEqual({ win: "24h", kinds: [], actor: null });
  });

  it("writes only what differs from the default and keeps other params", () => {
    expect(writeActivityFilters("?tab=activity", { win: "24h", kinds: [], actor: null }, defaults)).toBe("?tab=activity");
    expect(writeActivityFilters("", { win: "1h", kinds: ["work", "speech"], actor: "org/scout" }, defaults)).toBe(
      "?win=1h&kinds=work%2Cspeech&actor=org%2Fscout",
    );
    // A page with a fixed actor never touches `actor`.
    expect(writeActivityFilters("?actor=x", { win: "24h", kinds: [], actor: null }, defaults, { withActor: false })).toBe("?actor=x");
  });

  it("sends a fixed actor as actor_id, else the shareable ref", () => {
    expect(activityQuery({ since: null, actorId: "agt_1", actor: "@ada" })).toBe("/api/v1/chronicle?actor_id=agt_1&limit=80");
    expect(activityQuery({ since: "2026-09-13T00:00:00.000Z", kinds: ["speech"], actor: "@ada", worldId: "w1", cursor: "c", limit: 5 })).toBe(
      "/api/v1/chronicle?since=2026-09-13T00%3A00%3A00.000Z&kinds=speech&actor=%40ada&world_id=w1&cursor=c&limit=5",
    );
  });
});
