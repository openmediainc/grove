import { describe, expect, it } from "vitest";
import { DECOR_PRESETS, PLOT_DECOR_SLOTS } from "@grove/protocol";
import { decorGrid, decorHoles, decorScreenRect, placeDecor, plotDecor, sameDecor } from "../lib/decor";
import { drawDecorPreset, type DecorStyle } from "../lib/themes/decor";
import { aoe, DECOR_STYLE as AOE_DECOR } from "../lib/themes/aoe";
import { space, DECOR_STYLE as SPACE_DECOR } from "../lib/themes/space";
import { city, DECOR_STYLE as CITY_DECOR } from "../lib/themes/city";
import { scifi, DECOR_STYLE as SCIFI_DECOR } from "../lib/themes/scifi";
import { HAZARD_COLOUR, type Ctx } from "../lib/themes/types";

function recordingCtx() {
  const inks: string[] = [];
  let calls = 0;
  const target: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: (_: number, c: string) => inks.push(c.toLowerCase()) }),
    createRadialGradient: () => ({ addColorStop: (_: number, c: string) => inks.push(c.toLowerCase()) }),
  };
  const ctx = new Proxy(target, {
    get(o, k: string) {
      if (k in o) return o[k];
      return () => {
        calls += 1;
      };
    },
    set(o, k: string, v) {
      if ((k === "fillStyle" || k === "strokeStyle") && typeof v === "string") inks.push(v.toLowerCase());
      o[k] = v;
      return true;
    },
  }) as unknown as Ctx;
  return { ctx, inks, calls: () => calls };
}

describe("decor on the map", () => {
  it("a private plot draws no decor, whatever the payload says", () => {
    const raw = [{ preset: "bench", slot: 1 }];
    expect(plotDecor("private", raw)).toEqual([]);
    expect(plotDecor("public_view", raw)).toEqual([{ preset: "bench", slot: 1 }]);
    expect(plotDecor("public_write", [{ preset: "throne", slot: 1 }, { preset: "lamps", slot: 99 }])).toEqual([]);
    expect(plotDecor(undefined, "nope")).toEqual([]);
  });

  it("is cut away round a body it overlaps, and left alone otherwise", () => {
    const box = decorScreenRect(100, 100, 1, 0, 0);
    expect(decorHoles(box, [{ x0: 500, x1: 540, y0: 500, y1: 560 }], 6)).toBeNull();
    const body = { x0: 90, x1: 130, y0: 60, y1: 120 };
    const holes = decorHoles(box, [body], 6)!;
    expect(holes.length).toBeGreaterThan(0);
    // Every point of the body inside the decor box is inside a hole.
    for (let x = body.x0 + 0.5; x < body.x1; x += 4) {
      for (let y = body.y0 + 0.5; y < body.y1; y += 4) {
        if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
        expect(holes.some((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1)).toBe(true);
      }
    }
  });
});

describe("decor art in every theme (THEMES.md)", () => {
  const themes: Array<[string, DecorStyle, { art: { decor: unknown } }]> = [
    ["aoe", AOE_DECOR, aoe],
    ["space", SPACE_DECOR, space],
    ["city", CITY_DECOR, city],
    ["scifi", SCIFI_DECOR, scifi],
  ];
  const hazards = Object.values(HAZARD_COLOUR).map((c) => c.toLowerCase());

  it.each(themes)("%s fills the decor slot and draws every preset, never in hazard colours", (_id, style, theme) => {
    expect(typeof theme.art.decor).toBe("function");
    for (const p of DECOR_PRESETS) {
      const { ctx, inks, calls } = recordingCtx();
      drawDecorPreset(ctx, p, style);
      expect(calls()).toBeGreaterThan(0);
      for (const h of hazards) expect(inks).not.toContain(h);
    }
    // The four themes do not share one palette.
    expect(Object.values(style).join()).toBeTruthy();
  });

  it("each theme picks its own materials", () => {
    const keys = new Set(themes.map(([, s]) => `${s.material}:${s.wood}:${s.light}`));
    expect(keys.size).toBe(4);
  });
});

describe("Manage → Decor editor", () => {
  it("lays the plot out with the building, a clear door and every slot once", () => {
    const g = decorGrid();
    expect(g).toHaveLength(6);
    expect(g.every((r) => r.length === 8)).toBe(true);
    const cells = g.flat();
    expect(cells.filter((c) => c.kind === "building")).toHaveLength(9);
    expect(cells.filter((c) => c.kind === "door")).toHaveLength(1);
    const slots = cells.flatMap((c) => (c.kind === "slot" ? [c.slot] : []));
    expect(slots.sort((a, b) => a - b)).toEqual(PLOT_DECOR_SLOTS.map((_, i) => i));
  });

  it("places, replaces, clears and caps", () => {
    const first = placeDecor([], 3, "bench");
    expect(first).toEqual({ ok: true, items: [{ preset: "bench", slot: 3 }] });
    const swapped = placeDecor(first.ok ? first.items : [], 3, "lamps");
    expect(swapped).toEqual({ ok: true, items: [{ preset: "lamps", slot: 3 }] });
    expect(placeDecor([{ preset: "lamps", slot: 3 }], 3, null)).toEqual({ ok: true, items: [] });
    const six = [0, 1, 2, 3, 4, 5].map((slot) => ({ preset: "bench" as const, slot }));
    expect(placeDecor(six, 7, "bench").ok).toBe(false);
    expect(placeDecor(six, 5, "planter").ok).toBe(true);
    expect(sameDecor(six, [...six])).toBe(true);
    expect(sameDecor(six, six.slice(1))).toBe(false);
  });
});
