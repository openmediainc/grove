/**
 * Who the nav thinks is looking, and what that changes.
 *
 * Pure, so the nav's shape for a spectator, a member and an operator can be
 * tested without a browser. The hint cookie only says a session MAY exist;
 * `/api/v1/humans/me` is the answer, and the only source of the role. The
 * server still refuses anything the role does not allow: hiding "Mod" is
 * tidiness, not protection.
 */
import { hasSignedInHint } from "./unread";

export const ME_PATH = "/api/v1/humans/me";
export const LOGOUT_PATH = "/api/v1/humans/logout";

/** "unknown" until the client has looked; the server render always sees this. */
export type Viewer =
  | { state: "unknown" }
  | { state: "signed-out" }
  | { state: "signed-in"; handle: string | null; operator: boolean };

export const UNKNOWN: Viewer = { state: "unknown" };
export const SIGNED_OUT: Viewer = { state: "signed-out" };

/**
 * The first guess, from the cookie alone: no hint means signed out and no
 * request at all; a hint means "probably signed in" until /humans/me answers.
 */
export function viewerFromHint(cookie: string): Viewer {
  return hasSignedInHint(cookie) ? { state: "signed-in", handle: null, operator: false } : SIGNED_OUT;
}

/** The /humans/me body. Anything without a human is signed out. */
export function viewerFromMe(body: unknown): Viewer {
  const human = (body as { human?: { handle?: unknown; role?: unknown } } | null)?.human;
  if (!human || typeof human !== "object") return SIGNED_OUT;
  const handle = typeof human.handle === "string" && human.handle ? human.handle : null;
  return { state: "signed-in", handle, operator: human.role === "operator" };
}

export function isSignedIn(v: Viewer): boolean {
  return v.state === "signed-in";
}

export function isOperator(v: Viewer): boolean {
  return v.state === "signed-in" && v.operator;
}

/**
 * Where the nav's world link goes. A spectator gets the map, which anyone may
 * watch; only a body can walk into the plaza (it answers 401 otherwise).
 */
export function campusHref(v: Viewer): string {
  return isSignedIn(v) ? "/w/plaza" : "/";
}

/** The You menu's profile link, or null until the handle is known. */
export function profileHref(v: Viewer): string | null {
  return v.state === "signed-in" && v.handle ? `/u/${encodeURIComponent(v.handle)}` : null;
}
