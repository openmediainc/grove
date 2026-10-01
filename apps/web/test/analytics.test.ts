import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUNNEL_ROWS, cohortPercent, countText, isNewView, mayCountVisit, weekLabel } from "../lib/analytics";

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

describe("funnel rows on the /mod Overview", () => {
  it("puts agents registered and agents claimed right after Sign-ins", () => {
    const i = FUNNEL_ROWS.indexOf("sign_in");
    expect(FUNNEL_ROWS.slice(i, i + 3)).toEqual(["sign_in", "agent_registered", "agent_claimed"]);
  });

  it("is the same list, in the same order, as the server's counters", () => {
    const domain = readFileSync(
      fileURLToPath(new URL("../../../packages/domain/src/services/analytics.ts", import.meta.url)),
      "utf8",
    );
    const list = /export const ANALYTICS_EVENTS = \[([^\]]*)\]/.exec(domain)![1]!;
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...FUNNEL_ROWS]);
  });
});
