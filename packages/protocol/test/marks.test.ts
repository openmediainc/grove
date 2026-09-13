import { describe, expect, it } from "vitest";
import { longestDayStreak, normaliseMarks, SPACE_MARKS } from "../src/marks.js";

describe("space marks", () => {
  it("publishes keys only, in canonical order, dropping unknowns and duplicates", () => {
    expect(normaliseMarks(["week_streak", "points", "thousand_calls", "week_streak"])).toEqual([
      "thousand_calls",
      "week_streak",
    ]);
    expect(normaliseMarks(null)).toEqual([]);
    expect(normaliseMarks("thousand_calls")).toEqual([]);
    expect(SPACE_MARKS).toEqual(["thousand_calls", "week_streak", "trial"]);
  });

  it("counts a streak as consecutive UTC days, not days in a window", () => {
    const week = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"];
    expect(longestDayStreak(week)).toBe(7);
    expect(longestDayStreak([...week].reverse().concat("2026-09-03"))).toBe(7);
    // A gap breaks it, however many days are around it.
    expect(longestDayStreak(week.filter((d) => d !== "2026-09-04"))).toBe(3);
    // Across a month end.
    expect(longestDayStreak(["2026-08-30", "2026-08-31", "2026-09-01"])).toBe(3);
    expect(longestDayStreak([])).toBe(0);
  });
});
