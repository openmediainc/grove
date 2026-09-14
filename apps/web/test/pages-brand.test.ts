import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRANDED_ROUTES, isBrandedRoute } from "@/lib/appearance";
import { accessTint } from "@/lib/access";
import { BUDGET_TONE } from "@/lib/cost";
import { EMPTY_CLASS, LINK_CLASS, PAGE_TITLE_CLASS, SECTION_CLASS, TABLE_WRAP_CLASS, TH_CLASS, optionClass } from "@/lib/brand-ui";

const web = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

const LEGACY = [
  /\b(?:bg|text|border|ring|from|to|decoration|accent|divide)-(?:dusk|lantern)-\d/,
  /\b(?:text|bg|border|ring|divide)-white\b/,
  /\b(?:text|bg|border|ring)-(?:red|amber|emerald|sky|violet|slate|orange|rose|green|yellow|zinc|stone|gray|pink|purple|indigo|blue|teal|cyan|lime|fuchsia)-\d/,
  /\bfont-display\b/,
];

describe("page bodies on brand tokens (#75)", () => {
  const PAGES = [
    "app/explore/page.tsx",
    "components/Discovery.tsx",
    "components/CreateSpaceFlow.tsx",
    "components/ClaimPreview.tsx",
    "app/s/[slug]/page.tsx",
    "components/Board.tsx",
    "components/Branding.tsx",
    "components/Decor.tsx",
    "components/DefaultTheme.tsx",
    "components/EstateName.tsx",
    "components/SpaceMoves.tsx",
    "app/a/[...slug]/page.tsx",
    "components/AgentDay.tsx",
    "components/AgentSettings.tsx",
    "components/AgentBudget.tsx",
    "components/PermissionTree.tsx",
    "components/WhereAgentCanTalk.tsx",
    "app/u/[handle]/page.tsx",
    "app/me/page.tsx",
    "components/CostToday.tsx",
    "components/SupportSection.tsx",
    "app/inbox/page.tsx",
    "app/how-it-works/page.tsx",
    "app/login/page.tsx",
    "app/mod/page.tsx",
    "components/mod/Overview.tsx",
    "components/mod/EmailHealth.tsx",
    "components/mod/Trials.tsx",
    "app/spaces/join/[code]/page.tsx",
    "app/studio/preview/page.tsx",
    "lib/access.ts",
    "lib/cost.ts",
    // Shared with the map but drawn on these pages.
    "components/Card.tsx",
    "components/AgentPrompt.tsx",
    "components/Avatar.tsx",
    "lib/activity.ts",
  ];

  it.each(PAGES)("%s uses no legacy dusk/lantern/white/palette chrome classes", (file) => {
    const src = web(file);
    for (const re of LEGACY) expect(src).not.toMatch(re);
  });

  it("every listed page route is branded, so Light · Night · System apply", () => {
    for (const r of ["/explore", "/s/den", "/a/maya/lantern", "/u/maya", "/me", "/inbox", "/how-it-works", "/login", "/mod", "/styleguide"]) {
      expect(isBrandedRoute(r), r).toBe(true);
    }
    // A prefix covers its subtree only: /about is not /a, /users is not /u.
    expect(isBrandedRoute("/about", ["/a"])).toBe(false);
    expect(isBrandedRoute("/users", ["/u"])).toBe(false);
    expect(BRANDED_ROUTES.length).toBeGreaterThan(10);
  });

  it("access tints and budget tones are semantic, and every access level differs", () => {
    const tints = ["public_write", "public_view", "private"].map(accessTint);
    expect(new Set(tints).size).toBe(3);
    expect(accessTint("nonsense")).toBe(accessTint("private"));
    for (const t of [...tints, ...Object.values(BUDGET_TONE)]) for (const re of LEGACY) expect(t).not.toMatch(re);
  });

  it("page recipes stay on roles; signal is never a link colour", () => {
    const all = [EMPTY_CLASS, LINK_CLASS, PAGE_TITLE_CLASS, SECTION_CLASS, TABLE_WRAP_CLASS, TH_CLASS, optionClass(true), optionClass(false)].join(" ");
    for (const re of LEGACY) expect(all).not.toMatch(re);
    expect(LINK_CLASS).not.toMatch(/signal/);
    expect(TH_CLASS).toContain("gh-label");
    expect(optionClass(true)).toContain("border-signal");
  });

  it("the board lightbox pins night on its scrim, so its text stays light in day mode", () => {
    expect(web("components/Board.tsx")).toMatch(/data-mode="night"/);
  });
});

describe("tables on pages (#75)", () => {
  it.each(["components/CostToday.tsx", "components/mod/Overview.tsx", "components/mod/EmailHealth.tsx"])(
    "%s frames every table in a named, focusable TableFrame",
    (file) => {
      const src = web(file);
      const tables = (src.match(/<table\b/g) ?? []).length;
      expect(tables).toBeGreaterThan(0);
      expect((src.match(/<TableFrame label="/g) ?? []).length).toBe(tables);
    },
  );
});
