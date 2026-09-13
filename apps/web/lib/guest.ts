/**
 * The guest pass, as the web app sees it (queue #32).
 *
 * A signed-out visitor who reacts or follows is given a guest pass by the
 * server: an httpOnly cookie this code cannot read, plus a `grove_guest_hint`
 * flag it can. The hint only says "ask"; GET /api/v1/guest is the answer. What
 * a guest may do is the server's call (react and follow public things, nothing
 * else); these helpers only decide what the nav and buttons say.
 */
import type { FollowSubject } from "@grove/protocol";
import { agentHref } from "./agent-page";

export const GUEST_PATH = "/api/v1/guest";
export const GUEST_HINT = "grove_guest_hint";
/** Fired on window when a guest action lands, so the nav can look again without a reload. */
export const GUEST_EVENT = "grove:guest";

export type WireGuestFollow = { subject: FollowSubject; id: string; slug: string; name: string; following: boolean };
export type WireGuest = { guest: { since: string; follows: WireGuestFollow[] } };

export function hasGuestHint(cookie: string): boolean {
  return cookie
    .split(";")
    .map((c) => c.trim())
    .some((c) => c.startsWith(`${GUEST_HINT}=`) && c.length > GUEST_HINT.length + 1);
}

/** The line under the guest's follow list. */
export function guestFollowLine(n: number): string {
  if (n <= 0) return "Follow a space or an agent and it shows up here. Sign in to get notified.";
  return `You follow ${n} ${n === 1 ? "thing" : "things"} — sign in to get notified.`;
}

/** The nav chip's words. */
export function guestChipLabel(n: number): string {
  return n > 0 ? `Following ${n}` : "Guest";
}

/** Where a followed thing opens. */
export function guestFollowHref(f: Pick<WireGuestFollow, "subject" | "slug">): string {
  return f.subject === "space" ? `/spaces/${encodeURIComponent(f.slug)}` : agentHref(f.slug);
}

/** The sign-in link for a guest: says why, and comes back to where they were. */
export function guestSignInHref(next: string, why: "follow" | "react" | "guest" = "guest"): string {
  const q = new URLSearchParams({ next: next || "/", why });
  return `/login?${q.toString()}`;
}
