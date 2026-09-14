import { expect, test as base, type Page } from "@playwright/test";

/** The deployment under test, without a trailing slash (may include a base path such as `/grove`). */
export const BASE = (process.env.BASE_URL ?? "http://localhost:3510/grove").replace(/\/+$/, "");
const BASE_PATH = new URL(BASE).pathname.replace(/\/+$/, "");

/** An in-app address on the deployment under test: `url("/explore")`. */
export function url(path: string): string {
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The in-app path of the page's current address, with the base path taken off. */
export function appPath(page: Page): string {
  const p = new URL(page.url()).pathname;
  const rest = BASE_PATH && p.startsWith(BASE_PATH) ? p.slice(BASE_PATH.length) : p;
  return rest || "/";
}

/**
 * Console noise that is not a Glasshouse bug. Keep this list short and specific:
 * anything added here is something the suite can no longer see break.
 */
const BENIGN: RegExp[] = [
  // A signed-out viewer asking who they are: the app handles the 401 by design.
  /status of 401.*\/api\//i,
  // Chromium's own chatter about headless GPU / WebGL fallbacks.
  /GPU stall|WebGL|swiftshader/i,
  // Aborted fetches when a test navigates away mid-poll.
  /net::ERR_ABORTED|Failed to fetch|NetworkError|AbortError|signal is aborted/i,
  // Next's dev-only HMR socket on the Mini's dev server.
  /webpack-hmr|_next\/webpack|Fast Refresh|__nextjs_original-stack-frames/i,
  // Private or missing things answer 404 by design (DECISIONS: private = 404).
  /status of 404.*\/api\//i,
];

export type ConsoleLog = { errors: string[] };

/** Collects `console.error` and uncaught page errors, minus the allowlist. */
export function watchConsole(page: Page): ConsoleLog {
  const log: ConsoleLog = { errors: [] };
  const keep = (text: string) => {
    if (!BENIGN.some((re) => re.test(text))) log.errors.push(text);
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") keep(`console: ${msg.text()} @ ${msg.location().url}`);
  });
  page.on("pageerror", (err) => keep(`pageerror: ${err.message}`));
  return log;
}

/** Every test starts with the console watched and fails on anything left in it. */
export const test = base.extend<{ consoleLog: ConsoleLog }>({
  consoleLog: [
    async ({ page }, use) => {
      const log = watchConsole(page);
      await use(log);
      expect(log.errors, "no unexpected console errors").toEqual([]);
    },
    { auto: true },
  ],
});

/** Mark the first-visit card as seen, so it cannot cover what a test is looking at. */
export async function skipFirstVisit(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("glasshouse-first-visit-dismissed", "1");
    } catch {
      /* private mode */
    }
  });
}

/** No sideways scroll: the document is no wider than the viewport. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `page scrolls sideways (${scroll}px content in a ${client}px viewport)`).toBeLessThanOrEqual(client + 1);
}

export { expect };
