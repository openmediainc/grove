import { describe, expect, it } from "vitest";
import {
  cardTargetFor,
  flatItems,
  groupResults,
  isTypingTarget,
  jumpHref,
  opensSearch,
  resultPath,
  searchApiPath,
  stepSelection,
  type WireSearch,
} from "../lib/search";

const MAP = "https://grove.example/";

function wire(over: Partial<WireSearch> = {}): WireSearch {
  return { query: "lan", agents: [], humans: [], spaces: [], rooms: [], online: [], ...over };
}

describe("the / key", () => {
  it("opens on a bare slash outside fields", () => {
    expect(opensSearch({ key: "/", target: { tagName: "CANVAS" } })).toBe(true);
    expect(opensSearch({ key: "/", target: null })).toBe(true);
  });
  it("never fires while typing", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(opensSearch({ key: "/", target: { tagName } })).toBe(false);
    }
    expect(opensSearch({ key: "/", target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  });
  it("leaves modified slashes and other keys alone", () => {
    expect(opensSearch({ key: "/", metaKey: true })).toBe(false);
    expect(opensSearch({ key: "/", ctrlKey: true })).toBe(false);
    expect(opensSearch({ key: "?", target: null })).toBe(false);
  });
});

describe("search results", () => {
  it("asks with an encoded, trimmed query, or none at all", () => {
    expect(searchApiPath("  ")).toBe("/api/v1/search");
    expect(searchApiPath(" a & b ")).toBe("/api/v1/search?q=a%20%26%20b");
  });

  it("shows only online now when there is no query", () => {
    const g = groupResults(
      wire({
        query: "",
        online: [{ kind: "agent", slug: "lantern", name: "Lantern", room_slug: "plaza", room_name: "Plaza", doing: "think", stalled: true }],
      }),
    );
    expect(g.map((x) => x.label)).toEqual(["Online now"]);
    expect(g[0]!.items[0]).toMatchObject({ type: "agent", online: true, detail: "Plaza · think · gone quiet" });
    expect(groupResults(wire({ query: "" }))).toEqual([]);
  });

  it("groups in a fixed order, skipping empty groups", () => {
    const g = groupResults(
      wire({
        agents: [{ slug: "lantern", name: "Lantern", owner_handle: "ada", online: true, room_slug: "plaza", room_name: "Plaza" }],
        spaces: [{ slug: "harbour", name: "Harbour", policy_preset: "public_view", owner_handle: "ada", occupancy: 2, is_member: false, ring: 3 }],
        rooms: [
          { slug: "plaza", name: "Plaza", kind: "public", occupancy: 3, space_slug: null, space_name: null },
          { slug: "plaza", name: "Plaza", kind: "public", occupancy: 0, space_slug: "harbour", space_name: "Harbour" },
        ],
      }),
    );
    expect(g.map((x) => x.label)).toEqual(["Agents", "Spaces", "Rooms"]);
    const items = flatItems(g);
    expect(items.map((i) => i.key)).toEqual(["agent:lantern", "space:harbour", "room::plaza", "room:harbour:plaza"]);
    expect(items[0]!.detail).toBe("@ada · here now · Plaza");
    // A space says its district in neutral words (#38); the palette wears no theme.
    expect(items[1]!.detail).toContain("in Ring 2");
    expect(items.map(resultPath)).toEqual(["/a/lantern", "/s/harbour", "/?room=plaza", "/s/harbour"]);
    expect(items.map((i) => cardTargetFor(i)?.subject ?? null)).toEqual(["agent", "space", null, null]);
  });

  it("walks the selection with wrap-around", () => {
    expect(stepSelection(-1, 1, 3)).toBe(0);
    expect(stepSelection(-1, -1, 3)).toBe(2);
    expect(stepSelection(2, 1, 3)).toBe(0);
    expect(stepSelection(0, -1, 3)).toBe(2);
    expect(stepSelection(0, 1, 0)).toBe(-1);
  });
});

describe("the follow-cam jump", () => {
  const [agent, offline, space] = flatItems(
    groupResults(
      wire({
        agents: [
          { slug: "lantern", name: "Lantern", owner_handle: null, online: true, room_slug: "plaza", room_name: "Plaza" },
          { slug: "sleepy", name: "Sleepy", owner_handle: null, online: false, room_slug: null, room_name: null },
        ],
        spaces: [{ slug: "harbour", name: "Harbour", policy_preset: "public_write", owner_handle: null, occupancy: 0, is_member: false }],
      }),
    ),
  );

  it("reuses ?follow= for a body on the map", () => {
    expect(jumpHref(agent!, MAP)).toBe("https://grove.example/?follow=lantern");
  });
  it("offers nothing for an offline body, a space, or a slug the map would not accept", () => {
    expect(jumpHref(offline!, MAP)).toBeNull();
    expect(jumpHref(space!, MAP)).toBeNull();
    expect(jumpHref({ ...agent!, slug: "ada/lantern" } as typeof agent & object, MAP)).toBeNull();
  });
});
