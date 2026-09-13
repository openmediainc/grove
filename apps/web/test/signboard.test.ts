import { describe, expect, it } from "vitest";
import {
  LOD_SIGNBOARD,
  fitSignText,
  MARK_R,
  layoutSignboard,
  signContent,
  signboardVisible,
  type SignPlot,
} from "../lib/signboard";
import { aoe, AOE_LEXICON } from "../lib/themes/aoe";
import { space, SPACE_LEXICON } from "../lib/themes/space";
import { city, CITY_LEXICON } from "../lib/themes/city";
import { scifi, SCIFI_LEXICON } from "../lib/themes/scifi";

/** 6px per character at 11px, scaled by font size: deterministic stand-in for measureText. */
const measure = (text: string, px: number) => text.length * (px * 6) / 11;

const acme = { name: "Acme", colour: "#34d399" };
const base: SignPlot = { preset: "public_write", name: "Moth Lab", occupancy: 2, orgs: [acme] };

describe("signboard content", () => {
  it("names a public plot, with access, headcount, orgs and the org tint", () => {
    const c = signContent(base, AOE_LEXICON);
    expect(c.held).toBe(false);
    expect(c.title).toBe("Moth Lab");
    expect(c.detail).toBe(`${AOE_LEXICON.access.public_write.label} · 2 here`);
    expect(c.orgLine).toBe("Acme");
    expect(c.tint).toBe("#34d399");
    expect(c.marks).toEqual([]);
  });

  it("never names a private plot, even when the server sent the name", () => {
    const c = signContent({ preset: "private", name: "Secret Garden", occupancy: 5, orgs: [acme] }, AOE_LEXICON);
    expect(c).toEqual({
      held: true,
      title: "Held plot",
      detail: AOE_LEXICON.access.private.label,
      orgLine: null,
      tint: null,
      marks: [],
    });
    const board = layoutSignboard(c, { x: 100, y: 100 }, 1, measure)!;
    const text = board.lines.map((l) => l.text).join(" ");
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("5 here");
    expect(board.tint).toBeNull();
  });

  it("falls back to the claimed word for an unnamed public plot", () => {
    const c = signContent({ ...base, name: "  ", orgs: [] }, CITY_LEXICON);
    expect(c.title).toBe(CITY_LEXICON.claimedPlot);
    expect(c.orgLine).toBeNull();
    expect(c.tint).toBeNull();
  });

  it("every theme has a held-plot word and a signboard slot", () => {
    for (const [theme, lex] of [
      [aoe, AOE_LEXICON],
      [space, SPACE_LEXICON],
      [city, CITY_LEXICON],
      [scifi, SCIFI_LEXICON],
    ] as const) {
      expect(lex.heldPlot).toMatch(/^Held /);
      expect(typeof theme.art.signboard).toBe("function");
    }
  });
});

describe("signboard layout", () => {
  it("is hidden below the zoom threshold", () => {
    expect(signboardVisible(LOD_SIGNBOARD - 0.01)).toBe(false);
    expect(signboardVisible(LOD_SIGNBOARD)).toBe(true);
    expect(layoutSignboard(signContent(base, AOE_LEXICON), { x: 0, y: 0 }, 0.4, measure)).toBeNull();
  });

  it("centres the board on the anchor and keeps the same text size at every zoom", () => {
    const c = signContent(base, AOE_LEXICON);
    const near = layoutSignboard(c, { x: 200, y: 150 }, 2, measure)!;
    const far = layoutSignboard(c, { x: 200, y: 150 }, 0.6, measure)!;
    expect(Math.abs((near.x0 + near.x1) / 2 - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs((near.y0 + near.y1) / 2 - 150)).toBeLessThanOrEqual(1);
    expect(near.lines[0]!.fontPx).toBe(far.lines[0]!.fontPx);
    // The org line only shows once zoomed in far enough to read it.
    expect(near.lines.map((l) => l.role)).toEqual(["title", "detail", "org"]);
    expect(far.lines.map((l) => l.role)).toEqual(["title", "detail"]);
  });

  it("clips a long name with an ellipsis to fit its building", () => {
    const long = signContent({ ...base, name: "An Extremely Long Space Name That Keeps Going" }, AOE_LEXICON);
    const board = layoutSignboard(long, { x: 0, y: 0 }, 0.6, measure)!;
    const title = board.lines[0]!;
    expect(title.text.endsWith("…")).toBe(true);
    expect(board.x1 - board.x0).toBeLessThanOrEqual(Math.round(3 * 64 * 0.6 * 0.8));
    expect(measure(title.text, title.fontPx)).toBeLessThanOrEqual(board.x1 - board.x0);
  });

  it("fitSignText leaves short text alone and returns empty when nothing fits", () => {
    expect(fitSignText("Hi", 100, 11, measure)).toBe("Hi");
    expect(fitSignText("Hello", 3, 11, measure)).toBe("");
  });
});

describe("signboard marks", () => {
  it("hangs one medallion per held mark under a public board, in canonical order, unknown keys dropped", () => {
    const c = signContent({ ...base, marks: ["week_streak", "top_ten", "thousand_calls"] }, AOE_LEXICON);
    expect(c.marks).toEqual(["thousand_calls", "week_streak"]);
    const board = layoutSignboard(c, { x: 200, y: 150 }, 1, measure)!;
    expect(board.marks.map((m) => m.key)).toEqual(["thousand_calls", "week_streak"]);
    const [a, b] = board.marks;
    // Centred under the board, below its middle, same fixed size at every zoom.
    expect(Math.abs((a!.x + b!.x) / 2 - (board.x0 + board.x1) / 2)).toBeLessThanOrEqual(1);
    expect(a!.y).toBeGreaterThan(board.y1 - MARK_R);
    expect(a!.r).toBe(MARK_R);
    expect(layoutSignboard(c, { x: 200, y: 150 }, 2, measure)!.marks[0]!.r).toBe(MARK_R);
  });

  it("never marks a private plot, even when the server sent marks", () => {
    const c = signContent({ preset: "private", name: null, occupancy: 0, orgs: [], marks: ["thousand_calls", "week_streak"] }, AOE_LEXICON);
    expect(c.marks).toEqual([]);
    expect(layoutSignboard(c, { x: 0, y: 0 }, 1, measure)!.marks).toEqual([]);
    // Held wins over the content, too.
    const forged = layoutSignboard({ ...c, marks: ["thousand_calls"] }, { x: 0, y: 0 }, 1, measure)!;
    expect(forged.marks).toEqual([]);
  });

  it("every theme names both marks, with no numbers that could read as a score", () => {
    for (const lex of [AOE_LEXICON, SPACE_LEXICON, CITY_LEXICON, SCIFI_LEXICON]) {
      expect(lex.marks.heading).toBeTruthy();
      expect(lex.marks.thousand_calls).toBeTruthy();
      expect(lex.marks.week_streak).toBeTruthy();
      expect(`${lex.marks.heading} ${lex.marks.thousand_calls} ${lex.marks.week_streak}`).not.toMatch(/points|rank|score|level/i);
    }
  });
});
