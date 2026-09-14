import type { Page } from "@playwright/test";
import { appPath, expect, expectNoHorizontalOverflow, skipFirstVisit, test, url } from "./support";

/** The map's Go to ▾ button; its word is the theme's ("go to", "set course", "jump to"). */
const GO_TO = /go to|set course|jump to/i;

async function openMap(page: Page, query = ""): Promise<void> {
  await page.goto(url(`/${query}`));
  await expect(page.getByRole("region", { name: "Glasshouse world map" }).or(page.getByLabel("Glasshouse world map")).first()).toBeVisible();
}

test.describe("world map (signed out)", () => {
  test("home renders a canvas with the stylesheet loaded", async ({ page }) => {
    await skipFirstVisit(page);
    const res = await page.goto(url("/"));
    expect(res?.status()).toBe(200);
    const html = await res!.text();
    expect(html).toContain("_next/static/css");
    await expect(page.locator("canvas").first()).toBeVisible();
    // A signed-out viewer is offered sign-in, never the walk-in sheet.
    await expect(page.getByRole("link", { name: /^sign in$/i }).first()).toBeVisible();
  });

  test("first-visit card appears once and dismisses", async ({ page }) => {
    await page.goto(url("/"));
    const card = page.getByRole("heading", { name: "What you're looking at" });
    await expect(card).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toBeHidden();
    await page.reload();
    await expect(page.locator("canvas").first()).toBeVisible();
    await expect(card).toBeHidden();
  });

  test("room drawer opens from ?room=plaza and closes", async ({ page }) => {
    await skipFirstVisit(page);
    await page.goto(url("/?room=plaza"));
    const drawer = page.getByRole("dialog", { name: /, room$/ });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Close the room" }).click();
    await expect(drawer).toBeHidden();
    expect(new URL(page.url()).searchParams.get("room")).toBeNull();
  });

  test("/w/plaza redirects to the room drawer on the map", async ({ page }) => {
    await skipFirstVisit(page);
    await page.goto(url("/w/plaza"));
    await expect(page).toHaveURL(/[?&]room=plaza/);
    expect(appPath(page)).toBe("/");
    await expect(page.getByRole("dialog", { name: /, room$/ })).toBeVisible();
  });

  test("History drawer opens from ?history=1", async ({ page }) => {
    await skipFirstVisit(page);
    await page.goto(url("/?history=1"));
    const drawer = page.getByRole("dialog", { name: "History" });
    await expect(drawer).toBeVisible();
    await page.getByRole("button", { name: "Close history" }).click();
    await expect(drawer).toBeHidden();
  });

  test("/chronicle redirects to the History with its query kept", async ({ page }) => {
    await skipFirstVisit(page);
    await page.goto(url("/chronicle?win=24h"));
    await expect(page).toHaveURL(/[?&]history=1/);
    expect(appPath(page)).toBe("/");
    expect(new URL(page.url()).searchParams.get("win")).toBe("24h");
    await expect(page.getByRole("dialog", { name: "History" })).toBeVisible();
  });

  for (const [name, label] of [
    ["Go to", GO_TO],
    ["Watch", /^watch/i],
    ["More (⋯)", /^more$/i],
  ] as const) {
    test(`${name} menu opens and closes by keyboard`, async ({ page }) => {
      await skipFirstVisit(page);
      await openMap(page);
      const button = page.getByRole("button", { name: label }).and(page.locator("[aria-haspopup=menu]"));
      await expect(button).toBeVisible();
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(button).toHaveAttribute("aria-expanded", "true");
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      // APG menu button: focus lands on the first item.
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(button).toBeFocused();
    });
  }

  test("/ opens the search palette and Escape closes it", async ({ page }) => {
    await skipFirstVisit(page);
    await openMap(page);
    await page.locator("body").click({ position: { x: 5, y: 5 }, trial: true }).catch(() => undefined);
    await page.keyboard.press("/");
    const palette = page.getByRole("dialog", { name: "Search Glasshouse" });
    await expect(palette).toBeVisible();
    await expect(page.getByRole("combobox", { name: /search agents/i })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
});

test.describe("pages (signed out)", () => {
  test("/explore shows its shelves or their empty states", async ({ page }) => {
    await page.goto(url("/explore"));
    for (const h of ["Online now", "Spaces"]) {
      await expect(page.getByRole("heading", { name: h, exact: true })).toBeVisible();
    }
    // Discovery shelves: each is a titled section with cards or its empty sentence.
    const shelves = page.locator("section[aria-labelledby^='shelf-']");
    await expect(shelves.first()).toBeVisible();
    expect(await shelves.count()).toBeGreaterThanOrEqual(3);
  });

  test("/s/aetheria-prime switches between About and Activity", async ({ page }) => {
    await page.goto(url("/s/aetheria-prime"));
    const tabs = page.getByRole("tablist", { name: "Space" });
    await expect(tabs).toBeVisible();
    const about = tabs.getByRole("tab", { name: "About" });
    const activity = tabs.getByRole("tab", { name: "Activity" });
    await expect(about).toHaveAttribute("aria-selected", "true");
    await activity.click();
    await expect(activity).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/[?&]tab=activity/);
    await expect(page.getByRole("tabpanel")).toBeVisible();
    // Arrow keys move between tabs (APG).
    await activity.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(about).toHaveAttribute("aria-selected", "true");
  });

  test("/how-it-works renders and #agents is a real anchor", async ({ page }) => {
    await page.goto(url("/how-it-works#agents"));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const agents = page.locator("section#agents");
    await expect(agents).toBeVisible();
    await expect(agents).toBeInViewport();
  });

  test("/login renders the magic-link form (not submitted)", async ({ page }) => {
    await page.goto(url("/login"));
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Invite code" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /18 or older/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send link" })).toBeEnabled();
  });

  test("/styleguide renders", async ({ page }) => {
    const res = await page.goto(url("/styleguide"));
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  // DECISIONS #5: old routes redirect, never 404. `/me` asks a signed-out
  // viewer to sign in first, so it may land on /login on its way there.
  for (const [from, to] of [
    ["/spaces", ["/explore"]],
    ["/agents", ["/me", "/login"]],
    ["/studio", ["/me", "/login"]],
    ["/docs", ["/how-it-works"]],
    ["/enter", ["/"]],
  ] as const) {
    test(`${from} redirects to ${to[0]}`, async ({ page }) => {
      const res = await page.goto(url(from));
      expect(res?.status(), `${from} landed on an error`).toBeLessThan(400);
      expect(to as readonly string[]).toContain(appPath(page));
    });
  }
});

test.describe("phone width", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 400, "390px only");
  for (const path of ["/", "/explore", "/s/aetheria-prime", "/how-it-works", "/login", "/?room=plaza", "/?history=1"]) {
    test(`no horizontal overflow at 390px on ${path}`, async ({ page }) => {
      await skipFirstVisit(page);
      await page.goto(url(path));
      await page.waitForLoadState("load");
      // Let client components (drawers, shelves) mount before measuring.
      await page.waitForTimeout(1_500);
      await expectNoHorizontalOverflow(page);
    });
  }
});
