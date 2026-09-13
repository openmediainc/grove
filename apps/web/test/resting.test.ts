import { describe, expect, it } from "vitest";
import { plotForIndex } from "@grove/protocol";
import { restingBodies } from "../lib/resting";
import { AOE_LEXICON } from "../lib/themes/aoe";
import { SPACE_LEXICON } from "../lib/themes/space";
import { CITY_LEXICON } from "../lib/themes/city";
import { SCIFI_LEXICON } from "../lib/themes/scifi";

const plots = [
  { plotIndex: 0, preset: "public_write" },
  { plotIndex: 1, preset: "private" },
  { plotIndex: 2, preset: "public_view" },
];

describe("resting at plot on the map", () => {
  it("places a resting agent on its own plot", () => {
    const out = restingBodies([{ id: "a1", slug: "napper", display_name: "Napper", plot_index: 0 }], plots, new Set());
    expect(out).toHaveLength(1);
    const r = plotForIndex(0);
    expect(out[0]).toMatchObject({ id: "a1", slug: "napper", name: "Napper", plotIndex: 0 });
    expect(out[0]!.tile.x >= r.x0 && out[0]!.tile.x <= r.x1 && out[0]!.tile.y >= r.y0 && out[0]!.tile.y <= r.y1).toBe(true);
  });

  it("never draws on a private plot or a plot the map does not carry", () => {
    const out = restingBodies(
      [
        { id: "a1", plotIndex: 1 },
        { id: "a2", plotIndex: 7 },
        { id: "a3", plotIndex: 2 },
      ],
      plots,
      new Set(),
    );
    expect(out.map((b) => b.id)).toEqual(["a3"]);
  });

  it("drops a resting row for a body that is live on the map", () => {
    const out = restingBodies([{ id: "a1", plotIndex: 0 }, { id: "a2", plotIndex: 0 }], plots, new Set(["a1"]));
    expect(out.map((b) => b.id)).toEqual(["a2"]);
  });

  it("gives two agents on one plot different tiles and ignores duplicates", () => {
    const out = restingBodies(
      [{ id: "a1", plotIndex: 0 }, { id: "a2", plotIndex: 0 }, { id: "a1", plotIndex: 0 }],
      plots,
      new Set(),
    );
    expect(out).toHaveLength(2);
    expect(`${out[0]!.tile.x},${out[0]!.tile.y}`).not.toBe(`${out[1]!.tile.x},${out[1]!.tile.y}`);
  });

  it("has a resting word in every theme", () => {
    for (const lex of [AOE_LEXICON, SPACE_LEXICON, CITY_LEXICON, SCIFI_LEXICON]) {
      expect(lex.resting.length).toBeGreaterThan(0);
      expect(lex.resting).not.toBe(lex.hud.awake);
    }
  });
});
