import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GALLERY_SHOTS } from "@/components/styleguide/gallery-shots";

const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe("style guide gallery (#77)", () => {
  it("is a small, optimised set: WebP, ≤150 KB each, at most 24", () => {
    expect(GALLERY_SHOTS.length).toBeGreaterThan(0);
    expect(GALLERY_SHOTS.length).toBeLessThanOrEqual(24);
    for (const shot of GALLERY_SHOTS) {
      expect(shot.src).toMatch(/^\/styleguide\/[a-z0-9-]+\.webp$/);
      const file = web(`public${shot.src}`);
      expect(statSync(file).size, shot.src).toBeLessThanOrEqual(150 * 1024);
      expect(readFileSync(file).subarray(8, 12).toString("ascii"), shot.src).toBe("WEBP");
    }
  });

  it("every shot has alt text and a caption, and no orphan files ship", () => {
    for (const shot of GALLERY_SHOTS) {
      expect(shot.alt.length, shot.src).toBeGreaterThan(20);
      expect(shot.caption).toMatch(/^(Light|Night|TV) · (desktop|390px) · \//);
    }
    const listed = new Set(GALLERY_SHOTS.map((s) => s.src.replace("/styleguide/", "")));
    expect(readdirSync(web("public/styleguide")).filter((f) => !listed.has(f))).toEqual([]);
  });

  it("covers light, night and TV at desktop and 390px", () => {
    const captions = GALLERY_SHOTS.map((s) => s.caption);
    for (const want of ["Light · desktop", "Night · desktop", "TV · desktop", "Light · 390px", "Night · 390px"]) {
      expect(captions.some((c) => c.startsWith(want)), want).toBe(true);
    }
  });

  it("the page renders the gallery through gp() with alt text", () => {
    const src = readFileSync(web("components/styleguide/Styleguide.tsx"), "utf8");
    expect(src).toContain('["gallery", "Gallery"]');
    expect(src).toContain("src={gp(shot.src)}");
    expect(src).toContain("alt={shot.alt}");
  });
});
