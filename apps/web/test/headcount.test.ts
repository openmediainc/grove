import { describe, expect, it } from "vitest";
import { formatHeadcount, makeWatchToken } from "../lib/headcount";
import { AOE_LEXICON } from "../lib/themes/aoe";
import { SPACE_LEXICON } from "../lib/themes/space";
import { CITY_LEXICON } from "../lib/themes/city";
import { SCIFI_LEXICON } from "../lib/themes/scifi";

const words = { hereNow: "here now", watching: "watching" };

describe("headcount pill", () => {
  it("says both counts", () => {
    expect(formatHeadcount({ here: 3, watching: 12 }, words)).toBe("3 here now · 12 watching");
  });

  it("drops watching when the server could not count", () => {
    expect(formatHeadcount({ here: 2, watching: null }, words)).toBe("2 here now");
  });

  it("shows the cap as N+", () => {
    expect(formatHeadcount({ here: 0, watching: 500, cap: 500 }, words)).toBe("0 here now · 500+ watching");
  });

  it("clamps nonsense", () => {
    expect(formatHeadcount({ here: -1, watching: 2.7 }, words)).toBe("0 here now · 2 watching");
  });

  it("tokens are opaque, url-safe and differ per tab", () => {
    const a = makeWatchToken();
    const b = makeWatchToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
  });

  it("every theme names both counts", () => {
    for (const t of [AOE_LEXICON, SPACE_LEXICON, CITY_LEXICON, SCIFI_LEXICON]) {
      expect(t.hud.hereNow.length).toBeGreaterThan(0);
      expect(t.hud.watching.length).toBeGreaterThan(0);
    }
  });
});
