#!/usr/bin/env node
/**
 * `pnpm perf:budget` (#68, docs/PERFORMANCE.md): first-load JS per route from
 * the last `next build`, checked against the recorded baseline.
 *
 * First-load JS = every JS file the App Router manifest lists for a route's
 * page plus the root layout, gzipped and summed. It tracks Next's own "First
 * Load JS" column within a few kB; what matters is that it is the same
 * measure every time.
 *
 *   node scripts/perf-budget.mjs            check (exit 1 if over budget)
 *   node scripts/perf-budget.mjs --record   write the current sizes as the baseline
 *
 * Build first: `VERCEL=1 npx next build` (the production shape; no base path).
 * No runtime dependencies: node:fs, node:zlib, node:path only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** Routes we track, as the manifest names their page entries. */
export const TRACKED = {
  "/": "/page",
  "/explore": "/explore/page",
  "/s/[slug]": "/s/[slug]/page",
  "/a/[slug]": "/a/[...slug]/page",
  "/me": "/me/page",
};

/** Routes whose growth fails the check. The rest are reported only. */
export const ENFORCED = ["/"];

/** Allowed growth over the baseline before the check fails. */
export const TOLERANCE = 0.1;

/** The distinct JS files a route loads first: its page entry plus the root layout. */
export function routeFiles(pages, entry) {
  const files = [...(pages[entry] ?? []), ...(pages["/layout"] ?? [])];
  return [...new Set(files.filter((f) => f.endsWith(".js")))];
}

/** Compare current sizes (bytes) with a baseline; returns rows and whether an enforced route broke budget. */
export function compare(current, baseline, { tolerance = TOLERANCE, enforced = ENFORCED } = {}) {
  const rows = Object.keys(current).map((route) => {
    const now = current[route];
    const was = baseline?.[route];
    const limit = was == null ? null : Math.round(was * (1 + tolerance));
    const over = limit != null && now > limit;
    return { route, now, was: was ?? null, limit, over, enforced: enforced.includes(route) };
  });
  return { rows, ok: !rows.some((r) => r.over && r.enforced) };
}

const kb = (b) => (b == null ? "—" : `${(b / 1024).toFixed(1)} KiB`);

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const web = join(here, "..");
  const manifestPath = join(web, ".next", "app-build-manifest.json");
  const baselinePath = join(web, "perf-budget.json");
  if (!existsSync(manifestPath)) {
    console.error("perf:budget: no build found. Run `cd apps/web && VERCEL=1 npx next build` first.");
    process.exit(2);
  }
  const { pages } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const current = {};
  for (const [route, entry] of Object.entries(TRACKED)) {
    if (!pages[entry]) continue;
    current[route] = routeFiles(pages, entry).reduce(
      (sum, f) => sum + gzipSync(readFileSync(join(web, ".next", f))).length,
      0,
    );
  }
  if (process.argv.includes("--record")) {
    const doc = {
      note: "First-load JS per route, gzip bytes (page + root layout). Written by `pnpm perf:budget --record`; see docs/PERFORMANCE.md.",
      tolerance: TOLERANCE,
      routes: current,
    };
    writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
    for (const [r, b] of Object.entries(current)) console.log(`${r.padEnd(10)} ${kb(b)}`);
    console.log(`recorded ${baselinePath}`);
    return;
  }
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  const { rows, ok } = compare(current, baseline?.routes, { tolerance: baseline?.tolerance ?? TOLERANCE });
  for (const r of rows) {
    const mark = r.over ? (r.enforced ? "FAIL" : "warn") : "ok  ";
    console.log(`${mark} ${r.route.padEnd(10)} ${kb(r.now).padStart(10)}  baseline ${kb(r.was)}  limit ${kb(r.limit)}`);
  }
  if (!ok) {
    console.error("perf:budget: over budget. Code-split the new weight (see docs/PERFORMANCE.md) or, if it is deliberate, re-record with --record and say why in the commit.");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
