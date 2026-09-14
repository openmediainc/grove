import { describe, expect, it } from "vitest";
import { worldBounds } from "@grove/protocol";
import { clampPan, fitZoom, viewportBox, type Box, type CameraView } from "../lib/camera";
import {
  DEPTH_ANGLE,
  DEPTH_ANGLE_MAX,
  DEPTH_ANGLE_MIN,
  PARALLAX_MAX,
  aimScreenY,
  clampPanTilted,
  depthPreference,
  easeTilt,
  fitZoomTilted,
  focusOf,
  fromScreen,
  groundTransform,
  perspectiveScale,
  shadowSpec,
  stepParallax,
  tiltFor,
  tiltY,
  toScreen,
  untiltY,
  viewportBoxTilted,
  zoomRangeTilted,
} from "../lib/depth";

const TW = 64;
const TH = 32;
const iso = (tx: number, ty: number) => ({ x: (tx - ty) * (TW / 2), y: (tx + ty) * (TH / 2) });
const unIso = (x: number, y: number) => ({ tx: (x / (TW / 2) + y / (TH / 2)) / 2, ty: (y / (TH / 2) - x / (TW / 2)) / 2 });

function worldBox(plots: number): Box {
  const b = worldBounds(plots);
  return {
    minX: iso(b.x0, b.y1).x - TW / 2,
    maxX: iso(b.x1, b.y0).x + TW / 2,
    minY: iso(b.x0, b.y0).y,
    maxY: iso(b.x1, b.y1).y + TH,
  };
}

const W = 1440;
const H = 900;
const KS = [tiltFor(DEPTH_ANGLE_MIN), tiltFor(30), tiltFor(DEPTH_ANGLE_MAX)];

describe("tilt", () => {
  it("is 1 at the flat 30° and spans flatter to steeper across the range", () => {
    expect(tiltFor(30)).toBeCloseTo(1, 10);
    expect(tiltFor(DEPTH_ANGLE_MIN)).toBeLessThan(1);
    expect(tiltFor(DEPTH_ANGLE_MAX)).toBeGreaterThan(1);
    expect(tiltFor(0)).toBe(tiltFor(DEPTH_ANGLE_MIN));
    expect(tiltFor(90)).toBe(tiltFor(DEPTH_ANGLE_MAX));
    expect(DEPTH_ANGLE).toBeGreaterThanOrEqual(DEPTH_ANGLE_MIN);
    expect(DEPTH_ANGLE).toBeLessThanOrEqual(DEPTH_ANGLE_MAX);
  });

  it("tiltY and untiltY are exact inverses and fix the focus row", () => {
    for (const k of KS) {
      for (const y of [-900, 0, 13.5, 4000]) expect(untiltY(tiltY(y, 250, k), 250, k)).toBeCloseTo(y, 9);
      expect(tiltY(250, 250, k)).toBe(250);
    }
    expect(tiltY(77, 3, 1)).toBe(77);
  });

  it("is off by default; only an explicit on is remembered", () => {
    expect(depthPreference(null)).toBe(false);
    expect(depthPreference("0")).toBe(false);
    expect(depthPreference("yes")).toBe(false);
    expect(depthPreference("1")).toBe(true);
  });
});

describe("screen <-> layout (hit-testing round trip)", () => {
  const views: CameraView[] = [
    { zoom: 1, px: 0, py: 0 },
    { zoom: 0.37, px: 512.25, py: -80 },
    { zoom: 2.4, px: -3100, py: -1900.5 },
  ];

  it("fromScreen inverts toScreen for every tilt and view", () => {
    for (const k of KS)
      for (const v of views)
        for (const [x, y] of [[0, 0], [123.4, -56.7], [-2000, 3000]] as const) {
          const s = toScreen(v, W, H, k, x, y);
          const back = fromScreen(v, W, H, k, s.x, s.y);
          expect(back.x).toBeCloseTo(x, 7);
          expect(back.y).toBeCloseTo(y, 7);
        }
  });

  it("a click lands on the tile it was drawn on (iso + tilt round trip)", () => {
    const k = tiltFor(DEPTH_ANGLE);
    const v = { zoom: 0.8, px: 210, py: -140 };
    const ox = 400;
    const oy = 24;
    for (const [tx, ty] of [[11, 8], [0, 0], [-6, 23], [40, -3]] as const) {
      // The centre of the tile's diamond, as drawn on the tilted ground.
      const q = iso(tx + 0.5, ty + 0.5);
      const s = toScreen(v, W, H, k, ox + q.x, oy + q.y);
      const l = fromScreen(v, W, H, k, s.x, s.y);
      const t = unIso(l.x - ox, l.y - oy);
      expect(Math.floor(t.tx)).toBe(tx);
      expect(Math.floor(t.ty)).toBe(ty);
    }
  });

  it("the screen centre is the same layout point flat or tilted (shots and links are mode-free)", () => {
    for (const k of KS)
      for (const v of views) {
        const flat = fromScreen(v, W, H, 1, W / 2, H / 2);
        const tilted = fromScreen(v, W, H, k, W / 2, H / 2);
        expect(tilted.x).toBeCloseTo(flat.x, 9);
        expect(tilted.y).toBeCloseTo(flat.y, 9);
        const f = focusOf(v, W, H);
        expect(f.fx).toBeCloseTo(flat.x, 9);
      }
  });

  it("the ground transform draws raw layout exactly where the upright layer places it", () => {
    for (const k of KS)
      for (const v of views) {
        const [a, , , d, e, f] = groundTransform(v, W, H, k);
        for (const [x, y] of [[10, 20], [-700, 1300]] as const) {
          const s = toScreen(v, W, H, k, x, y);
          expect(a * x + e).toBeCloseTo(s.x, 7);
          expect(d * y + f).toBeCloseTo(s.y, 7);
        }
      }
    // Flat: exactly the old transform.
    expect(groundTransform({ zoom: 2, px: 5, py: 7 }, W, H, 1)).toEqual([2, 0, 0, 2, 5, 7]);
    const lagged = groundTransform({ zoom: 2, px: 5, py: 7 }, W, H, 1, { x: 3, y: -4 });
    expect(lagged[4]).toBe(8);
    expect(lagged[5]).toBe(3);
  });

  it("aimScreenY puts a followed row where it was wanted once tilted", () => {
    for (const k of KS) {
      const zoom = 1.3;
      const y = 612;
      for (const want of [H / 2, 300, 700]) {
        const py = aimScreenY(want, H, k) - y * zoom;
        const s = toScreen({ zoom, px: 0, py }, W, H, k, 0, y);
        expect(s.y).toBeCloseTo(want, 7);
      }
    }
  });
});

describe("camera bounds under tilt (#38 still holds)", () => {
  it("is the flat camera exactly when k = 1", () => {
    const box = worldBox(200);
    const v = { zoom: 0.6, px: 9000, py: -9000 };
    expect(clampPanTilted(v, box, W, H, 48, 1)).toEqual(clampPan(v, box, W, H, 48));
    expect(viewportBoxTilted(v, W, H, 1)).toEqual(viewportBox(v, W, H));
    expect(fitZoomTilted(box, W, H, 1)).toBe(fitZoom(box, W, H));
  });

  it("zoomed right out, the whole tilted world fits a phone and a desktop", () => {
    for (const plots of [0, 60, 800])
      for (const [w, h] of [[390, 700], [1440, 900]] as const)
        for (const k of KS) {
          const box = worldBox(plots);
          const { min } = zoomRangeTilted(box, w, h, k, { nominalMin: 0.4, max: 3 });
          expect((box.maxX - box.minX) * min).toBeLessThanOrEqual(w + 1e-6);
          expect((box.maxY - box.minY) * min * k).toBeLessThanOrEqual(h + 1e-6);
        }
  });

  it("a clamped tilted pan keeps the world's edge within the margin on screen", () => {
    const box = worldBox(400);
    const margin = 48;
    for (const k of KS)
      for (const v of [{ zoom: 1, px: 99999, py: 99999 }, { zoom: 1, px: -99999, py: -99999 }]) {
        const c = clampPanTilted(v, box, W, H, margin, k);
        const top = toScreen(c, W, H, k, 0, box.minY).y;
        const bottom = toScreen(c, W, H, k, 0, box.maxY).y;
        const left = toScreen(c, W, H, k, box.minX, 0).x;
        const right = toScreen(c, W, H, k, box.maxX, 0).x;
        expect(top).toBeLessThanOrEqual(margin + 1e-6);
        expect(bottom).toBeGreaterThanOrEqual(H - margin - 1e-6);
        expect(left).toBeLessThanOrEqual(margin + 1e-6);
        expect(right).toBeGreaterThanOrEqual(W - margin - 1e-6);
      }
  });

  it("the minimap rectangle is exactly what the tilted viewport shows", () => {
    const k = tiltFor(DEPTH_ANGLE);
    const v = { zoom: 0.9, px: -300, py: 120 };
    const vb = viewportBoxTilted(v, W, H, k);
    const tl = toScreen(v, W, H, k, vb.minX, vb.minY);
    const br = toScreen(v, W, H, k, vb.maxX, vb.maxY);
    expect(tl.x).toBeCloseTo(0, 7);
    expect(tl.y).toBeCloseTo(0, 7);
    expect(br.x).toBeCloseTo(W, 7);
    expect(br.y).toBeCloseTo(H, 7);
    // A flatter ground shows more of the world top to bottom.
    const flat = viewportBox(v, W, H);
    expect(vb.maxY - vb.minY).toBeGreaterThan(flat.maxY - flat.minY);
  });
});

describe("parallax", () => {
  it("trails a pan, is capped, and settles back to rest", () => {
    let lag = { x: 0, y: 0 };
    for (let i = 0; i < 30; i++) lag = stepParallax(lag, { x: 60, y: -40 }, 16, false);
    expect(lag.x).toBeGreaterThan(0);
    expect(lag.y).toBeLessThan(0);
    expect(Math.abs(lag.x)).toBeLessThanOrEqual(PARALLAX_MAX);
    expect(Math.abs(lag.y)).toBeLessThanOrEqual(PARALLAX_MAX);
    for (let i = 0; i < 120; i++) lag = stepParallax(lag, { x: 0, y: 0 }, 16, false);
    expect(lag).toEqual({ x: 0, y: 0 });
  });

  it("leaves no trail under reduced motion or across a cut", () => {
    expect(stepParallax({ x: 5, y: 5 }, { x: 30, y: 0 }, 16, true)).toEqual({ x: 0, y: 0 });
    expect(stepParallax({ x: 5, y: 5 }, { x: 4000, y: 0 }, 16, false)).toEqual({ x: 0, y: 0 });
  });

  it("the tilt eases in, and snaps under reduced motion", () => {
    const k = tiltFor(DEPTH_ANGLE);
    const mid = easeTilt(1, k, 16, false);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(k);
    let cur = 1;
    for (let i = 0; i < 200; i++) cur = easeTilt(cur, k, 16, false);
    expect(cur).toBe(k);
    expect(easeTilt(1, k, 16, true)).toBe(k);
  });
});

describe("height cues", () => {
  it("far art shrinks a little, near art never grows", () => {
    expect(perspectiveScale(H, H, 1)).toBe(1);
    expect(perspectiveScale(H / 2, H, 1)).toBe(1);
    expect(perspectiveScale(0, H, 1)).toBeLessThan(1);
    expect(perspectiveScale(0, H, 1)).toBeGreaterThan(0.9);
    expect(perspectiveScale(-500, H, 1)).toBe(perspectiveScale(0, H, 1));
    expect(perspectiveScale(0, H, 0)).toBe(1);
  });

  it("taller layers throw bigger, darker shadows that lie on the tilted ground", () => {
    const tile = { w: TW, h: TH };
    const k = tiltFor(DEPTH_ANGLE);
    const prop = shadowSpec({ fw: 1, fh: 1 }, "prop", k, tile);
    const body = shadowSpec({ fw: 1, fh: 1 }, "body", k, tile);
    const building = shadowSpec({ fw: 3, fh: 3 }, "building", k, tile);
    expect(building.rx).toBeGreaterThan(prop.rx);
    expect(building.alpha).toBeGreaterThan(body.alpha);
    expect(body.alpha).toBeGreaterThan(prop.alpha);
    expect(shadowSpec({ fw: 1, fh: 1 }, "prop", 1, tile).ry / prop.ry).toBeCloseTo(1 / k, 9);
    for (const s of [prop, body, building]) expect(s.alpha).toBeLessThanOrEqual(0.5);
  });
});
