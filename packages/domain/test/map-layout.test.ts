import { describe, expect, it } from "vitest";
import { exploreRadius, paperclipHome, regionAt, seatInRegion, tileExplored } from "@grove/protocol";

describe("map-layout", () => {
  it("puts plaza at the center of the campus", () => {
    expect(regionAt(11, 8)).toBe("plaza");
    expect(regionAt(3, 8)).toBe("stage");
    expect(regionAt(20, 8)).toBe("workshop");
    expect(regionAt(11, 2)).toBe("library");
    expect(regionAt(11, 15)).toBe("garden");
    expect(regionAt(20, 15)).toBe("board");
    expect(regionAt(1, 1)).toBe("wild");
  });

  it("grows fog with claimed agents and live bodies, capped", () => {
    expect(exploreRadius(0, 0)).toBe(4);
    expect(exploreRadius(2, 1)).toBe(7);
    expect(exploreRadius(40, 40)).toBe(18);
  });

  it("explores plaza first, then outskirts", () => {
    expect(tileExplored(11, 8, 4)).toBe(true);
    expect(tileExplored(0, 0, 4)).toBe(false);
    expect(tileExplored(0, 0, 18)).toBe(true);
  });

  it("seats an id stably inside its region", () => {
    const a = seatInRegion("hello/lantern", "plaza");
    const b = seatInRegion("hello/lantern", "plaza");
    expect(a).toEqual(b);
    expect(regionAt(a.x, a.y)).toBe("plaza");
  });

  it("sends paperclip engineers to workshop and errors to board", () => {
    expect(paperclipHome("engineer", "idle")).toBe("workshop");
    expect(paperclipHome("ceo", "idle")).toBe("plaza");
    expect(paperclipHome("engineer", "error")).toBe("board");
  });
});
