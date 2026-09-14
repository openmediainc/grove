import { describe, expect, it } from "vitest";
import { COLOR_ROLES, COLORS, MODES, contrast, contrastReport, pairRatio, parseColor } from "../tokens/index.js";

describe("brand token contrast (DECISIONS #7)", () => {
  it("computes WCAG ratios", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrast("#0E1B2B", "#E2542B")).toBeCloseTo(4.57, 2);
  });

  it("every mode defines every role with a parseable value", () => {
    for (const mode of MODES) for (const role of COLOR_ROLES) expect(() => parseColor(COLORS[mode][role])).not.toThrow();
  });

  it("every allowed text pair is AA 4.5:1 and every UI pair 3:1, in light, night and tv", () => {
    const failures = contrastReport()
      .filter((r) => !r.pass)
      .map((r) => `${r.mode}: ${r.use} = ${r.ratio} < ${r.minimum}`);
    expect(failures).toEqual([]);
  });

  it("translucent frost is judged over both black and white map", () => {
    // Worst case must still pass for body text.
    for (const mode of MODES) expect(pairRatio(mode, "ink", "frost")).toBeGreaterThanOrEqual(4.5);
  });

  it("the signal and the fault colour are the same in every mode (not themeable)", () => {
    const signals = new Set(MODES.map((m) => COLORS[m].signal));
    const faults = new Set(MODES.map((m) => COLORS[m].danger));
    expect([...signals]).toEqual(["#E2542B"]);
    expect([...faults]).toEqual(["#f87171"]);
  });

  it("tv raises contrast over night for body and muted text", () => {
    expect(pairRatio("tv", "ink", "ground")).toBeGreaterThan(pairRatio("night", "ink", "ground"));
    expect(pairRatio("tv", "muted", "surface")).toBeGreaterThan(pairRatio("night", "muted", "surface"));
  });
});
