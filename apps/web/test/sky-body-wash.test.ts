import { describe, expect, it } from "vitest";
import { BODY_WASH_CAP, bodyWashAlpha, bodyWashErase, skyAt } from "../components/skyClock";

const at = (h: number, m = 0) => Date.UTC(2026, 8, 13, h, m);

describe("bodies stay readable at night (#54)", () => {
  it("caps a body's dimming at ~12% while the world keeps its full wash", () => {
    expect(BODY_WASH_CAP).toBeCloseTo(0.12, 5);
    const deep = skyAt(at(3));
    expect(deep.washAlpha).toBeCloseTo(0.34, 3);
    expect(bodyWashAlpha(deep.washAlpha)).toBe(BODY_WASH_CAP);
    // What the renderer leaves on an opaque body pixel: wash · (1 − erase).
    expect(deep.washAlpha * (1 - bodyWashErase(deep.washAlpha))).toBeCloseTo(BODY_WASH_CAP, 6);
  });

  it("does nothing where the wash is already under the cap (dusk, day)", () => {
    for (const a of [0, 0.004, 0.08, 0.12]) {
      expect(bodyWashErase(a)).toBe(0);
      expect(bodyWashAlpha(a)).toBe(a);
    }
    expect(skyAt(at(19, 30)).washAlpha).toBe(0);
    expect(bodyWashErase(skyAt(at(13)).washAlpha)).toBe(0);
  });

  it("at every minute of the day, a body is dimmed by at most the cap and never more than the world", () => {
    for (let min = 0; min < 24 * 60; min += 1) {
      const sky = skyAt(at(0) + min * 60_000);
      const erase = bodyWashErase(sky.washAlpha);
      expect(erase).toBeGreaterThanOrEqual(0);
      expect(erase).toBeLessThan(1);
      const onBody = sky.washAlpha * (1 - erase);
      expect(onBody).toBeLessThanOrEqual(BODY_WASH_CAP + 1e-9);
      expect(onBody).toBeLessThanOrEqual(sky.washAlpha + 1e-9);
      expect(onBody).toBeCloseTo(bodyWashAlpha(sky.washAlpha), 9);
      // A partly transparent body pixel (an idle or sleeping body) sits between the two.
      const half = sky.washAlpha * (1 - erase * 0.5);
      expect(half).toBeGreaterThanOrEqual(onBody - 1e-9);
      expect(half).toBeLessThanOrEqual(sky.washAlpha + 1e-9);
      // washAlpha agrees with the wash string.
      if (sky.wash) expect(Number(/,([\d.]+)\)$/.exec(sky.wash)![1])).toBeCloseTo(sky.washAlpha, 3);
      else expect(sky.washAlpha).toBe(0);
    }
  });
});
