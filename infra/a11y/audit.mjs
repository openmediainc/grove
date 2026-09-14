// Accessibility audit for Glasshouse (#67). Not an app dependency and not in CI.
//
//   cd "$(mktemp -d)" && npm i --no-save playwright-core axe-core
//   NODE_PATH="$PWD/node_modules" node <repo>/infra/a11y/audit.mjs                 # prod, both modes
//   BASE=https://q-ai.tail735569.ts.net/grove NODE_PATH=... node <repo>/infra/a11y/audit.mjs axe
//
// Modes: `axe` runs axe-core (wcag2a, wcag2aa, wcag21a/aa, best-practice) on the
// signed-out pages, with each map menu and the search palette open; `keys` runs
// scripted keyboard and focus checks. No mode = both. Exits 1 if a keyboard
// check fails; axe findings are printed for comparison with the known exceptions
// in docs/ACCESSIBILITY.md. CHROME=<path> picks the browser (default: Playwright's).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const BASE = (process.env.BASE || "https://glasshouse.rendrr.app").replace(/\/$/, "");
const MODE = process.argv[2] || "all";
const PAGES = (process.env.PAGES || "/,/?room=plaza,/?history=1,/explore,/s/aetheria-prime,/how-it-works,/login,/u/hello,/a/hello/opencode").split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
let failures = 0;

async function axe(page, label) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  });
  const n = violations.reduce((a, v) => a + v.nodes.length, 0);
  console.log(`## ${label}: ${violations.length} rules, ${n} nodes`);
  for (const v of violations) console.log(`  - ${v.id} [${v.impact}] ${v.nodes.slice(0, 4).join(" | ")}`);
  return n;
}

if (MODE === "all" || MODE === "axe") {
  let total = 0;
  for (const p of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    total += await axe(page, p);
    if (p === "/") {
      for (const text of ["Go to", "Watch", "⋯"]) {
        const btn = page.locator('button[aria-haspopup="menu"]').filter({ hasText: new RegExp(text, "i") }).first();
        if (!(await btn.count())) continue;
        await btn.click();
        await page.waitForTimeout(300);
        total += await axe(page, `/ with ${text} open`);
        await page.keyboard.press("Escape");
      }
      await page.keyboard.press("/");
      await page.waitForTimeout(800);
      await page.keyboard.type("pla");
      await page.waitForTimeout(1500);
      total += await axe(page, "/ with the search palette open");
    }
    await page.close();
  }
  console.log(`axe total nodes: ${total}\n`);
}

const check = (cond, msg, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}${!cond && extra ? ` (${extra})` : ""}`);
  if (!cond) failures++;
};
const focused = (p) =>
  p.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    return {
      tag: a.tagName,
      role: a.getAttribute("role"),
      text: (a.textContent || "").trim().slice(0, 40),
      expanded: a.getAttribute("aria-expanded"),
      outline: getComputedStyle(a).outlineStyle,
      inDialog: !!a.closest("[role=dialog]"),
      selected: a.getAttribute("aria-selected"),
      activedescendant: a.getAttribute("aria-activedescendant"),
    };
  });

if (MODE === "all" || MODE === "keys") {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p.keyboard.press("Tab");
  let a = await focused(p);
  check(a?.text === "Skip to content", "first Tab stop is Skip to content", JSON.stringify(a));
  await p.keyboard.press("Enter");
  check((await focused(p))?.tag === "MAIN", "Skip to content moves focus to <main>");

  const goTo = p.locator('button[aria-haspopup="menu"]').filter({ hasText: /go to/i }).first();
  await goTo.focus();
  check((await focused(p))?.outline === "solid", "menu button shows a focus ring");
  await p.keyboard.press("ArrowDown");
  await p.waitForTimeout(200);
  a = await focused(p);
  check(a?.role === "menuitem", "ArrowDown opens Go to with focus on the first item", JSON.stringify(a));
  const first = a?.text;
  await p.keyboard.press("End");
  await p.keyboard.press("ArrowDown");
  check((await focused(p))?.text === first, "End then ArrowDown wraps to the first item");
  const stops = await p.evaluate(() => [...document.querySelectorAll("[role=menu] [role^=menuitem]")].filter((e) => e.getAttribute("tabindex") === "0").length);
  check(stops === 1, "roving tabindex: one Tab stop in the menu", String(stops));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(200);
  a = await focused(p);
  check(a?.expanded === "false" && /^go to/i.test(a?.text ?? ""), "Escape closes the menu and focus returns to its button", JSON.stringify(a));
  check(await p.evaluate(() => !document.querySelector("[data-map-drawer]")), "Escape in a menu does not reach the map");

  const watch = p.locator('button[aria-haspopup="menu"]').filter({ hasText: "Watch" }).first();
  await watch.focus();
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("h");
  check(((await focused(p))?.text ?? "").startsWith("History"), "typeahead h reaches History & replay");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1200);
  check((await focused(p))?.inDialog === true, "the History drawer takes focus when opened from a control");
  const labelled = await p.evaluate(() => {
    const d = document.querySelector("[data-map-drawer]");
    return d?.getAttribute("role") === "dialog" && document.getElementById(d.getAttribute("aria-labelledby") ?? "")?.textContent?.trim();
  });
  check(labelled === "History", "the drawer is role=dialog, labelled by its title", String(labelled));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(800);
  check(await p.evaluate(() => !document.querySelector("[data-map-drawer]")), "Escape closes the drawer");
  check(((await focused(p))?.text ?? "").startsWith("Watch"), "focus returns to Watch");

  await p.evaluate(() => document.activeElement?.blur());
  await p.keyboard.press("/");
  await p.waitForTimeout(600);
  check((await focused(p))?.role === "combobox", "/ opens the palette on its combobox");
  await p.keyboard.type("pla");
  await p.waitForTimeout(1500);
  await p.keyboard.press("ArrowDown");
  a = await focused(p);
  const sel = await p.evaluate((id) => (id ? document.getElementById(id)?.getAttribute("aria-selected") : null), a?.activedescendant);
  check(a?.role === "combobox" && sel === "true", "ArrowDown moves aria-activedescendant, focus stays in the input");
  for (let i = 0; i < 6; i++) await p.keyboard.press("Tab");
  check((await focused(p))?.inDialog === true, "Tab stays inside the modal palette");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  check(await p.evaluate(() => !document.querySelector('[aria-label="Search Glasshouse"]')), "Escape closes the palette");

  const t = await browser.newPage();
  await t.goto(BASE + "/s/aetheria-prime", { waitUntil: "domcontentloaded" });
  await t.waitForTimeout(3500);
  const tabs = await t.evaluate(() => [...document.querySelectorAll("[role=tab]")].map((x) => x.textContent.trim()));
  if (tabs.length > 1) {
    await t.locator('[role=tab][aria-selected="true"]').focus();
    await t.keyboard.press("ArrowRight");
    await t.waitForTimeout(400);
    a = await focused(t);
    check(a?.role === "tab" && a.selected === "true" && a.text === tabs[1], "ArrowRight selects and focuses the next tab");
  } else console.log("SKIP tabs: fewer than two tabs");

  const d = await browser.newPage();
  await d.goto(BASE + "/?room=plaza", { waitUntil: "domcontentloaded" });
  await d.waitForTimeout(3000);
  check((await focused(d))?.tag === "BODY", "a drawer opened by a deep link leaves focus on the page");

  const rm = await browser.newPage({ reducedMotion: "reduce" });
  await rm.goto(BASE + "/explore", { waitUntil: "domcontentloaded" });
  await rm.waitForTimeout(1500);
  check((await rm.evaluate(() => getComputedStyle(document.querySelector(".lantern")).animationName)) === "none", "the lantern glow stops under reduced motion");
  console.log(failures ? `\n${failures} keyboard check(s) FAILED` : "\nkeyboard checks: all pass");
}

await browser.close();
process.exit(failures ? 1 : 0);
