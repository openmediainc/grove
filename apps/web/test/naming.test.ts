import { describe, expect, it } from "vitest";
import { THEME_IDS, mapSubline } from "../lib/themes";
import { THEMES } from "../lib/themes/all";
import { metadata } from "../app/layout";

// DECISIONS.md #2: the visible product name is Glasshouse. "Grove", "Aetheria"
// and "campus" stay only in contract names (packages, env vars, cookies, keys).
const OLD_NAMES = /\b(grove|aetheria|campus)\b/i;

describe("Glasshouse naming", () => {
  it.each(THEME_IDS)("the %s lexicon never says the old names", (id) => {
    expect(JSON.stringify(THEMES[id].lexicon)).not.toMatch(OLD_NAMES);
  });

  it("names the site Glasshouse in the title and share tags", () => {
    expect(String(metadata.title)).toMatch(/^Glasshouse/);
    expect(JSON.stringify(metadata)).not.toMatch(OLD_NAMES);
    expect(metadata.openGraph?.siteName).toBe("Glasshouse");
  });

  it("mentions the Mini's Paperclip mirror only on the Mini", () => {
    const lex = THEMES.aoe.lexicon;
    expect(mapSubline(lex, false)).toBe(lex.subline);
    expect(mapSubline(lex, false)).not.toMatch(/Mini|Paperclip/);
    expect(mapSubline(lex, true)).toContain("Paperclip agents on this Mini");
  });
});

describe("access words on the map", () => {
  it("keeps the one vocabulary beside a theme's reskin", async () => {
    const { themedAccess } = await import("../lib/access");
    expect(themedAccess(THEMES.aoe.lexicon.access.public_view.label, "public_view")).toBe("Watch only");
    expect(themedAccess(THEMES.aoe.lexicon.access.public_write.label, "public_write")).toBe("Open");
    expect(themedAccess(THEMES.space.lexicon.access.private.label, "private")).toBe("sealed (Private)");
    expect(themedAccess(THEMES.city.lexicon.access.public_view.label, "public_view")).toBe("glass lobby (Watch only)");
    expect(themedAccess("whatever", "weird_preset")).toBe("Private");
  });
});
