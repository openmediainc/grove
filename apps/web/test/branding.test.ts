import { describe, expect, it } from "vitest";
import { SIGN_BOARD_COLOURS, type SpaceBranding } from "@grove/protocol";
import { EMBLEM_PX, layoutSignboard, plotBranding, plotEdgeColour, signContent, type SignPlot } from "../lib/signboard";
import { brandingDraft, checkDraft, draftToBody, paletteKeyOf, previewPlot } from "../lib/branding";
import { drawSignboard } from "../lib/themes/kit";
import { AOE_LEXICON, SIGN_STYLE as AOE_SIGN } from "../lib/themes/aoe";
import { SIGN_STYLE as SPACE_SIGN } from "../lib/themes/space";
import { SIGN_STYLE as CITY_SIGN } from "../lib/themes/city";
import { SIGN_STYLE as SCIFI_SIGN } from "../lib/themes/scifi";
import type { Ctx } from "../lib/themes/types";

const measure = (text: string, px: number) => text.length * (px * 6) / 11;
const acme = { name: "Acme", colour: "#34d399" };
const brand: SpaceBranding = { accent: "#c4b5fd", signText: "Open late", emblem: "anchor" };
const base: SignPlot = { preset: "public_write", name: "Moth Lab", occupancy: 2, orgs: [acme], branding: brand };

/** A 2D context that records every colour it is asked to paint with. */
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

describe("signboard branding", () => {
  it("owner accent wins the stripe; the org stays as a secondary stripe", () => {
    const c = signContent(base, AOE_LEXICON);
    expect(c.tint).toBe("#c4b5fd");
    expect(c.secondaryTint).toBe("#34d399");
    expect(c.tagline).toBe("Open late");
    expect(c.emblem).toBe("anchor");
    expect(signContent({ ...base, branding: null }, AOE_LEXICON)).toMatchObject({ tint: "#34d399", secondaryTint: null, emblem: null });
    expect(signContent({ ...base, orgs: [] }, AOE_LEXICON)).toMatchObject({ tint: "#c4b5fd", secondaryTint: null });
    expect(plotEdgeColour(base)).toBe("#c4b5fd");
    expect(plotEdgeColour({ ...base, branding: null })).toBe("#34d399");
  });

  it("lays out the sign text under the name and the emblem inside the board, left of the text", () => {
    const board = layoutSignboard(signContent(base, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
    expect(board.lines.map((l) => l.role)).toEqual(["title", "tagline", "detail", "org"]);
    const e = board.emblem!;
    expect(e).toMatchObject({ key: "anchor", size: EMBLEM_PX, colour: "#c4b5fd" });
    expect(e.cx - e.size / 2).toBeGreaterThanOrEqual(board.x0);
    expect(e.cy - e.size / 2).toBeGreaterThanOrEqual(board.y0);
    expect(e.cy + e.size / 2).toBeLessThanOrEqual(board.y1);
    expect(board.tx).toBeGreaterThan((board.x0 + board.x1) / 2);
    // Every line still fits beside the emblem.
    for (const l of board.lines) expect(measure(l.text, l.fontPx)).toBeLessThanOrEqual(board.x1 - (e.cx + e.size / 2));
  });

  it("never brands a private plot: no accent, emblem or sign text, even from a forged payload", () => {
    const priv = { ...base, preset: "private" };
    const c = signContent(priv, AOE_LEXICON);
    expect([c.tint, c.secondaryTint, c.emblem, c.tagline, c.accent]).toEqual([null, null, null, null, null]);
    expect(plotEdgeColour({ ...priv, orgs: [] })).toBeNull();
    expect(plotBranding("private", brand)).toBeNull();
    expect(plotBranding("public_view", { accent: "#000000", sign_text: "Hi", emblem: "anchor" })).toEqual({
      accent: null,
      signText: "Hi",
      emblem: "anchor",
    });

    // Held wins over the content handed to the layout, and over the board handed to the kit.
    const forged = layoutSignboard({ ...c, tint: "#c4b5fd", secondaryTint: "#34d399", emblem: "anchor", accent: "#c4b5fd", tagline: "Open late" }, { x: 0, y: 0 }, 1, measure)!;
    expect(forged.emblem).toBeNull();
    expect(forged.tint).toBeNull();
    expect(forged.lines.map((l) => l.role)).not.toContain("tagline");
    const { ctx, inks, texts } = recordingCtx();
    drawSignboard(ctx, { ...forged, tint: "#c4b5fd", secondaryTint: "#34d399", emblem: { key: "anchor", cx: 0, cy: 0, size: 12, colour: "#c4b5fd" } }, AOE_SIGN);
    expect(inks).not.toContain("#c4b5fd");
    expect(inks).not.toContain("#34d399");
    expect(texts.join(" ")).not.toContain("Open late");
  });

  it("paints the accent, the org stripe and the emblem on a public board in every theme", () => {
    for (const style of [AOE_SIGN, SPACE_SIGN, CITY_SIGN, SCIFI_SIGN]) {
      const board = layoutSignboard(signContent(base, AOE_LEXICON), { x: 200, y: 150 }, 1, measure)!;
      const { ctx, inks, texts } = recordingCtx();
      drawSignboard(ctx, board, style);
      expect(inks).toContain("#c4b5fd");
      expect(inks).toContain("#34d399");
      expect(texts).toContain("Open late");
    }
  });

  it("the protocol's board colours are the themes' boards, so contrast is checked against what is drawn", () => {
    const rgbOf = (c: string) => {
      const hex = /^#([0-9a-f]{6})$/i.exec(c);
      if (hex) {
        const n = parseInt(hex[1]!, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      return /rgba?\(([^)]+)\)/.exec(c)![1]!.split(",").slice(0, 3).map((x) => Number(x.trim()));
    };
    const styles = { aoe: AOE_SIGN, space: SPACE_SIGN, city: CITY_SIGN, scifi: SCIFI_SIGN };
    for (const [id, style] of Object.entries(styles)) {
      expect(rgbOf(style.board), id).toEqual(rgbOf(SIGN_BOARD_COLOURS[id as keyof typeof SIGN_BOARD_COLOURS]));
    }
  });
});

describe("Manage branding editor", () => {
  it("round-trips a draft and reports refusals as the server would", () => {
    const d = brandingDraft({ accent: "#7dd3fc", sign_text: "Hi", emblem: "moon" });
    expect(d).toEqual({ accent: "#7dd3fc", signText: "Hi", emblem: "moon" });
    expect(draftToBody({ accent: " ", signText: "", emblem: null })).toEqual({ accent: null, sign_text: null, emblem: null });
    expect(brandingDraft(null)).toEqual({ accent: "", signText: "", emblem: null });
    expect(paletteKeyOf("#7DD3FC")).toBe("sky");

    const bad = checkDraft({ accent: "#222222", signText: "x".repeat(30), emblem: "star" });
    expect(bad.accentError).toMatch(/too dark/);
    expect(bad.signTextError).toMatch(/at most 24/);
    expect(bad.signTextCount).toBe(30);
    // The preview only draws what would be accepted.
    expect(bad.valid).toEqual({ accent: null, signText: null, emblem: "star" });
  });

  it("previews a private space as it would look once opened", () => {
    expect(previewPlot({ name: "Den", policy_preset: "private" }, [], brand).preset).toBe("public_view");
    expect(previewPlot({ name: "Den", policy_preset: "public_write" }, [], brand).preset).toBe("public_write");
  });
});
