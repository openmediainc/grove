import { describe, expect, it } from "vitest";
import { BRAND_PALETTE, nearestPaletteAccent, readAccent, readSignText, signTextFromName, suggestAccent } from "../src/branding.js";

describe("suggestAccent (#34)", () => {
  it("passes a usable website colour through unchanged", () => {
    expect(suggestAccent("#BEF264")).toEqual({ accent: "#bef264", original: "#bef264", substituted: false, note: null });
  });

  it("substitutes the nearest palette colour by hue, and says why", () => {
    const navy = suggestAccent("#1e3a8a")!;
    expect(navy.accent).toBe("#a5b4fc");
    expect(navy.note).toMatch(/too dark.*Periwinkle/);
    expect(suggestAccent("#14532d")!.accent).toBe("#6ee7b7"); // forest green -> Mint
    expect(suggestAccent("#000000")!.accent).toBe("#cbd5e1"); // black -> Silver
    const red = suggestAccent("#f87171")!;
    expect(red.substituted).toBe(true);
    expect(red.note).toMatch(/warning colours/);
  });

  it("always returns something readAccent accepts", () => {
    for (let i = 0; i < 400; i++) {
      const hex = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
      expect(readAccent(suggestAccent(hex)!.accent).ok, hex).toBe(true);
    }
    for (const p of BRAND_PALETTE) expect(nearestPaletteAccent(p.hex).hex).toBeDefined();
    expect(suggestAccent("teal")).toBeNull();
  });
});

describe("signTextFromName (#34)", () => {
  it("trims to 24 characters at a word boundary", () => {
    expect(signTextFromName("Harbour Lights")).toBe("Harbour Lights");
    expect(signTextFromName("The Extraordinarily Long Harbour Company")).toBe("The Extraordinarily Long");
    expect(signTextFromName("Supercalifragilisticexpialidocious")).toBe("Supercalifragilisticexpi");
    expect(signTextFromName("Open Media Digital Studios International")).toBe("Open Media Digital");
  });

  it("strips control and invisible characters instead of refusing", () => {
    const t = signTextFromName(`Evil${String.fromCharCode(0x202e)}Name${String.fromCharCode(0)}\nCo`)!;
    expect(t).toBe("Evil Name Co");
    expect(readSignText(t).ok).toBe(true);
    expect(signTextFromName(`  ${String.fromCharCode(0x200b)} `)).toBeNull();
  });
});
