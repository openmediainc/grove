import { describe, expect, it, vi } from "vitest";
import { estateSignContent, layoutEstateSign, layoutSignboard, signContent, supporterTrim, type SignPlot } from "../lib/signboard";
import { drawEstateSign, drawSignboard, type SignStyle } from "../lib/themes/kit";
import { HAZARD_COLOUR, type Ctx } from "../lib/themes/types";
import { AOE_LEXICON, ESTATE_STYLE as AOE_ESTATE, SIGN_STYLE as AOE_SIGN } from "../lib/themes/aoe";
import { SIGN_STYLE as SPACE_SIGN } from "../lib/themes/space";
import { SIGN_STYLE as CITY_SIGN } from "../lib/themes/city";
import { SIGN_STYLE as SCIFI_SIGN } from "../lib/themes/scifi";

const measure = (text: string, px: number) => (text.length * (px * 6)) / 11;
const base: SignPlot = { preset: "public_write", name: "Moth Lab", occupancy: 1, orgs: [], supporter: true };
const STYLES = { aoe: AOE_SIGN, space: SPACE_SIGN, city: CITY_SIGN, scifi: SCIFI_SIGN } as const;

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

describe("supporter trim decision (#51)", () => {
  it("only a literal true on a non-private plot earns the trim", () => {
    expect(supporterTrim("public_write", true)).toBe(true);
    expect(supporterTrim("public_view", true)).toBe(true);
    // Supporters switched off: the server sends false (or an old payload has no field).
    for (const flag of [false, undefined, null, "true", 1, {}]) expect(supporterTrim("public_write", flag)).toBe(false);
    // Private: never, whatever the payload says.
    expect(supporterTrim("private", true)).toBe(false);
  });

  it("the sign content and layout carry it, and a held board drops it even when forged", () => {
    expect(signContent(base, AOE_LEXICON).supporter).toBe(true);
    expect(signContent({ ...base, supporter: false }, AOE_LEXICON).supporter).toBe(false);
    expect(signContent({ ...base, supporter: undefined }, AOE_LEXICON).supporter).toBe(false);
    const held = signContent({ ...base, preset: "private" }, AOE_LEXICON);
    expect(held.supporter).toBe(false);
    expect(layoutSignboard({ ...held, supporter: true }, { x: 0, y: 0 }, 1, measure)!.supporter).toBe(false);
    expect(layoutSignboard(signContent(base, AOE_LEXICON), { x: 0, y: 0 }, 1, measure)!.supporter).toBe(true);
    expect(layoutSignboard(signContent(base, AOE_LEXICON), { x: 0, y: 0 }, 1, measure, { compact: true })!.supporter).toBe(true);
  });

  it("an estate's shared sign never carries it", () => {
    const c = estateSignContent({ name: "Acme Row", accent: null, plots: 2 }, AOE_LEXICON);
    expect(c.supporter).toBe(false);
    expect(layoutEstateSign({ ...c, supporter: true }, { x: 0, y: 0 }, 1, measure)!.supporter).toBe(false);
  });
});

describe("supporter trim art (#51)", () => {
  it("every theme draws it on a supporter's board, and only there", () => {
    for (const [id, style] of Object.entries(STYLES)) {
      const spy = vi.fn(style.supporterTrim);
      const s: SignStyle = { ...style, supporterTrim: spy };
      const on = layoutSignboard(signContent(base, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
      drawSignboard(recordingCtx().ctx, on, s);
      expect(spy, id).toHaveBeenCalledTimes(1);
      drawSignboard(recordingCtx().ctx, { ...on, supporter: false }, s);
      drawSignboard(recordingCtx().ctx, { ...on, held: true }, s);
      expect(spy, id).toHaveBeenCalledTimes(1);
    }
    const spy = vi.fn();
    const est = layoutEstateSign(estateSignContent({ name: "Row", accent: null, plots: 2 }, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
    drawEstateSign(recordingCtx().ctx, { ...est, supporter: true }, { ...AOE_SIGN, supporterTrim: spy }, AOE_ESTATE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is subtle: its own ink, no text, never a hazard colour", () => {
    const hazards = Object.values(HAZARD_COLOUR).map((c) => c.toLowerCase());
    for (const [id, style] of Object.entries(STYLES)) {
      const { ctx, inks, texts } = recordingCtx();
      style.supporterTrim(ctx, 100, 100, 90, 30);
      expect(inks.length, id).toBeGreaterThan(0);
      expect(texts, id).toEqual([]);
      for (const ink of inks) expect(hazards, `${id} ${ink}`).not.toContain(ink);
      // Adds ink the plain board does not have.
      const plain = recordingCtx();
      const b = layoutSignboard(signContent({ ...base, supporter: false }, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
      drawSignboard(plain.ctx, b, style);
      const trimmed = recordingCtx();
      drawSignboard(trimmed.ctx, { ...b, supporter: true }, style);
      expect(trimmed.inks.length, id).toBeGreaterThan(plain.inks.length);
      expect(trimmed.texts, id).toEqual(plain.texts);
    }
  });
});
