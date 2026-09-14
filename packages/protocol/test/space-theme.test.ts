import { describe, expect, it } from "vitest";
import { SPACE_THEME_IDS, publishedDefaultTheme, readStoredDefaultTheme, validateDefaultTheme } from "../src/space-theme.js";

describe("space default theme (#59)", () => {
  it("knows the four themes", () => {
    expect([...SPACE_THEME_IDS]).toEqual(["aoe", "space", "city", "scifi"]);
  });

  it("validates writes strictly and clears on null or empty", () => {
    expect(validateDefaultTheme("city")).toEqual({ ok: true, theme: "city" });
    expect(validateDefaultTheme(null)).toEqual({ ok: true, theme: null });
    expect(validateDefaultTheme(undefined)).toEqual({ ok: true, theme: null });
    expect(validateDefaultTheme("")).toEqual({ ok: true, theme: null });
    expect(validateDefaultTheme("neon").ok).toBe(false);
    expect(validateDefaultTheme(3).ok).toBe(false);
    expect(validateDefaultTheme("__proto__").ok).toBe(false);
  });

  it("reads stored values leniently", () => {
    expect(readStoredDefaultTheme("scifi")).toBe("scifi");
    expect(readStoredDefaultTheme("removed-theme")).toBeNull();
    expect(readStoredDefaultTheme(null)).toBeNull();
  });

  it("never publishes a private plot's default", () => {
    expect(publishedDefaultTheme("public_write", "space")).toBe("space");
    expect(publishedDefaultTheme("public_view", "city")).toBe("city");
    expect(publishedDefaultTheme("private", "space")).toBeNull();
    expect(publishedDefaultTheme("public_write", "bogus")).toBeNull();
  });
});
