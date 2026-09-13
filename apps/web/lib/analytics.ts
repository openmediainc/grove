/**
 * The page-view beacon's client half (queue #31). Stance: docs/PRIVACY.md.
 *
 * Sends nothing but "a page was viewed": no path, no referrer, no screen size,
 * no id, no cookie of its own. A browser that asks not to be tracked (Do Not
 * Track or Global Privacy Control) sends nothing at all; the server also
 * refuses to count a request carrying either header.
 */

export const VISIT_BEACON_PATH = "/api/v1/analytics/visit";

type PrivacyNavigator = {
  doNotTrack?: string | null;
  globalPrivacyControl?: boolean;
  webdriver?: boolean;
};

/** False when the browser has opted out, or is being driven by automation. */
export function mayCountVisit(nav: PrivacyNavigator | undefined, win?: { doNotTrack?: string | null }): boolean {
  if (!nav) return false;
  if (nav.globalPrivacyControl === true) return false;
  const dnt = nav.doNotTrack ?? win?.doNotTrack ?? null;
  if (dnt === "1" || dnt === "yes") return false;
  if (nav.webdriver === true) return false;
  return true;
}

/**
 * One beacon per distinct pathname in a row: a re-render or a search-param
 * change on the same page is not another view.
 */
export function isNewView(previous: string | null, pathname: string | null): boolean {
  return Boolean(pathname) && pathname !== previous;
}

/** The six funnel rows the /mod card shows, in order (reactions ride along last). */
export const FUNNEL_ROWS = ["visit", "unique_visitor", "sign_in", "walk_in", "follow", "message", "reaction"] as const;

/** "42%" of a cohort, or "–" when the cohort is empty. */
export function cohortPercent(active: number, size: number): string {
  if (!size) return "–";
  return `${Math.round((Math.min(active, size) / size) * 100)}%`;
}

/** 3 → "3", 2.5 → "2.5". Medians of seven integers are always whole or .5. */
export function countText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Sep" for a cohort's Monday, read as UTC (no locale data, so server and browser agree). */
export function weekLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDay : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
