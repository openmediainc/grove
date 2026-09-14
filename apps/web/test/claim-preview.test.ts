import { describe, expect, it } from "vitest";
import { plotForIndex } from "@grove/protocol";
import {
  PREVIEW_MAX_ZOOM,
  PREVIEW_MIN_ZOOM,
  createOutcome,
  defaultViewAs,
  draftPlot,
  isoPoint,
  neighbourPlot,
  plotCaption,
  previewCamera,
  previewForPlot,
  previewHeight,
  previewScene,
  previewWindow,
  viewLine,
  type DraftSpace,
} from "../lib/claim-preview";
import { AOE_LEXICON } from "../lib/themes/aoe";
import { SCIFI_LEXICON } from "../lib/themes/scifi";

const branding = { accent: "#7dd3fc", signText: "Open late", emblem: "leaf" as const };
const privateDraft: DraftSpace = { name: "Moth Lab", preset: "private", branding };

describe("private preview redaction", () => {
  it("opens a private space on the visitors' view, a public one on the owner's", () => {
    expect(defaultViewAs("private")).toBe("visitors");
    expect(defaultViewAs("public_view")).toBe("owner");
    expect(defaultViewAs("public_write")).toBe("owner");
  });

  it("as visitors see it: a held plot, no name, sign text, emblem, accent or fence, on a closed building", () => {
    for (const lex of [AOE_LEXICON, SCIFI_LEXICON]) {
      const p = draftPlot(9, privateDraft, "visitors", lex);
      expect(p.access).toBe("private");
      expect(p.fence).toBeNull();
      expect(p.sign.held).toBe(true);
      expect(p.sign.title).toBe(lex.heldPlot);
      expect(p.sign.tagline).toBeNull();
      expect(p.sign.emblem).toBeNull();
      expect(p.sign.accent).toBeNull();
      expect(p.sign.tint).toBeNull();
      expect(JSON.stringify(p)).not.toContain("Moth Lab");
      expect(JSON.stringify(p)).not.toContain("Open late");
    }
  });

  it("as the owner sees it: name and branding, still the closed building and the closed word", () => {
    const p = draftPlot(9, privateDraft, "owner", AOE_LEXICON);
    expect(p.access).toBe("private");
    expect(p.sign.title).toBe("Moth Lab");
    expect(p.sign.tagline).toBe("Open late");
    expect(p.sign.emblem).toBe("leaf");
    expect(p.sign.detail).toBe(AOE_LEXICON.access.private.label);
    expect(p.fence).toBe("#7dd3fc");
  });

  it("a public draft signs like the map would", () => {
    const p = draftPlot(2, { name: "Porch", preset: "public_view", branding }, "owner", AOE_LEXICON);
    expect(p.access).toBe("public_view");
    expect(p.sign.title).toBe("Porch");
    expect(p.sign.tint).toBe("#7dd3fc");
    expect(p.rect).toEqual(plotForIndex(2));
    expect(p.mine).toBe(true);
  });

  it("re-redacts a private neighbour whatever the wire carried", () => {
    const n = neighbourPlot(
      { plot_index: 3, policy_preset: "private", name: "Leaked", orgs: [{ name: "Org", colour: "#123456" }], branding: { accent: "#7dd3fc" } },
      AOE_LEXICON,
    );
    expect(n.sign.held).toBe(true);
    expect(n.fence).toBeNull();
    expect(JSON.stringify(n)).not.toContain("Leaked");
    expect(JSON.stringify(n)).not.toContain("Org");
  });

  it("says who sees what", () => {
    expect(viewLine("private", "visitors")).toMatch(/held plot/);
    expect(viewLine("private", "owner")).toMatch(/Only you/);
    expect(viewLine("public_write", "owner")).toMatch(/Everyone/);
  });
});

describe("scene and camera", () => {
  it("draws the draft once, over its neighbours, back to front", () => {
    const scene = previewScene(
      {
        plot_index: 5,
        neighbours: [
          { plot_index: 4, policy_preset: "public_write", name: "West", orgs: [], branding: null },
          { plot_index: 5, policy_preset: "public_write", name: "Stale self", orgs: [], branding: null },
          { plot_index: 6, policy_preset: "public_view", name: "East", orgs: [], branding: null },
        ],
      },
      { name: "Mine", preset: "public_write", branding: null },
      "owner",
      AOE_LEXICON,
    );
    expect(scene.filter((p) => p.plotIndex === 5)).toHaveLength(1);
    expect(scene.find((p) => p.plotIndex === 5)!.mine).toBe(true);
    const depth = scene.map((p) => p.rect.x1 + p.rect.y1);
    expect([...depth].sort((a, b) => a - b)).toEqual(depth);
  });

  it("centres the target plot and bounds the zoom", () => {
    for (const [w, h] of [
      [358, 222],
      [700, 380],
      [2000, 1200],
    ] as const) {
      const cam = previewCamera(7, w, h);
      expect(cam.zoom).toBeGreaterThanOrEqual(PREVIEW_MIN_ZOOM);
      expect(cam.zoom).toBeLessThanOrEqual(PREVIEW_MAX_ZOOM);
      const r = plotForIndex(7);
      const c = isoPoint((r.x0 + r.x1 + 1) / 2, (r.y0 + r.y1 + 1) / 2);
      expect(c.x * cam.zoom + cam.px).toBeCloseTo(w / 2);
      expect(c.y * cam.zoom + cam.py).toBeCloseTo(h / 2);
    }
    expect(previewHeight(358)).toBeGreaterThanOrEqual(220);
    expect(previewHeight(5000)).toBe(380);
  });

  it("windows the target block and its eight neighbours", () => {
    const w = previewWindow(0);
    const r = plotForIndex(0);
    expect(w.x0).toBeLessThan(r.x0);
    expect(w.x1).toBeGreaterThan(r.x1);
    expect(w.x1 - w.x0 + 1).toBe(24);
    expect(w.y1 - w.y0 + 1).toBe(18);
  });

  it("captions neutrally", () => {
    expect(plotCaption(0)).toBe("Plot 0 · Ring 2");
  });
});

describe("create outcome", () => {
  it("goes straight on when the plot is the previewed one", () => {
    expect(
      createOutcome({ world: { id: "w", slug: "moth", plot_index: 4, policy_preset: "public_write" }, expected_plot_index: 4, plot_changed: false }),
    ).toEqual({ kind: "as_previewed", slug: "moth" });
    expect(createOutcome({ world: { id: "w", slug: "moth", plot_index: 4, policy_preset: "public_write" } }).kind).toBe("as_previewed");
  });

  it("says so when someone claimed the previewed plot first", () => {
    const o = createOutcome({ world: { id: "w", slug: "moth", plot_index: 5, policy_preset: "public_write" }, expected_plot_index: 4, plot_changed: true });
    expect(o).toMatchObject({ kind: "moved", from: 4, to: 5 });
    expect(o.kind === "moved" && o.message).toMatch(/claimed plot 4 first.*plot 5/);
  });

  it("rebuilds neighbours for the plot actually got, redacted, without the space itself", () => {
    const p = previewForPlot(5, [
      { plot_index: 4, policy_preset: "private", name: "Secret", orgs: [], branding: { accent: "#7dd3fc" } },
      { plot_index: 5, policy_preset: "public_write", name: "Mine" },
      { plot_index: 6, policy_preset: "public_view", name: "East", orgs: [] },
    ]);
    expect(p.plot_index).toBe(5);
    expect(p.neighbours.map((n) => n.plot_index)).not.toContain(5);
    const held = p.neighbours.find((n) => n.plot_index === 4);
    if (held) expect(held).toMatchObject({ name: null, branding: null, orgs: [] });
    expect(JSON.stringify(p)).not.toContain("Secret");
  });
});
