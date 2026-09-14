import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPEARANCE_CHOICES, APPEARANCE_LABEL, BRANDED_ROUTES, isBrandedRoute } from "@/lib/appearance";
import { BADGE_CLASS, CHECKBOX_CLASS, ICON_BUTTON_CLASS, SELECT_CLASS, navLinkClass } from "@/lib/brand-ui";

const web = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

describe("global chrome on brand tokens (#73)", () => {
  // The chrome every page shares. Map chrome (#74) and page bodies (#75) move later.
  const CHROME = [
    "app/layout.tsx",
    "components/Nav.tsx",
    "components/GuestPass.tsx",
    "components/SearchPalette.tsx",
    "components/ErrorNotice.tsx",
    "components/RefusalNotice.tsx",
    "components/Tabs.tsx",
    "components/Appearance.tsx",
    "components/PageFrame.tsx",
    "components/ui/index.tsx",
  ];

  it.each(CHROME)("%s uses no legacy dusk/lantern/white/red chrome classes", (file) => {
    const src = web(file);
    expect(src).not.toMatch(/\b(?:bg|text|border|ring|from|to|decoration)-(?:dusk|lantern)-\d/);
    expect(src).not.toMatch(/\b(?:text|bg|border)-white\b/);
    expect(src).not.toMatch(/\b(?:text|bg|border)-red-\d/);
    expect(src).not.toContain("font-display");
  });

  it("recipes stay semantic", () => {
    const all = [SELECT_CLASS, CHECKBOX_CLASS, ICON_BUTTON_CLASS, BADGE_CLASS, navLinkClass(true), navLinkClass(false)].join(" ");
    expect(all).not.toMatch(/dusk-|lantern-|white\/|text-red|bg-red/);
    // White on signal fails AA: the badge label is signal-ink.
    expect(BADGE_CLASS).toContain("bg-signal");
    expect(BADGE_CLASS).toContain("text-signal-ink");
  });

  it("the nav wordmark is the lockup, and the product is never spelled out in capitals there", () => {
    const nav = web("components/Nav.tsx");
    expect(nav).toContain("lockupSvg(");
    expect(nav).not.toMatch(/>\s*Glasshouse\s*</);
  });

  it("the focus ring rule reads --gh-focus, not the theme lantern", () => {
    const css = web("app/globals.css");
    expect(css).toContain("outline: 2px solid var(--gh-focus)");
    expect(css).not.toContain("--g-lantern-400, 232 184 109");
  });

  it("the shared Nameplate is dressed in brand tokens everywhere, not only inside the map (#77)", () => {
    const css = web("app/globals.css");
    for (const cls of ["grove-badge", "grove-kind", "grove-name", "grove-owner", "grove-avatar", "grove-you"]) {
      const rules = [...css.matchAll(new RegExp(`(^|\\n)([^{}\\n]*\\.${cls}\\b[^{}]*)\\{([^}]*)\\}`, "g"))];
      expect(rules.length, cls).toBeGreaterThan(0);
      for (const r of rules) expect(r[3], `${r[2]!.trim()} uses a raw colour`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("the You menu and the map's ⋯ both carry Appearance", () => {
    expect(web("components/Nav.tsx")).toContain("<AppearanceMenuGroup />");
    expect(web("components/WorldMap.tsx")).toContain("<AppearanceMenuGroup />");
  });
});

describe("appearance", () => {
  it("offers System · Light · Night, in that order", () => {
    expect(APPEARANCE_CHOICES.map((c) => APPEARANCE_LABEL[c])).toEqual(["System", "Light", "Night"]);
  });

  it("only migrated routes leave the legacy night frame", () => {
    expect(BRANDED_ROUTES).toContain("/styleguide");
    expect(isBrandedRoute("/styleguide")).toBe(true);
    expect(isBrandedRoute("/styleguide/")).toBe(true);
    expect(isBrandedRoute("/styleguide?mode=night")).toBe(true);
    expect(isBrandedRoute("/styleguides")).toBe(false);
    // The map (#74) is on the brand tokens; "/" covers only the root, not every path.
    expect(BRANDED_ROUTES).toContain("/");
    expect(isBrandedRoute("/")).toBe(true);
    expect(isBrandedRoute("/?room=plaza")).toBe(true);
    expect(isBrandedRoute(null)).toBe(false);
    expect(isBrandedRoute("/s/den", ["/s"])).toBe(true);
    expect(isBrandedRoute("/explore", ["/"])).toBe(false);
  });
});
