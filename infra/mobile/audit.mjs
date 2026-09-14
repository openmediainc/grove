// Mobile audit for Glasshouse (#70). Dev-only: not an app dependency and not in CI.
//
//   pnpm check:mobile                                   # prod, overflow + tap targets (exit 1 on a finding)
//   BASE=http://127.0.0.1:3520/grove pnpm check:mobile  # a local `next start`
//   pnpm check:mobile full                              # also text size, sheets, overlaps, keyboard
//
// `infra/mobile/check.sh` installs playwright-core into a cache dir the first
// time and runs this file. Directly: NODE_PATH=<dir with playwright-core> node infra/mobile/audit.mjs [quick|full].
//
// Viewports: 390x844 and 360x740, touch + mobile emulation, signed out. With
// MOCK_ME=1 the API's /humans/me answers a fake human (the request never
// reaches a server), so the signed-in-only sheets (walk-in, create space, the
// room composer) render too; that is only meaningful against a local build.
//
// Checks, per state:
//   overflow   document wider than the viewport, or a visible element past either edge
//              (unless an ancestor scrolls or clips it on the x axis)
//   tap        an interactive element whose TAPPABLE area is under 44x44: nine points
//              of a 44px square centred on it must hit the element (so an invisible
//              ::before hit area counts, a neighbour's does not). Inline links inside
//              a sentence are exempt (WCAG 2.5.8 inline exception).
//   text       (full) visible text under 12px
//   zoom       (full) a text input under 16px (iOS zooms the page when it takes focus)
//   sheet      (full) a dialog taller than 90% of the viewport, or its close control off-screen
//   overlap    (full) floating chrome (fixed/absolute) or two tap targets on top of each other in one layer
//   keyboard   (full) focus each text field, shrink window.visualViewport by a keyboard
//              (40% of the height, layout viewport unchanged, as iOS does), fire its
//              resize, and check the field is still between the top of the screen and the keys
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(path.join(process.env.NODE_PATH || process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const BASE = (process.env.BASE || "https://glasshouse.rendrr.app").replace(/\/$/, "");
const MODE = process.argv[2] || "quick";
const FULL = MODE === "full";
const MOCK_ME = process.env.MOCK_ME === "1";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const VIEWPORTS = (process.env.VIEWPORTS || "390x844,360x740").split(",").map((v) => {
  const [width, height] = v.split("x").map(Number);
  return { width, height };
});
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : undefined);

const wait = (page, ms) => page.waitForTimeout(ms);
const menu = (page, text) => page.locator('button[aria-haspopup="menu"]').filter({ hasText: text }).first();
async function tapIfThere(locator) {
  if (!(await locator.count())) return false;
  await locator.first().click({ timeout: 3000 }).catch(() => {});
  return true;
}

/** A tap on the canvas that opens a peek card (a body, a plot), trying a grid of points. */
async function openPeek(page) {
  const box = await page.locator("canvas[aria-label='Glasshouse world map']").boundingBox();
  if (!box) return false;
  for (let gy = 0.35; gy <= 0.65; gy += 0.1) {
    for (let gx = 0.2; gx <= 0.8; gx += 0.1) {
      await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy);
      await wait(page, 250);
      if (await page.locator("[role=dialog][aria-labelledby='grove-peek-title']").count()) return true;
      if (await page.locator("[data-map-drawer]").count()) {
        await page.keyboard.press("Escape");
        await wait(page, 400);
      }
    }
  }
  return false;
}

// Each state: a path, and what to do before auditing. `fresh` keeps the first-visit card.
const STATES = [
  { name: "/ (first visit card)", path: "/" },
  { name: "/ Go to menu", path: "/", dismissFirst: true, setup: (p) => menu(p, /go to/i).click() },
  { name: "/ Watch menu", path: "/", dismissFirst: true, setup: (p) => menu(p, /watch/i).click() },
  { name: "/ ⋯ menu", path: "/", dismissFirst: true, setup: (p) => p.locator('button[aria-label="More"]').click() },
  {
    name: "/ minimap toggled",
    path: "/",
    dismissFirst: true,
    setup: async (p) => {
      if (!(await tapIfThere(p.getByRole("button", { name: "Show minimap" })))) await tapIfThere(p.getByRole("button", { name: "Hide minimap" }));
    },
  },
  {
    name: "/ ⋯ Legend panel",
    path: "/",
    dismissFirst: true,
    setup: async (p) => {
      await p.locator('button[aria-label="More"]').click();
      await p.getByRole("menuitem", { name: "Legend" }).click();
    },
  },
  {
    name: "/ Watch Record a shot",
    path: "/",
    dismissFirst: true,
    setup: async (p) => {
      await menu(p, /watch/i).click();
      await p.getByRole("menuitem", { name: /record a shot/i }).click();
    },
  },
  { name: "/ peek card", path: "/", dismissFirst: true, setup: (p) => openPeek(p) },
  { name: "/ search palette", path: "/", dismissFirst: true, setup: async (p) => { await p.keyboard.press("/"); await wait(p, 500); await p.keyboard.type("pla"); } },
  { name: "/?room=plaza", path: "/?room=plaza" },
  { name: "/?history=1", path: "/?history=1" },
  {
    name: "/?history=1 reaction picker",
    path: "/?history=1",
    setup: async (p) => {
      await p.getByRole("button", { name: "Add a reaction" }).first().click({ timeout: 5000 });
    },
  },
  { name: "/?tv=1", path: "/?tv=1" },
  { name: "/explore", path: "/explore" },
  { name: "/s/aetheria-prime", path: "/s/aetheria-prime" },
  { name: "/s/aetheria-prime Activity tab", path: "/s/aetheria-prime", setup: (p) => tapIfThere(p.getByRole("tab", { name: /activity/i })) },
  { name: "/a/hello/opencode", path: "/a/hello/opencode" },
  { name: "/u/hello", path: "/u/hello" },
  { name: "/how-it-works", path: "/how-it-works" },
  { name: "/login", path: "/login" },
  { name: "/styleguide", path: "/styleguide", optional: true },
  ...(MOCK_ME
    ? [
        { name: "/ walk-in sheet (mocked me)", mock: true, path: "/", dismissFirst: true, setup: (p) => tapIfThere(p.getByRole("button", { name: "Walk in" })) },
        { name: "/?room=plaza composer (mocked me)", mock: true, path: "/?room=plaza" },
        { name: "/explore create step 1 (mocked me)", mock: true, path: "/explore#create" },
        {
          name: "/explore create step 2 preview (mocked me)",
          mock: true,
          path: "/explore#create",
          setup: async (p) => {
            await p.locator("#create input").first().fill("Mobile audit").catch(() => {});
            await wait(p, 300);
            await tapIfThere(p.locator("#create button").filter({ hasText: /next: preview/i }));
            await wait(p, 1500);
          },
        },
      ]
    : []),
];

/** Runs in the page: everything visible in the viewport right now. */
function inPage({ full }) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const TARGETS = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=checkbox],[tabindex='0']";
  const out = { docWidth: document.documentElement.scrollWidth, overflow: [], tap: [], text: [], zoom: [], sheet: [], overlap: [] };
  const describe = (el) => {
    const bits = [];
    let e = el;
    for (let i = 0; e && e !== document.body && i < 3; i++, e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += `#${e.id}`;
      const role = e.getAttribute("role");
      if (role) s += `[role=${role}]`;
      bits.unshift(s);
    }
    const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 32);
    return `${bits.join(" > ")}${name ? ` "${name}"` : ""}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false; // sr-only
    return !el.closest("[aria-hidden=true]") || el.matches("a,button,input,select,textarea");
  };
  const clipsX = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== "visible") return true;
    }
    return false;
  };

  // Clipped: content cut off sideways by a container that was never meant to
  // scroll sideways (overflow-x auto/scroll written on purpose is a carousel;
  // hidden with an ellipsis is truncation, also on purpose).
  const sideways = (a) => /\boverflow-(x-)?(auto|scroll)\b|\bsnap-x\b/.test(a.className?.baseVal ?? a.className ?? "");
  const clipper = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible") continue;
      if (sideways(a) || cs.textOverflow === "ellipsis") return null;
      return a;
    }
    return null;
  };
  if (out.docWidth > W + 1) out.overflow.push(`document is ${out.docWidth}px wide in a ${W}px viewport`);
  const all = [...document.body.querySelectorAll("*")];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > H) continue;
    if ((r.right > W + 1 || r.left < -1) && !clipsX(el)) {
      const parent = el.parentElement?.getBoundingClientRect();
      const parentAlso = parent && (parent.right > W + 1 || parent.left < -1) && !clipsX(el.parentElement);
      if (!parentAlso) out.overflow.push(`${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    const says = el.matches(TARGETS) || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const c = r.width > 8 && r.height > 8 && says ? clipper(el) : null;
    if (c) {
      const cr = c.getBoundingClientRect();
      const cut = Math.max(r.right - cr.right, cr.left - r.left);
      if (cut > 4 && r.top < cr.bottom && r.bottom > cr.top)
        out.overflow.push(`${describe(el)} is cut off by ${Math.round(cut)}px at the side of ${describe(c).slice(0, 60)}`);
    }
  }

  const hits = (el, x, y) => {
    const h = document.elementFromPoint(x, y);
    if (!h) return false;
    if (h === el || el.contains(h)) return true;
    const label = h.closest("label");
    return Boolean(label && (label.contains(el) || (el.id && label.htmlFor === el.id)));
  };
  const targets = [];
  for (let el of document.body.querySelectorAll(TARGETS)) {
    if (!visible(el) || el.disabled || el.matches("[role=tabpanel],main,[data-a11y-dialog]")) continue;
    // A checkbox or radio is tapped through its label: measure the label.
    if (el.matches("input[type=checkbox],input[type=radio]") && el.closest("label")) el = el.closest("label");
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cx > W || cy < 0 || cy > H) continue;
    if (!hits(el, cx, cy)) continue; // covered by something else: not tappable here at all
    if (el.parentElement?.closest(TARGETS) && !el.matches("input,select,textarea")) continue; // nested inside a bigger target
    targets.push({ el, r });
    if (r.width >= 44 && r.height >= 44) continue;
    // Inline link in running text (WCAG 2.5.8 exception).
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
      const block = el.parentElement;
      const own = [...(block?.childNodes ?? [])].filter((n) => n !== el).map((n) => n.textContent ?? "").join("").trim();
      if (own.length > 6) continue;
    }
    let ok = 0;
    let tried = 0;
    for (const dx of [-21, 0, 21])
      for (const dy of [-21, 0, 21]) {
        const x = Math.min(W - 1, Math.max(0, cx + dx));
        const y = Math.min(H - 1, Math.max(0, cy + dy));
        tried++;
        if (hits(el, x, y)) ok++;
        else {
          // An open popup (menu, listbox) lying over the edge is transient, not a small target.
          const over = document.elementFromPoint(x, y)?.closest("[role=menu],[role=listbox]");
          if (over && !over.contains(el)) ok++;
        }
      }
    if (ok < tried) out.tap.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  if (full) {
    const sizes = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || !visible(el) || el.closest("canvas,svg,[aria-hidden=true],kbd")) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > H) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs >= 12) continue;
      const key = `${fs}px`;
      const list = sizes.get(key) ?? [];
      if (list.length < 4) list.push(`"${n.textContent.trim().slice(0, 24)}"`);
      sizes.set(key, list);
    }
    for (const [k, v] of sizes) out.text.push(`${k}: ${v.join(", ")}`);

    for (const el of document.body.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]),textarea,select")) {
      if (!visible(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) out.zoom.push(`${describe(el)} ${fs}px`);
    }

    for (const d of document.querySelectorAll("[role=dialog]")) {
      if (!visible(d)) continue;
      const r = d.getBoundingClientRect();
      if (r.height > H * 0.9 + 1) out.sheet.push(`${describe(d)} is ${Math.round((r.height / H) * 100)}% of the viewport`);
      const close = [...d.querySelectorAll("button")].find((b) => /close|^×$|^✕$|dismiss/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()));
      if (close) {
        const c = close.getBoundingClientRect();
        if (c.top < 0 || c.bottom > H || c.left < 0 || c.right > W) out.sheet.push(`${describe(d)}: close control is off-screen`);
      }
    }

    // Overlap: floating pieces of chrome on top of each other in the same layer.
    // A "piece" is a tap target or a panel (a box with its own background and a
    // rounded edge or border) that sits in a fixed or absolutely positioned
    // overlay. A menu or dialog opening over the controls is a layer above them,
    // which is the point of it, so pairs across a menu/dialog boundary are skipped.
    const layer = (el) => el.closest("[role=menu],[role=dialog],[role=listbox]");
    const overlaid = (el) => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const p = getComputedStyle(a).position;
        if (p === "fixed" || p === "absolute") return true;
        if (p === "sticky") return false;
      }
      return false;
    };
    // What of an element is actually on screen: its box cut down by every
    // ancestor that clips (content scrolled under a drawer's footer is not there).
    const shown = (el) => {
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const c = a.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };
    const pieces = [];
    for (const el of all) {
      if (!visible(el) || el.closest("header") || !overlaid(el)) continue;
      const cs = getComputedStyle(el);
      const r = shown(el);
      if (r.width < 20 || r.height < 12 || r.width * r.height > W * H * 0.6 || r.bottom < 0 || r.top > H) continue;
      // Words drawn over the map (a kiosk clock line) collide as badly as buttons do.
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const positioned = cs.position === "fixed" || cs.position === "absolute";
      if (cs.pointerEvents === "none" && !(ownText && positioned)) continue;
      const painted = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && (parseFloat(cs.borderTopLeftRadius) > 0 || parseFloat(cs.borderTopWidth) > 0);
      if (!painted && !el.matches(TARGETS) && el.tagName !== "CANVAS" && !(ownText && positioned)) continue;
      pieces.push({ el, r });
    }
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i];
        const b = pieces[j];
        if (a.el.contains(b.el) || b.el.contains(a.el) || layer(a.el) !== layer(b.el)) continue;
        // Two parts of one panel (a close button on its own minimap) are designed together.
        if (pieces.some((c) => c !== a && c !== b && c.el.contains(a.el) && c.el.contains(b.el))) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2) out.overlap.push(`${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(w)}x${Math.round(h)}`);
      }
    // Also any two tap targets on top of each other in the same layer.
    for (let i = 0; i < targets.length; i++)
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i];
        const b = targets[j];
        if (a.el.contains(b.el) || b.el.contains(a.el) || layer(a.el) !== layer(b.el)) continue;
        if (a.el.matches("[role=tabpanel]") || b.el.matches("[role=tabpanel]")) continue;
        if (getComputedStyle(a.el).position === "sticky" || a.el.closest("header") || b.el.closest("header")) continue;
        const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (w > 2 && h > 2) out.overlap.push(`${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(w)}x${Math.round(h)}`);
      }
  }
  return out;
}

const browser = await chromium.launch({ executablePath, headless: true });
const findings = [];
const add = (vp, state, kind, detail) => {
  const row = { vp: `${vp.width}`, state, kind, detail };
  if (!findings.some((f) => f.vp === row.vp && f.state === state && f.kind === kind && f.detail === detail)) findings.push(row);
};

for (const vp of VIEWPORTS) {
  for (const s of STATES) {
    if (ONLY && !ONLY.test(s.name)) continue;
    const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    if (s.mock) {
      const host = new URL(BASE).hostname;
      await ctx.addCookies([{ name: "grove_signed_in", value: "1", domain: host, path: "/" }]);
      await ctx.route(/\/api\/v1\/humans\/me(\?|$)/, (r) =>
        r.fulfill({ contentType: "application/json", body: JSON.stringify({ human: { id: "00000000-0000-4000-8000-00000000a0d1", handle: "mobile-audit", display_name: "Mobile audit" } }) }),
      );
      // A body in the Plaza, so the room drawer shows its composer.
      const me = { actor_id: "00000000-0000-4000-8000-00000000a0d1", kind: "human", name: "mobile-audit", display_name: "Mobile audit" };
      await ctx.route(/\/api\/v1\/rooms\/plaza(\?|$)/, (r) =>
        r.fulfill({ contentType: "application/json", body: JSON.stringify({ room: { id: "plaza", slug: "plaza", name: "Plaza", kind: "public", capacity: 80, occupancy: 1 }, nearby: [me] }) }),
      );
      await ctx.route(/\/api\/v1\/rooms\/plaza\/transcript/, (r) =>
        r.fulfill({ contentType: "application/json", body: JSON.stringify({ transcript: [] }) }),
      );
    }
    if (FULL)
      await ctx.addInitScript(() => {
        const fake = new EventTarget();
        let kb = 0;
        const get = (fn) => ({ get: fn, configurable: true });
        Object.defineProperties(fake, {
          width: get(() => window.innerWidth),
          height: get(() => window.innerHeight - kb),
          offsetTop: get(() => 0),
          offsetLeft: get(() => 0),
          pageTop: get(() => window.scrollY),
          pageLeft: get(() => window.scrollX),
          scale: get(() => 1),
        });
        Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
        window.__glasshouseKeyboard = (px) => {
          kb = px;
          fake.dispatchEvent(new Event("resize"));
        };
      });
    if (s.dismissFirst) await ctx.addInitScript(() => { try { localStorage.setItem("glasshouse-first-visit-dismissed", "1"); } catch {} });
    const page = await ctx.newPage();
    const res = await page.goto(BASE + s.path, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
    if (s.optional && (!res || res.status() === 404)) {
      await ctx.close();
      continue;
    }
    await wait(page, 3500);
    if (s.setup) {
      await Promise.race([s.setup(page), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), 60000))]).catch((e) =>
        add(vp, s.name, "setup", `could not reach this state: ${String(e?.message ?? e).split("\n")[0].slice(0, 80)}`),
      );
      await wait(page, 900);
    }
    // Walk the page in viewport-sized steps so everything below the fold is seen at its real position.
    const scrollH = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0, step = 0; step < 14; y += Math.round(vp.height * 0.8), step++) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await wait(page, 120);
      const r = await page.evaluate(inPage, { full: FULL });
      for (const d of r.overflow) add(vp, s.name, "overflow", d);
      for (const d of r.tap) add(vp, s.name, "tap", d);
      for (const d of r.text) add(vp, s.name, "text", d);
      for (const d of r.zoom) add(vp, s.name, "zoom", d);
      for (const d of r.sheet) add(vp, s.name, "sheet", d);
      for (const d of r.overlap) add(vp, s.name, "overlap", d);
      if (y + vp.height >= scrollH) break;
    }
    if (FULL) {
      // The virtual keyboard, the way iOS Safari does it: the layout viewport keeps its
      // height and only window.visualViewport shrinks (the init script below swaps in a
      // controllable one and fires its resize). A field passes if, once the page has had
      // a moment to react, it sits between the top of the screen and the top of the keys.
      await page.evaluate(() => window.scrollTo(0, 0));
      const fields = page.locator(
        "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=color]):not([type=file]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])",
      );
      const n = Math.min(await fields.count(), 8);
      const kb = Math.round(vp.height * 0.4);
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        if (!(await f.isVisible().catch(() => false))) continue;
        await f.focus().catch(() => {});
        await wait(page, 150);
        await page.evaluate((px) => window.__glasshouseKeyboard?.(px), kb);
        await wait(page, 600);
        const where = await f.evaluate((el, px) => {
          const r = el.getBoundingClientRect();
          const above = window.innerHeight - px;
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            above,
            label: el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.type,
            covered: r.bottom > above + 1 || r.top < 0,
          };
        }, kb);
        if (where.covered) add(vp, s.name, "keyboard", `"${where.label}" at ${where.top}..${where.bottom}px, keys start at ${where.above}px`);
        await page.evaluate(() => window.__glasshouseKeyboard?.(0));
        await f.blur().catch(() => {});
        await wait(page, 200);
      }
    }
    await ctx.close();
  }
}
await browser.close();

const kinds = FULL ? ["overflow", "tap", "text", "zoom", "sheet", "overlap", "keyboard"] : ["overflow", "tap"];
console.log(`# Mobile audit: ${BASE} (${MODE}${MOCK_ME ? ", mocked me" : ""})\n`);
console.log("| Width | State | Check | Finding |\n|---|---|---|---|");
for (const f of findings) console.log(`| ${f.vp} | ${f.state} | ${f.kind} | ${f.detail.replace(/\|/g, "\\|")} |`);
const counts = kinds.map((k) => `${k} ${findings.filter((f) => f.kind === k).length}`).join(" · ");
console.log(`\n${findings.length} findings: ${counts}`);
process.exit(findings.some((f) => f.kind === "overflow" || f.kind === "tap") ? 1 : 0);
