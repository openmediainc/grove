import { describe, expect, it } from "vitest";
import { compare, routeFiles } from "../scripts/perf-budget.mjs";

describe("perf budget (#68)", () => {
  it("counts a route's page chunks plus the root layout, once each, JS only", () => {
    const pages = {
      "/page": ["static/chunks/a.js", "static/chunks/b.js", "static/css/x.css"],
      "/layout": ["static/chunks/a.js", "static/chunks/layout.js"],
    };
    expect(routeFiles(pages, "/page")).toEqual(["static/chunks/a.js", "static/chunks/b.js", "static/chunks/layout.js"]);
    expect(routeFiles(pages, "/missing")).toEqual(["static/chunks/a.js", "static/chunks/layout.js"]);
  });

  it("fails only when an enforced route grows past the tolerance", () => {
    const base = { "/": 100_000, "/me": 50_000 };
    expect(compare({ "/": 110_000, "/me": 50_000 }, base).ok).toBe(true);
    expect(compare({ "/": 110_001, "/me": 50_000 }, base).ok).toBe(false);
    const warnOnly = compare({ "/": 90_000, "/me": 80_000 }, base);
    expect(warnOnly.ok).toBe(true);
    expect(warnOnly.rows.find((r: { route: string }) => r.route === "/me")).toMatchObject({ over: true, enforced: false });
  });

  it("passes a route with no baseline yet", () => {
    const r = compare({ "/": 1, "/new": 5 }, { "/": 1 });
    expect(r.ok).toBe(true);
    expect(r.rows[1]).toMatchObject({ was: null, limit: null, over: false });
  });
});
