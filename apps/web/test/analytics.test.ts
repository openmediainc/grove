import { describe, expect, it } from "vitest";
import { cohortPercent, countText, isNewView, mayCountVisit, weekLabel } from "../lib/analytics";

describe("page-view beacon", () => {
  it("honours Do Not Track and Global Privacy Control", () => {
    expect(mayCountVisit({ doNotTrack: "1" })).toBe(false);
    expect(mayCountVisit({ doNotTrack: "yes" })).toBe(false);
    expect(mayCountVisit({ globalPrivacyControl: true })).toBe(false);
    expect(mayCountVisit({}, { doNotTrack: "1" })).toBe(false);
    expect(mayCountVisit({ doNotTrack: "0" })).toBe(true);
    expect(mayCountVisit({ doNotTrack: null, globalPrivacyControl: false })).toBe(true);
  });

  it("skips automation and a missing navigator", () => {
    expect(mayCountVisit({ webdriver: true })).toBe(false);
    expect(mayCountVisit(undefined)).toBe(false);
  });

  it("counts a pathname once until it changes", () => {
    expect(isNewView(null, "/")).toBe(true);
    expect(isNewView("/", "/")).toBe(false);
    expect(isNewView("/", "/explore")).toBe(true);
    expect(isNewView("/", null)).toBe(false);
  });
});

describe("funnel card formatting", () => {
  it("cohort percentages never divide by zero or exceed 100", () => {
    expect(cohortPercent(0, 0)).toBe("–");
    expect(cohortPercent(1, 3)).toBe("33%");
    expect(cohortPercent(5, 4)).toBe("100%");
  });

  it("counts and week labels", () => {
    expect(countText(3)).toBe("3");
    expect(countText(2.5)).toBe("2.5");
    expect(weekLabel("2026-09-07")).toBe("7 Sep");
  });
});
