import { describe, expect, it } from "vitest";
import { applySuggestion, brandingDraft, checkDraft, suggestionColourLine, type BrandingSuggestion } from "../lib/branding";

const suggestion = (over: Partial<BrandingSuggestion> = {}): BrandingSuggestion => ({
  name: "Harbour Lights",
  accent: { accent: "#a5b4fc", original: "#1e3a8a", substituted: true, note: "too dark" },
  source: { url: "https://h.example/", site_name: null, title: "Harbour Lights", theme_color: "#1e3a8a", favicon: null, favicon_colour: null, accent_from: "theme_color" },
  notes: [],
  ...over,
});

describe("website suggestions on Manage (#34)", () => {
  it("lays the suggestion over the draft, keeping the emblem, and passes the draft checks", () => {
    const d = brandingDraft({ accent: "#7dd3fc", sign_text: "Old", emblem: "anchor" });
    const next = applySuggestion(d, suggestion());
    expect(next).toEqual({ accent: "#a5b4fc", signText: "Harbour Lights", emblem: "anchor" });
    const c = checkDraft(next);
    expect([c.accentError, c.signTextError]).toEqual([null, null]);
  });

  it("leaves fields the website did not give, and does nothing without a suggestion", () => {
    const d = brandingDraft({ accent: "#7dd3fc", sign_text: "Old", emblem: null });
    expect(applySuggestion(d, suggestion({ name: null, accent: null }))).toEqual(d);
    expect(applySuggestion(d, null)).toBe(d);
  });

  it("says where the colour came from", () => {
    expect(suggestionColourLine(suggestion())).toMatch(/#1e3a8a from its theme colour could not be used/);
    expect(
      suggestionColourLine(suggestion({ accent: { accent: "#5eead4", original: "#5eead4", substituted: false, note: null }, source: { ...suggestion().source, accent_from: "favicon" } })),
    ).toBe("Colour: #5eead4, from its icon");
    expect(suggestionColourLine(suggestion({ accent: null }))).toBeNull();
  });
});
