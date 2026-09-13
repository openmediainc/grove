import { describe, expect, it } from "vitest";
import { PLOT_COLS, plotForIndex } from "@grove/protocol";
import { estatePerimeter, estateSignTile, readEstates } from "../lib/estates";
import {
  LOD_ESTATE_SIGN,
  estateSignContent,
  layoutEstateSign,
  layoutSignboard,
  signContent,
  type SignPlot,
} from "../lib/signboard";
import { drawEstateFence, drawEstateSign } from "../lib/themes/kit";
import { AOE_LEXICON, ESTATE_STYLE as AOE_ESTATE, SIGN_STYLE as AOE_SIGN } from "../lib/themes/aoe";
import { SPACE_LEXICON, ESTATE_STYLE as SPACE_ESTATE, SIGN_STYLE as SPACE_SIGN } from "../lib/themes/space";
import { CITY_LEXICON, ESTATE_STYLE as CITY_ESTATE, SIGN_STYLE as CITY_SIGN } from "../lib/themes/city";
import { SCIFI_LEXICON, ESTATE_STYLE as SCIFI_ESTATE, SIGN_STYLE as SCIFI_SIGN } from "../lib/themes/scifi";
import { HAZARD_COLOUR, type Ctx } from "../lib/themes/types";

const measure = (text: string, px: number) => (text.length * (px * 6)) / 11;

function recordingCtx() {
  const inks: string[] = [];
  const texts: string[] = [];
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 5 }),
    fillText: (t: string) => texts.push(t),
  };
  const ctx = new Proxy(target, {
    get(o, k: string) {
      if (k in o) return o[k];
      return () => {};
    },
    set(o, k: string, v) {
      if ((k === "fillStyle" || k === "strokeStyle") && typeof v === "string") inks.push(v.toLowerCase());
      o[k] = v;
      return true;
    },
  }) as unknown as Ctx;
  return { ctx, inks, texts };
}

// Ring 2 of the spiral: 0 (-1,-1), 1 (0,-1), 2 (1,-1); 15 (-1,0). 1 and 15 are diagonal.
const plots = [
  { plotIndex: 0, preset: "public_write" },
  { plotIndex: 1, preset: "public_view" },
  { plotIndex: 2, preset: "private" },
  { plotIndex: 15, preset: "public_write" },
];

describe("estates: payload on the map", () => {
  it("keeps a well-formed estate", () => {
    const e = readEstates([{ id: "estate-owner-0", kind: "owner", name: " @ada ", accent: "#7DD3FC", plot_indices: [1, 0] }], plots);
    expect(e).toEqual([{ id: "estate-owner-0", kind: "owner", name: "@ada", accent: "#7dd3fc", plotIndices: [0, 1] }]);
  });

  it("drops private members, and an estate left with one plot", () => {
    expect(readEstates([{ id: "x", kind: "owner", plot_indices: [1, 2] }], plots)).toEqual([]);
    const kept = readEstates([{ id: "x", kind: "owner", plot_indices: [0, 1, 2] }], plots);
    expect(kept[0]!.plotIndices).toEqual([0, 1]);
  });

  it("drops diagonal-only or unknown groups and bad accents", () => {
    expect(readEstates([{ id: "x", kind: "org", plot_indices: [1, 15] }], plots)).toEqual([]);
    expect(readEstates([{ id: "x", kind: "org", plot_indices: [0, 99] }], plots)).toEqual([]);
    expect(readEstates([{ id: "x", kind: "org", accent: "red", plot_indices: [0, 15] }], plots)[0]!.accent).toBeNull();
    expect(readEstates("nope", plots)).toEqual([]);
  });
});

describe("estates: geometry", () => {
  it("fences the outside of the union and never the seam", () => {
    const a = plotForIndex(0);
    const b = plotForIndex(1); // directly east of a
    const faces = estatePerimeter([a, b]);
    // Perimeter of a 16x6 rectangle in tile faces.
    expect(faces).toHaveLength(2 * (PLOT_COLS * 2) + 2 * 6);
    expect(faces.some((f) => f.side === "e" && f.tx === a.x1)).toBe(false);
    expect(faces.some((f) => f.side === "w" && f.tx === b.x0)).toBe(false);
  });

  it("hangs the shared sign on the seam between members", () => {
    const at = estateSignTile([0, 1], plotForIndex);
    expect(at.x).toBe(plotForIndex(1).x0);
    const a = plotForIndex(0);
    expect(at.y).toBe(a.y0 + 3);
  });
});

describe("estates: signs", () => {
  const lexicons = [AOE_LEXICON, SPACE_LEXICON, CITY_LEXICON, SCIFI_LEXICON];

  it("names the estate, else the theme's word, and counts plots", () => {
    for (const lex of lexicons) {
      expect(lex.estate.label).toBeTruthy();
      const named = estateSignContent({ name: "North Field", accent: "#7dd3fc", plots: 3 }, lex);
      expect(named.title).toBe("North Field");
      expect(named.detail).toBe(`${lex.estate.label} · 3 ${lex.estate.plots}`);
      expect(named.held).toBe(false);
      expect(estateSignContent({ name: null, accent: null, plots: 2 }, lex).title).toBe(lex.estate.label);
    }
  });

  it("shows the shared sign further out than plot boards", () => {
    const c = estateSignContent({ name: "North Field", accent: null, plots: 2 }, AOE_LEXICON);
    expect(layoutEstateSign(c, { x: 0, y: 0 }, LOD_ESTATE_SIGN - 0.01, measure)).toBeNull();
    expect(layoutEstateSign(c, { x: 0, y: 0 }, LOD_ESTATE_SIGN, measure)).not.toBeNull();
  });

  it("makes a member plot's own board smaller, with name and access only", () => {
    const plot: SignPlot = {
      preset: "public_write",
      name: "Moth Lab",
      occupancy: 2,
      orgs: [{ name: "Acme", colour: "#34d399" }],
      branding: { accent: "#c4b5fd", signText: "Open late", emblem: null },
    };
    const full = layoutSignboard(signContent(plot, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
    const small = layoutSignboard(signContent(plot, AOE_LEXICON), { x: 200, y: 150 }, 1, measure, { compact: true })!;
    expect(small.lines.map((l) => l.role)).toEqual(["title", "detail"]);
    expect(small.y1 - small.y0).toBeLessThan(full.y1 - full.y0);
    expect(small.lines[0]!.fontPx).toBeLessThan(full.lines[0]!.fontPx);
  });

  it("draws the shared sign and the fence in the estate's accent in every theme, never in hazard colours", () => {
    const hazards = Object.values(HAZARD_COLOUR).map((c) => c.toLowerCase());
    const pairs = [
      [AOE_SIGN, AOE_ESTATE],
      [SPACE_SIGN, SPACE_ESTATE],
      [CITY_SIGN, CITY_ESTATE],
      [SCIFI_SIGN, SCIFI_ESTATE],
    ] as const;
    for (const [sign, estate] of pairs) {
      const board = layoutEstateSign(estateSignContent({ name: "North Field", accent: "#7dd3fc", plots: 2 }, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
      const s = recordingCtx();
      drawEstateSign(s.ctx, board, sign, estate);
      expect(s.inks).toContain("#7dd3fc");
      expect(s.texts).toContain("North Field");
      const f = recordingCtx();
      drawEstateFence(f.ctx, [[0, 0, 32, 16]], "#7dd3fc", estate);
      expect(f.inks).toContain("#7dd3fc");
      const plain = recordingCtx();
      drawEstateFence(plain.ctx, [[0, 0, 32, 16]], null, estate);
      expect(plain.inks).toContain(estate.fence.rail.toLowerCase());
      for (const ink of [...s.inks, ...plain.inks]) expect(hazards).not.toContain(ink);
    }
  });
});
