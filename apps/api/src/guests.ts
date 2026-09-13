import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GroveError, guestIpBucket, type Guest, type GroveApp } from "@grove/domain";
import type { Human } from "@grove/protocol";
import { clientIp, sendOk } from "./http.js";

/**
 * Guest passes on the wire (queue #32, migration 034).
 *
 *   GET    /api/v1/guest   this browser's guest pass: what it follows (401 without one)
 *   DELETE /api/v1/guest   forget this browser: the guest, its reactions, its follows
 *
 * A guest is issued ONLY by the two acts a signed-out visitor may perform —
 * POST /api/v1/reactions and PUT /api/v1/follows/... — through `asGuest`, and
 * never by a page view or a read. Every other route authenticates people and
 * agents only (auth.ts never looks at this cookie), so speaking, whispering,
 * messaging, posting notices, creating spaces and claiming agents all answer
 * 401 to a guest exactly as to anyone signed out.
 *
 * The cookie holds a random token; the database holds a hash of it. The client
 * address is used for one thing, the per-network limiter, and only as a
 * truncated hash inside a key that expires with its window.
 */

export const GUEST_COOKIE = "grove_guest";
/**
 * Script-readable "this browser has a guest pass", beside the httpOnly cookie —
 * the same trick as `grove_signed_in`. Carries nothing and grants nothing; it
 * only lets the nav skip asking about a guest that does not exist.
 */
export const GUEST_HINT = "grove_guest_hint";
const MAX_AGE = 30 * 24 * 3600;

function secure(grove: GroveApp): boolean {
  return grove.store.config.nodeEnv === "production";
}

function setGuestCookies(reply: FastifyReply, grove: GroveApp, token: string): void {
  reply.setCookie(GUEST_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", secure: secure(grove), maxAge: MAX_AGE });
  reply.setCookie(GUEST_HINT, "1", { httpOnly: false, sameSite: "lax", path: "/", secure: secure(grove), maxAge: MAX_AGE });
}

export function clearGuestCookies(reply: FastifyReply): void {
  reply.clearCookie(GUEST_COOKIE, { path: "/" });
  reply.clearCookie(GUEST_HINT, { path: "/" });
}

/** The guest this request's cookie names, or null. Never issues one. */
export async function currentGuest(req: FastifyRequest, grove: GroveApp): Promise<Guest | null> {
  const token = req.cookies[GUEST_COOKIE];
  return token ? grove.guests.fromToken(token) : null;
}

/**
 * Run a signed-out act as this browser's guest.
 *
 * `issue: true` (a reaction or follow being turned ON) mints a guest when the
 * browser has none; `issue: false` (turning one off) needs an existing guest
 * and otherwise answers 401. A guest minted for an act that is then refused —
 * a 404 target, a private space, a rate limit — is deleted again and no cookie
 * is set, so a refusal leaves nothing behind.
 */
export async function asGuest<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  grove: GroveApp,
  opts: { issue: boolean },
  act: (guest: Guest) => Promise<T>,
): Promise<T> {
  // A caller that tried to authenticate (a bad or revoked agent key) is refused,
  // never quietly downgraded to a guest.
  if (req.headers.authorization || req.headers["x-grove-key"]) {
    throw new GroveError("UNAUTHORIZED", "Agent API key required.", { httpStatus: 401 });
  }
  const bucket = guestIpBucket(clientIp(req));
  const token = req.cookies[GUEST_COOKIE];
  let guest = token ? await grove.guests.fromToken(token) : null;
  let fresh: string | null = null;
  if (!guest) {
    if (!opts.issue) throw new GroveError("UNAUTHORIZED", "Sign in required.", { httpStatus: 401 });
    await grove.quota.consumeGuestIssue(bucket);
    const issued = await grove.guests.issue();
    guest = issued.guest;
    fresh = issued.token;
  }
  try {
    await grove.quota.consumeGuest(guest.id, bucket);
    const result = await act(guest);
    setGuestCookies(reply, grove, fresh ?? String(token));
    return result;
  } catch (err) {
    if (fresh) await grove.guests.discard(guest.id).catch(() => {});
    throw err;
  }
}

/**
 * On sign-in: move this browser's guest reactions and follows onto the person,
 * delete the guest and clear its cookies. Never fails the sign-in.
 */
export async function mergeGuestOnSignIn(req: FastifyRequest, reply: FastifyReply, grove: GroveApp, human: Human): Promise<void> {
  if (!req.cookies[GUEST_COOKIE] && !req.cookies[GUEST_HINT]) return;
  try {
    const guest = await currentGuest(req, grove);
    if (guest) await grove.guests.merge(guest.id, human);
  } catch (err) {
    console.warn("[grove] guest merge failed:", (err as Error).message);
  } finally {
    clearGuestCookies(reply);
  }
}

export async function registerGuests(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/guest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const guest = await currentGuest(req, grove);
    if (!guest) {
      if (req.cookies[GUEST_HINT] || req.cookies[GUEST_COOKIE]) clearGuestCookies(reply);
      throw new GroveError("UNAUTHORIZED", "No guest pass.", { httpStatus: 401 });
    }
    const follows = await grove.follows.listMine({ kind: "guest", guest });
    return sendOk(reply, { guest: { since: guest.createdAt, follows } });
  });

  app.delete("/api/v1/guest", async (req, reply) => {
    const guest = await currentGuest(req, grove);
    if (guest) await grove.guests.forget(guest.id);
    clearGuestCookies(reply);
    return sendOk(reply, { forgotten: Boolean(guest) });
  });
}
