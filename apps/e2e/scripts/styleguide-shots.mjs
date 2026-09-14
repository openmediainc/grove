#!/usr/bin/env node
/**
 * Style guide gallery (#77): headless screenshots of key Glasshouse surfaces in
 * light, night and TV at desktop and 390px, saved as WebP (≤150 KB each) into
 * apps/web/public/styleguide/, plus the manifest /styleguide renders from.
 *
 *   pnpm styleguide:shots                                   # production (signed out)
 *   BASE_URL=http://localhost:3510/grove pnpm styleguide:shots
 *
 * Signed-out only: it never signs in, so it can only ever capture what any
 * visitor already sees. No cookies, no storage beyond the appearance choice.
 * WebP is encoded by Chromium itself (canvas), so there is no image dependency.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = join(ROOT, "apps/web/public/styleguide");
const MANIFEST = join(ROOT, "apps/web/components/styleguide/gallery-shots.ts");
const BASE = (process.env.BASE_URL || "https://glasshouse.rendrr.app").replace(/\/+$/, "");
const MAX_BYTES = 150 * 1024;

const DESKTOP = { width: 1440, height: 900, out: 1200 };
const PHONE = { width: 390, height: 844, out: 390 };

/** mode: light | night | tv (tv comes from `?tv=1`, which defaults the chrome to tv). */
const SHOTS = [
  { id: "map-light-desktop", path: "/", mode: "light", size: DESKTOP, alt: "The world map by day at desktop width: frosted HUD line, first-visit card, minimap and map controls over the pixel world." },
  { id: "room-light-desktop", path: "/?room=plaza", mode: "light", size: DESKTOP, alt: "The Plaza room drawer open beside the map by day: room tabs, who is here and a sign-in prompt." },
  { id: "history-light-desktop", path: "/?history=1", mode: "light", size: DESKTOP, alt: "The History drawer by day: replay buttons, time range and kind filters, and the public record." },
  { id: "explore-light-desktop", path: "/explore", mode: "light", size: DESKTOP, alt: "Explore by day: shelves of spaces and agents on Clear Pane." },
  { id: "space-light-desktop", path: "/s/aetheria-prime", mode: "light", size: DESKTOP, alt: "A space page by day: title, access pill, Follow, About and Activity tabs, rooms list." },
  { id: "agent-light-desktop", path: "/a/hello/opencode", mode: "light", size: DESKTOP, alt: "A public agent page by day: name, owner, Activity and Card tabs." },
  { id: "how-light-desktop", path: "/how-it-works", mode: "light", size: DESKTOP, alt: "How it works by day: plain sections explaining bodies, marks and access." },
  { id: "login-light-desktop", path: "/login", mode: "light", size: DESKTOP, alt: "Sign in by day: the email field and the primary signal button." },
  { id: "map-night-desktop", path: "/", mode: "night", size: DESKTOP, alt: "The world map in night mode at desktop width: Nightwatch frost panels over the map." },
  { id: "room-night-desktop", path: "/?room=plaza", mode: "night", size: DESKTOP, alt: "The Plaza room drawer in night mode." },
  { id: "room-space-theme-night-desktop", path: "/?room=plaza&theme=space", mode: "night", size: DESKTOP, alt: "The same room drawer in night mode with the space map theme: the world art changes, the drawer frame does not." },
  { id: "explore-night-desktop", path: "/explore", mode: "night", size: DESKTOP, alt: "Explore in night mode." },
  { id: "space-night-desktop", path: "/s/aetheria-prime", mode: "night", size: DESKTOP, alt: "A space page in night mode." },
  { id: "tv-desktop", path: "/?tv=1", mode: "tv", size: DESKTOP, alt: "Glasshouse TV: the on-air caption, status line and Leave TV control in TV mode." },
  { id: "map-light-390", path: "/", mode: "light", size: PHONE, alt: "The world map by day on a 390px phone." },
  { id: "room-light-390", path: "/?room=plaza", mode: "light", size: PHONE, alt: "The Plaza room as a bottom sheet by day on a 390px phone." },
  { id: "explore-light-390", path: "/explore", mode: "light", size: PHONE, alt: "Explore by day on a 390px phone." },
  { id: "space-light-390", path: "/s/aetheria-prime", mode: "light", size: PHONE, alt: "A space page by day on a 390px phone." },
  { id: "map-night-390", path: "/", mode: "night", size: PHONE, alt: "The world map in night mode on a 390px phone." },
  { id: "history-night-390", path: "/?history=1", mode: "night", size: PHONE, alt: "The History sheet in night mode on a 390px phone." },
  { id: "space-night-390", path: "/s/aetheria-prime", mode: "night", size: PHONE, alt: "A space page in night mode on a 390px phone." },
  { id: "login-night-390", path: "/login", mode: "night", size: PHONE, alt: "Sign in, night mode, on a 390px phone." },
];

const MODE_LABEL = { light: "Light", night: "Night", tv: "TV" };

async function toWebp(encoder, png, outWidth) {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42]) {
    const b64 = await encoder.evaluate(
      async ({ src, w, q }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        const url = c.toDataURL("image/webp", q);
        if (!url.startsWith("data:image/webp")) throw new Error("this Chromium cannot encode WebP");
        return { data: url.slice(url.indexOf(",") + 1), h };
      },
      { src: dataUrl, w: outWidth, q: quality },
    );
    const buf = Buffer.from(b64.data, "base64");
    if (buf.length <= MAX_BYTES) return { buf, height: b64.h, quality };
  }
  throw new Error("could not get a shot under 150 KB");
}

const browser = await chromium.launch();
const encoder = await (await browser.newContext()).newPage();
mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".webp")) rmSync(join(OUT_DIR, f));

const manifest = [];
for (const shot of SHOTS) {
  const phone = shot.size === PHONE;
  const ctx = await browser.newContext({
    viewport: { width: shot.size.width, height: shot.size.height },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: shot.mode === "light" ? "light" : "dark",
    reducedMotion: "reduce",
  });
  if (shot.mode !== "tv") {
    await ctx.addInitScript((m) => {
      try {
        localStorage.setItem("gh-mode", m);
      } catch {
        /* the colour scheme above still picks the mode */
      }
    }, shot.mode);
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const png = await page.screenshot({ type: "png" });
  const { buf, height, quality } = await toWebp(encoder, png, shot.size.out);
  const file = `${shot.id}.webp`;
  writeFileSync(join(OUT_DIR, file), buf);
  manifest.push({
    src: `/styleguide/${file}`,
    alt: shot.alt,
    caption: `${MODE_LABEL[shot.mode]} · ${phone ? "390px" : "desktop"} · ${shot.path}`,
    width: shot.size.out,
    height,
  });
  console.log(`${file}  ${(buf.length / 1024).toFixed(0)} KB  q=${quality}`);
  await ctx.close();
}
await browser.close();

writeFileSync(
  MANIFEST,
  `/**
 * Generated by \`pnpm styleguide:shots\` (apps/e2e/scripts/styleguide-shots.mjs).
 * Do not edit by hand: re-run the script. Signed-out captures of ${BASE}.
 */
export type GalleryShot = { src: string; alt: string; caption: string; width: number; height: number };

export const GALLERY_SHOTS: readonly GalleryShot[] = ${JSON.stringify(manifest, null, 2)};
`,
);
console.log(`${manifest.length} shots, manifest at ${MANIFEST}`);
