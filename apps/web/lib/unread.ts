/**
 * The nav's unread badge: unseen messages plus follow notices, linking to /inbox.
 *
 * Pure, so when it polls, what it shows and what viewing the inbox marks seen
 * can be tested without a browser. The counts are the server's
 * (GET /api/v1/inbox/unread): muted and blocked senders never count there.
 */

export const UNREAD_PATH = "/api/v1/inbox/unread";

/** Once a minute at most, and only while the tab is visible. */
export const UNREAD_POLL_MS = 60_000;

/** Fired by /inbox once it has marked what it showed as seen: the badge clears at once. */
export const INBOX_SEEN_EVENT = "grove:inbox-seen";

/** The script-readable cookie the API sets beside the httpOnly session (never a secret). */
export const SIGNED_IN_HINT = "grove_signed_in";

export type WireUnread = { messages: number; notices: number };

/** A signed-out visitor sends no request at all: no hint cookie, no poll. */
export function hasSignedInHint(cookie: string): boolean {
  return cookie.split(";").some((c) => c.trim().startsWith(`${SIGNED_IN_HINT}=`) && c.trim().length > SIGNED_IN_HINT.length + 1);
}

export function shouldPoll(cookie: string, visibility: string): boolean {
  return visibility === "visible" && hasSignedInHint(cookie);
}

/** The badge's total. Garbage off the wire counts as nothing. */
export function unreadTotal(u: Partial<WireUnread> | null | undefined): number {
  if (!u) return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return n(u.messages) + n(u.notices);
}

/** What the badge says: nothing at zero, "9+" past nine. */
export function badgeText(total: number): string | null {
  if (total <= 0) return null;
  return total > 9 ? "9+" : String(total);
}

/** The Inbox link's accessible name. */
export function inboxLabel(total: number): string {
  return total > 0 ? `Inbox, ${total} unread` : "Inbox";
}

/**
 * What viewing /inbox marks seen, for one list: the unread rows it actually
 * showed (by id, so something arriving between the read and the mark stays
 * new), or everything when the server counts more unread than were listed
 * (past the page, or a kind this client cannot draw) — otherwise the badge
 * would never clear. Null when there is nothing to mark.
 */
export function seenPlan(
  items: ReadonlyArray<{ id: string; read_at: string | null }>,
  unread: number,
): { ids: string[] } | { all: true } | null {
  if (unread <= 0) return null;
  const ids = items.filter((i) => !i.read_at).map((i) => i.id);
  if (unread > ids.length) return { all: true };
  return { ids };
}

/** The POST body for a plan: `{}` means all. */
export function seenBody(plan: { ids: string[] } | { all: true }): Record<string, unknown> {
  return "ids" in plan ? { ids: plan.ids } : {};
}
