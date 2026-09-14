import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLORS, FAULT, MODES, brandFiles, faviconSvg } from "@grove/ui/tokens";
import { HAZARD_COLOUR } from "@/lib/themes/types";
import { buttonClass, chipClass, tabClass } from "@/lib/brand-ui";

const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe("brand files (DECISIONS #7)", () => {
  it("public brand SVGs are exactly what the mark generator makes", () => {
    for (const [path, svg] of Object.entries(brandFiles())) {
      if (process.env.UPDATE_BRAND === "1") writeFileSync(web(`public/${path}`), svg);
      expect(readFileSync(web(`public/${path}`), "utf8"), path).toBe(svg);
    }
    expect(readFileSync(web("app/icon.svg"), "utf8")).toBe(faviconSvg());
  });

  it("ships the favicon set, apple touch icon, manifest and OG route", () => {
    for (const f of [
      "app/favicon.ico",
      "app/apple-icon.png",
      "app/manifest.ts",
      "app/opengraph-image.tsx",
      "public/icons/icon-16.png",
      "public/icons/icon-32.png",
      "public/icons/icon-48.png",
      "public/icons/icon-192.png",
      "public/icons/icon-512.png",
      "public/icons/icon-maskable-512.png",
      "public/brand/email-mark-light.png",
      "public/brand/email-mark-night.png",
      "app/twitter-image.tsx",
      "lib/og/fonts/SchibstedGrotesk-ExtraBold.ttf",
      "lib/og/fonts/FragmentMono-Regular.ttf",
    ]) {
      expect(existsSync(web(f)), f).toBe(true);
    }
    const png = readFileSync(web("public/icons/icon-512.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(512);
    const ico = readFileSync(web("app/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
  });

  it("--gh-danger is the map's fixed fault colour, in every mode", () => {
    expect(FAULT).toBe(HAZARD_COLOUR.fault);
    for (const m of MODES) expect(COLORS[m].danger).toBe(HAZARD_COLOUR.fault);
  });

  it("brand recipes use semantic tokens only (no dusk/lantern/white chrome)", () => {
    const all = [
      ...(["primary", "secondary", "ghost", "danger"] as const).map((k) => buttonClass(k)),
      chipClass("human"),
      chipClass("agent"),
      tabClass(true),
      tabClass(false),
    ].join(" ");
    expect(all).not.toMatch(/dusk-|lantern-|white\/|text-red|bg-red/);
    expect(buttonClass("primary")).toContain("bg-signal");
    expect(buttonClass("primary")).toContain("text-signal-ink");
    expect(chipClass("human")).toContain("before:bg-human");
    expect(chipClass("agent")).toContain("before:bg-agent");
  });

  it("the style guide is linked from /how-it-works and not from the nav", () => {
    expect(readFileSync(web("app/how-it-works/page.tsx"), "utf8")).toContain('href="/styleguide"');
    expect(readFileSync(web("components/Nav.tsx"), "utf8")).not.toContain("styleguide");
  });
});
