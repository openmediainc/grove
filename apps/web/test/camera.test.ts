import { describe, expect, it } from "vitest";
import { worldBounds } from "@grove/protocol";
import {
  ZOOM_FLOOR,
  centreOn,
  clampPan,
  clampTile,
  fitView,
  fitZoom,
  insetCollapsedDefault,
  insetTransform,
  viewportBox,
  worldCentre,
  zoomRange,
  type Box,
} from "../lib/camera";
import { parseAt, resolveAt } from "../lib/deep-link";

const TW = 64;
const TH = 32;
/** The map's iso projection, for a box the same shape as the real world's. */
function worldBox(plots: number): Box {
  const b = worldBounds(plots);
  const iso = (tx: number, ty: number) => ({ x: (tx - ty) * (TW / 2), y: (tx + ty) * (TH / 2) });
  return {
    minX: iso(b.x0, b.y1).x - TW / 2,
    maxX: iso(b.x1, b.y0).x + TW / 2,
    minY: iso(b.x0, b.y0).y,
    maxY: iso(b.x1, b.y1).y + TH,
  };
}

const PHONE = { w: 390, h: 700 };
const DESKTOP = { w: 1440, h: 860 };

describe("fitZoom / zoomRange", () => {
  it("the whole world fits at min zoom, phone and desktop, small world and huge", () => {
    for (const plots of [0, 16, 200, 500]) {
      const box = worldBox(plots);
      for (const { w, h } of [PHONE, DESKTOP]) {
        const { min, max } = zoomRange(box, w, h, { nominalMin: 0.4, max: 2.5 });
        expect((box.maxX - box.minX) * min).toBeLessThanOrEqual(w);
        expect((box.maxY - box.minY) * min).toBeLessThanOrEqual(h);
        expect(min).toBeGreaterThanOrEqual(ZOOM_FLOOR);
        expect(max).toBeGreaterThanOrEqual(min);
      }
    }
  });
  it("a small world keeps the nominal floor on a desktop", () => {
    const box: Box = { minX: 0, maxX: 500, minY: 0, maxY: 300 };
    expect(zoomRange(box, 1440, 860, { nominalMin: 0.4, max: 2.5 }).min).toBe(0.4);
  });
  it("fit leaves padding on the tight axis", () => {
    const box: Box = { minX: 0, maxX: 1000, minY: 0, maxY: 100 };
    expect(fitZoom(box, 532, 1000, 16)).toBeCloseTo(0.5);
  });
  it("a degenerate viewport cannot ask for zoom 0", () => {
    expect(fitZoom(worldBox(0), 0, 0)).toBe(ZOOM_FLOOR);
  });
});

describe("clampPan", () => {
  const box: Box = { minX: -1000, maxX: 1000, minY: -500, maxY: 500 };
  it("never lets the world be dragged out of view", () => {
    const far = clampPan({ zoom: 1, px: 99_999, py: -99_999 }, box, 400, 300, 140);
    // Left edge of the world no further right than the margin; bottom edge no higher than h - margin.
    expect(box.minX * far.zoom + far.px).toBeLessThanOrEqual(140);
    expect(box.maxY * far.zoom + far.py).toBeGreaterThanOrEqual(300 - 140);
  });
  it("every edge of the world is reachable", () => {
    const right = clampPan({ zoom: 1, px: -99_999, py: 0 }, box, 400, 300, 140);
    // The world's right edge can be brought well inside the viewport.
    expect(box.maxX + right.px).toBeLessThan(400);
    const left = clampPan({ zoom: 1, px: 99_999, py: 0 }, box, 400, 300, 140);
    expect(box.minX + left.px).toBeGreaterThan(0);
  });
  it("centres a world smaller than the viewport", () => {
    const v = clampPan({ zoom: 0.1, px: 5, py: 5 }, box, 400, 300, 140);
    expect(v.px).toBeCloseTo(200);
    expect(v.py).toBeCloseTo(150);
  });
  it("leaves a legal view alone", () => {
    const v = { zoom: 1, px: 0, py: 0 };
    expect(clampPan(v, box, 400, 300, 140)).toEqual(v);
  });
  it("a margin wider than half the viewport still clamps sanely", () => {
    const v = clampPan({ zoom: 1, px: 1e6, py: 0 }, box, 200, 300, 500);
    expect(box.minX + v.px).toBeLessThanOrEqual(100);
  });
});

describe("fitView", () => {
  it("shows the whole box, centred", () => {
    const box = worldBox(40);
    const v = fitView(box, PHONE.w, PHONE.h);
    expect(box.minX * v.zoom + v.px).toBeGreaterThanOrEqual(0);
    expect(box.maxX * v.zoom + v.px).toBeLessThanOrEqual(PHONE.w + 1e-6);
    expect(box.minY * v.zoom + v.py).toBeGreaterThanOrEqual(0);
    expect(box.maxY * v.zoom + v.py).toBeLessThanOrEqual(PHONE.h + 1e-6);
    // Already inside the clamp.
    expect(clampPan(v, box, PHONE.w, PHONE.h, 140).px).toBeCloseTo(v.px);
  });
});

describe("tiles", () => {
  it("clamps a target onto the world", () => {
    const b = worldBounds(0);
    expect(clampTile({ tx: 9999, ty: -9999 }, b)).toEqual({ tx: b.x1, ty: b.y0 });
    expect(clampTile({ tx: 3, ty: 4 }, b)).toEqual({ tx: 3, ty: 4 });
    expect(worldCentre({ x0: -8, y0: -6, x1: 31, y1: 23 })).toEqual({ tx: 11.5, ty: 8.5 });
  });
  it("?at= resolves inside the world it lands on", () => {
    const at = parseAt("400,-300")!;
    const small = worldBounds(0);
    expect(resolveAt(at, small)).toEqual({ tx: small.x1, ty: small.y0 });
    // The same link on a world grown past it is honoured as written.
    const big = worldBounds(20000);
    expect(resolveAt(at, big)).toEqual({ tx: 400, ty: -300 });
    const inside = parseAt("12,9")!;
    expect(resolveAt(inside, small)).toEqual({ tx: 12, ty: 9 });
  });
});

describe("minimap maths", () => {
  it("inset transform round-trips and fits", () => {
    const box = worldBox(30);
    const t = insetTransform(box, 160, 100, 4);
    const a = t.toInset(box.minX, box.minY);
    const b = t.toInset(box.maxX, box.maxY);
    expect(a.x).toBeGreaterThanOrEqual(3.99);
    expect(b.x).toBeLessThanOrEqual(156.01);
    expect(a.y).toBeGreaterThanOrEqual(3.99);
    expect(b.y).toBeLessThanOrEqual(96.01);
    const back = t.fromInset(t.toInset(123, -45).x, t.toInset(123, -45).y);
    expect(back.x).toBeCloseTo(123);
    expect(back.y).toBeCloseTo(-45);
  });
  it("centreOn puts a point mid-viewport, and viewportBox inverts the view", () => {
    const v = centreOn(300, 200, 0.5, 400, 300);
    const vb = viewportBox(v, 400, 300);
    expect((vb.minX + vb.maxX) / 2).toBeCloseTo(300);
    expect((vb.minY + vb.maxY) / 2).toBeCloseTo(200);
    expect(vb.maxX - vb.minX).toBeCloseTo(800);
  });
  it("collapsed: stored choice wins, phones default collapsed", () => {
    expect(insetCollapsedDefault(null, true)).toBe(true);
    expect(insetCollapsedDefault(null, false)).toBe(false);
    expect(insetCollapsedDefault("0", true)).toBe(false);
    expect(insetCollapsedDefault("1", false)).toBe(true);
  });
});
