import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MUTED_TEXT_MIN_ALPHA,
  NON_TEXT_MIN,
  TEXT_MIN,
  chromeContrast,
  contrastRatio,
  nextRovingIndex,
  over,
  parseColour,
  relativeLuminance,
  typeaheadIndex,
} from "../lib/a11y";
import { THEME_IDS, THEMES } from "../lib/themes";
import { HAZARD_COLOUR } from "../lib/themes/types";

describe("nextRovingIndex", () => {
  it("moves down and up a vertical menu, wrapping at both ends", () => {
    expect(nextRovingIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextRovingIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextRovingIndex(0, "ArrowUp", 3)).toBe(2);
  });

  it("uses left and right for a horizontal tab strip, and ignores the other axis", () => {
    expect(nextRovingIndex(1, "ArrowRight", 3, "horizontal")).toBe(2);
    expect(nextRovingIndex(0, "ArrowLeft", 3, "horizontal")).toBe(2);
    expect(nextRovingIndex(1, "ArrowDown", 3, "horizontal")).toBeNull();
    expect(nextRovingIndex(1, "ArrowRight", 3, "vertical")).toBeNull();
  });

  it("Home and End jump; nothing focused yet steps in from the nearest end", () => {
    expect(nextRovingIndex(1, "Home", 4)).toBe(0);
    expect(nextRovingIndex(1, "End", 4)).toBe(3);
    expect(nextRovingIndex(-1, "ArrowDown", 4)).toBe(0);
    expect(nextRovingIndex(-1, "ArrowUp", 4)).toBe(3);
  });

  it("lets every other key through, and an empty list goes nowhere", () => {
    expect(nextRovingIndex(0, "Enter", 3)).toBeNull();
    expect(nextRovingIndex(0, "a", 3)).toBeNull();
    expect(nextRovingIndex(0, "ArrowDown", 0)).toBeNull();
  });
});

describe("typeaheadIndex", () => {
  const labels = ["Plaza", "Library", "Workshop", "Legend", "  plots"];
  it("finds the next label starting with the letter, after the current one, wrapping", () => {
    expect(typeaheadIndex(labels, 0, "l")).toBe(1);
    expect(typeaheadIndex(labels, 1, "L")).toBe(3);
    expect(typeaheadIndex(labels, 3, "l")).toBe(1);
    expect(typeaheadIndex(labels, 0, "p")).toBe(4);
  });
  it("answers -1 for no match or a non-character key", () => {
    expect(typeaheadIndex(labels, 0, "z")).toBe(-1);
    expect(typeaheadIndex(labels, 0, " ")).toBe(-1);
    expect(typeaheadIndex([], -1, "a")).toBe(-1);
  });
});

describe("contrast maths (WCAG 2.x)", () => {
  it("parses token triplets and hex", () => {
    expect(parseColour("232 184 109")).toEqual([232, 184, 109]);
    expect(parseColour("#e8b86d")).toEqual([232, 184, 109]);
    expect(parseColour("#fff")).toEqual([255, 255, 255]);
    expect(() => parseColour("rgb(1,2)")).toThrow();
  });

  it("matches the reference values", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 6);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio(parseColour("#767676"), [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("composites alpha over an opaque ground", () => {
    expect(over([255, 255, 255], 0.5, [0, 0, 0])).toEqual([128, 128, 128]);
    expect(over([255, 255, 255], 1, [7, 8, 20])).toEqual([255, 255, 255]);
  });
});

describe("chrome contrast in all four themes", () => {
  it.each(THEME_IDS)("%s: every chrome pair passes (text 4.5:1, focus ring 3:1)", (id) => {
    const checks = chromeContrast(THEMES[id].palette.chrome);
    const failing = checks.filter((c) => !c.ok).map((c) => `${c.pair} = ${c.ratio.toFixed(2)} (needs ${c.min})`);
    expect(failing).toEqual([]);
    expect(checks.some((c) => c.min === TEXT_MIN)).toBe(true);
    expect(checks.some((c) => c.min === NON_TEXT_MIN)).toBe(true);
  });

  it("the focus ring is never a hazard colour", () => {
    for (const id of THEME_IDS) {
      const ring = parseColour(THEMES[id].palette.chrome.lantern400);
      for (const hazard of Object.values(HAZARD_COLOUR)) {
        expect(ring).not.toEqual(parseColour(hazard));
      }
    }
  });
});

/** Every tsx file under app/ and components/. */
function sources(): string[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(p);
    }
  };
  walk(join(root, "app"));
  walk(join(root, "components"));
  return out;
}

describe("muted text floor", () => {
  it(`no text in app/ or components/ is fainter than white/${MUTED_TEXT_MIN_ALPHA * 100} (disabled states excepted)`, () => {
    const floor = MUTED_TEXT_MIN_ALPHA * 100;
    const faint: string[] = [];
    for (const file of sources()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?<![\w/-])((?:[a-z-]+:)*)text-white\/(\d+)(?![\d\]])/g)) {
        if (m[1]!.includes("disabled:")) continue;
        if (Number(m[2]) < floor) faint.push(`${file.split("/apps/web/")[1] ?? file}: ${m[0]}`);
      }
    }
    expect(faint).toEqual([]);
  });
});
