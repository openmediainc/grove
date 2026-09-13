import { describe, expect, it } from "vitest";
import {
  ESTATE_NAME_MAX,
  groupEstates,
  plotBlock,
  plotsAdjacent,
  publicEstates,
  readEstateName,
  type EstateSource,
} from "../src/estates.js";

/*
 * Ring 2 of the plot spiral, by index: 0 (-1,-1), 1 (0,-1), 2 (1,-1), 3 (2,-1),
 * 4 (3,-1), 5 (3,0) … 15 (-1,0). So 0-1, 1-2, 4-5 and 0-15 share an edge, and
 * 1-15 only touch at a corner.
 */
function plot(plotIndex: number, over: Partial<EstateSource> = {}): EstateSource {
  return {
    plotIndex,
    preset: "public_write",
    ownerId: null,
    ownerHandle: null,
    ownerEstateName: null,
    orgId: null,
    orgName: null,
    orgColour: null,
    orgEstateName: null,
    accent: null,
    ...over,
  };
}

describe("estates: adjacency", () => {
  it("reads the spiral as blocks", () => {
    expect(plotBlock(0)).toEqual({ bx: -1, by: -1 });
    expect(plotBlock(1)).toEqual({ bx: 0, by: -1 });
    expect(plotBlock(15)).toEqual({ bx: -1, by: 0 });
  });

  it("counts shared edges, never corners", () => {
    expect(plotsAdjacent(0, 1)).toBe(true);
    expect(plotsAdjacent(4, 5)).toBe(true);
    expect(plotsAdjacent(0, 15)).toBe(true);
    expect(plotsAdjacent(1, 15)).toBe(false);
    expect(plotsAdjacent(0, 2)).toBe(false);
    expect(plotsAdjacent(3, 3)).toBe(false);
  });
});

describe("estates: grouping", () => {
  it("joins one owner's adjacent plots", () => {
    const g = groupEstates([plot(1, { ownerId: "h1" }), plot(0, { ownerId: "h1" }), plot(2, { ownerId: "h2" })]);
    expect(g).toEqual([{ kind: "owner", plotIndices: [0, 1] }]);
  });

  it("follows a chain of edges, not just pairs", () => {
    const g = groupEstates([1, 0, 15, 14].map((i) => plot(i, { ownerId: "h1" })));
    expect(g).toEqual([{ kind: "owner", plotIndices: [0, 1, 14, 15] }]);
  });

  it("does not join diagonal plots", () => {
    expect(groupEstates([plot(1, { ownerId: "h1" }), plot(15, { ownerId: "h1" })])).toEqual([]);
  });

  it("joins plots that share a primary org across owners, org first", () => {
    const g = groupEstates([
      plot(0, { ownerId: "h1", orgId: "o1" }),
      plot(1, { ownerId: "h2", orgId: "o1" }),
      plot(2, { ownerId: "h2" }),
    ]);
    // 1 went to the org estate, so h2's plot 2 has no same-owner neighbour left.
    expect(g).toEqual([{ kind: "org", plotIndices: [0, 1] }]);
  });

  it("falls back to the owner when the org would be alone", () => {
    const g = groupEstates([plot(0, { ownerId: "h1", orgId: "o1" }), plot(1, { ownerId: "h1", orgId: "o2" })]);
    expect(g).toEqual([{ kind: "owner", plotIndices: [0, 1] }]);
  });

  it("never lets a private plot join or bridge", () => {
    // 0 - 1 - 2 in a row; the middle is private.
    const g = groupEstates([
      plot(0, { ownerId: "h1" }),
      plot(1, { ownerId: "h1", preset: "private" }),
      plot(2, { ownerId: "h1" }),
    ]);
    expect(g).toEqual([]);
    // A two-plot estate whose partner is private is not an estate.
    expect(groupEstates([plot(4, { ownerId: "h1" }), plot(5, { ownerId: "h1", preset: "private" })])).toEqual([]);
  });

  it("ignores rows without an owner or org", () => {
    expect(groupEstates([plot(0), plot(1)])).toEqual([]);
  });
});

describe("estates: public payload", () => {
  it("names an owner estate by the chosen name, else @handle, and takes the first accent", () => {
    const rows = [
      plot(0, { ownerId: "hum_secret", ownerHandle: "ada" }),
      plot(1, { ownerId: "hum_secret", ownerHandle: "ada", accent: "#7dd3fc" }),
    ];
    expect(publicEstates(rows)).toEqual([
      { id: "estate-owner-0", kind: "owner", name: "@ada", accent: "#7dd3fc", plotIndices: [0, 1] },
    ]);
    const named = rows.map((r) => ({ ...r, ownerEstateName: "  Ada's   Acres " }));
    expect(publicEstates(named)[0]!.name).toBe("Ada's Acres");
    // A stored name that no longer passes falls back rather than drawing.
    const bad = rows.map((r) => ({ ...r, ownerEstateName: "x".repeat(ESTATE_NAME_MAX + 1) }));
    expect(publicEstates(bad)[0]!.name).toBe("@ada");
  });

  it("names an org estate by the org, in the org colour", () => {
    const rows = [
      plot(4, { ownerId: "h1", orgId: "org_x", orgName: "Lighthouse", orgColour: "#A5B4FC" }),
      plot(5, { ownerId: "h2", orgId: "org_x", orgName: "Lighthouse", orgColour: "#A5B4FC", orgEstateName: "The Keep" }),
    ];
    expect(publicEstates(rows)).toEqual([
      { id: "estate-org-4", kind: "org", name: "Lighthouse", accent: "#a5b4fc", plotIndices: [4, 5] },
    ]);
  });

  it("redacts: no ids, and nothing from a private member", () => {
    const rows = [
      plot(0, { ownerId: "hum_secret", ownerHandle: "ada" }),
      plot(1, { ownerId: "hum_secret", ownerHandle: "ada" }),
      plot(15, { ownerId: "hum_secret", ownerHandle: "ada", preset: "private", accent: "#6ee7b7" }),
      plot(2, { ownerId: "hum_other", ownerHandle: "hidden", preset: "private", orgId: "org_secret" }),
    ];
    const out = publicEstates(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.plotIndices).toEqual([0, 1]);
    const wire = JSON.stringify(out);
    for (const leak of ["hum_secret", "hum_other", "org_secret", "hidden", "#6ee7b7"]) expect(wire).not.toContain(leak);
  });
});

describe("estates: name", () => {
  it("accepts a short line, clears on empty, refuses long or multi-line", () => {
    expect(readEstateName(" North  Field ")).toEqual({ ok: true, name: "North Field" });
    expect(readEstateName("")).toEqual({ ok: true, name: null });
    expect(readEstateName(null)).toEqual({ ok: true, name: null });
    expect(readEstateName("x".repeat(ESTATE_NAME_MAX)).ok).toBe(true);
    expect(readEstateName("x".repeat(ESTATE_NAME_MAX + 1)).ok).toBe(false);
    expect(readEstateName("a\nb").ok).toBe(false);
    expect(readEstateName(42).ok).toBe(false);
  });
});
