import { describe, expect, it } from "vitest";
import {
  DECOR_MAX_ITEMS,
  DECOR_PRESETS,
  DECOR_UNLOCK,
  PLOT_DECOR_SLOTS,
  PLOT_BUILDING,
  SPACE_MARKS,
  decorCatalogue,
  decorSlotTile,
  plotForIndex,
  plotRestTiles,
  publishedDecor,
  readStoredDecor,
  unlockedDecor,
  validateDecor,
} from "../src/index.js";

const none = { marks: [], supporter: false };

describe("decor unlocks", () => {
  it("gives every plot the base three, two more per distinct mark, two more for a supporter", () => {
    expect(unlockedDecor(none)).toEqual(["bench", "planter", "lamps"]);
    expect(unlockedDecor({ marks: ["week_streak"], supporter: false })).toHaveLength(5);
    expect(unlockedDecor({ marks: ["week_streak", "week_streak", "made_up"], supporter: false })).toHaveLength(5);
    expect(unlockedDecor({ marks: [...SPACE_MARKS], supporter: false })).toHaveLength(3 + 2 * SPACE_MARKS.length);
    expect(unlockedDecor({ marks: [], supporter: true })).toHaveLength(5);
    expect(unlockedDecor({ marks: [...SPACE_MARKS], supporter: true })).toEqual([...DECOR_PRESETS]);
  });

  it("every mark unlocks exactly two presets, the supporter exactly two", () => {
    for (const m of SPACE_MARKS) {
      expect(Object.values(DECOR_UNLOCK).filter((u) => u.kind === "mark" && u.mark === m)).toHaveLength(2);
    }
    expect(Object.values(DECOR_UNLOCK).filter((u) => u.kind === "supporter")).toHaveLength(2);
    expect(Object.values(DECOR_UNLOCK).filter((u) => u.kind === "base")).toHaveLength(3);
  });

  it("catalogue: locked presets say what earns them, no counts or prices; supporter presets hide while supporters are off", () => {
    const off = decorCatalogue({ marks: ["trial"], supporter: false }, false);
    expect(off.map((e) => e.preset)).not.toContain("fountain");
    const desk = off.find((e) => e.preset === "desk")!;
    expect(desk).toMatchObject({ unlocked: false, hint: "earned by 1,000 tool calls" });
    expect(off.find((e) => e.preset === "telescope")).toMatchObject({ unlocked: true, hint: null });
    const on = decorCatalogue(none, true);
    expect(on.find((e) => e.preset === "fountain")).toMatchObject({ unlocked: false, hint: "supporter decor" });
    expect(JSON.stringify(on)).not.toMatch(/£|\$|price|buy|points|rank|\d+ of \d+/i);
  });
});

describe("decor slots", () => {
  const rect = plotForIndex(7);

  it("are on the plot, off the building, off the door and its approach", () => {
    const bx0 = PLOT_BUILDING.dx;
    const by1 = PLOT_BUILDING.dy + PLOT_BUILDING.h - 1;
    const doorX = bx0 + 1;
    const seen = new Set<string>();
    for (const s of PLOT_DECOR_SLOTS) {
      expect(s.dx >= 0 && s.dx < 8 && s.dy >= 0 && s.dy < 6).toBe(true);
      const onBuilding = s.dx >= bx0 && s.dx < bx0 + PLOT_BUILDING.w && s.dy >= PLOT_BUILDING.dy && s.dy <= by1;
      expect(onBuilding).toBe(false);
      // The door tile, its neighbours, and the column south of the door stay clear.
      expect(s.dy === by1 + 1 && Math.abs(s.dx - doorX) <= 1).toBe(false);
      expect(s.dx === doorX && s.dy > by1).toBe(false);
      seen.add(`${s.dx},${s.dy}`);
    }
    expect(seen.size).toBe(PLOT_DECOR_SLOTS.length);
  });

  it("never hold a resting body", () => {
    const rest = new Set(plotRestTiles(rect).map((t) => `${t.x},${t.y}`));
    for (let i = 0; i < PLOT_DECOR_SLOTS.length; i++) {
      const t = decorSlotTile(rect, i)!;
      expect(rest.has(`${t.x},${t.y}`)).toBe(false);
    }
    expect(decorSlotTile(rect, PLOT_DECOR_SLOTS.length)).toBeNull();
    expect(decorSlotTile(rect, 1.5)).toBeNull();
  });
});

describe("decor validation", () => {
  it("accepts unlocked presets on free slots", () => {
    const r = validateDecor([{ preset: "lamps", slot: 4 }, { preset: "bench", slot: 0 }], none);
    expect(r).toEqual({ ok: true, items: [{ preset: "bench", slot: 0 }, { preset: "lamps", slot: 4 }] });
    expect(validateDecor(null, none)).toEqual({ ok: true, items: [] });
  });

  it("refuses locked presets, bad slots, doubled slots and too many items", () => {
    expect(validateDecor([{ preset: "desk", slot: 0 }], none)).toMatchObject({ ok: false, message: /not unlocked/ });
    expect(validateDecor([{ preset: "desk", slot: 0 }], { marks: ["thousand_calls"], supporter: false }).ok).toBe(true);
    expect(validateDecor([{ preset: "fountain", slot: 0 }], none).ok).toBe(false);
    expect(validateDecor([{ preset: "bench", slot: 10 }], none)).toMatchObject({ ok: false, message: /spot/ });
    expect(validateDecor([{ preset: "bench", slot: -1 }], none).ok).toBe(false);
    expect(validateDecor([{ preset: "bench", slot: "1" }], none).ok).toBe(false);
    expect(validateDecor([{ preset: "throne", slot: 1 }], none).ok).toBe(false);
    expect(validateDecor([{ preset: "bench", slot: 1 }, { preset: "lamps", slot: 1 }], none)).toMatchObject({ ok: false, message: /one item/ });
    const seven = Array.from({ length: DECOR_MAX_ITEMS + 1 }, (_, i) => ({ preset: "bench", slot: i }));
    expect(validateDecor(seven, none)).toMatchObject({ ok: false, message: /at most 6/ });
    expect(validateDecor({ preset: "bench", slot: 1 }, none).ok).toBe(false);
  });

  it("reads stored decor leniently and publishes nothing for a private plot", () => {
    const stored = [
      { preset: "bench", slot: 2 },
      { preset: "bench", slot: 2 },
      { preset: "nope", slot: 3 },
      { preset: "fountain", slot: 5 },
      "junk",
    ];
    expect(readStoredDecor(stored)).toEqual([{ preset: "bench", slot: 2 }, { preset: "fountain", slot: 5 }]);
    expect(readStoredDecor("[]")).toEqual([]);
    // A lapsed supporter's fountain stops drawing; the bench stays.
    expect(publishedDecor("public_write", stored, none)).toEqual([{ preset: "bench", slot: 2 }]);
    expect(publishedDecor("public_view", stored, { marks: [], supporter: true })).toHaveLength(2);
    expect(publishedDecor("private", stored, { marks: [...SPACE_MARKS], supporter: true })).toEqual([]);
  });
});
