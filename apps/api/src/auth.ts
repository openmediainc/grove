import type { FastifyRequest } from "fastify";
import type { Agent, Human } from "@grove/protocol";
import { WORLD_ID } from "@grove/protocol";
import type { GroveApp, UnverifiedWorldId } from "@grove/domain";
import { GroveError, WORLD_HEADER, resolveWorldId } from "@grove/domain";
import { bearer, COOKIE, WORLD_COOKIE } from "./http.js";

export type Actor = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/**
 * The four headers that carry a signed request.
 *
 * Deliberately NOT folded into `Authorization`. Bearer is the default and must
 * stay byte-for-byte the path it already is — a parser that has to decide
 * between two schemes inside one header is a parser that can get the bearer
 * case wrong. Separate headers mean the bearer branch below is untouched: it
 * runs first, and a request without these headers never reaches signature code
 * at all.
 */
type SignedRequestHeaders = {
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path: string;
};

const SIG_KEY = "x-grove-key";
const SIG_TIMESTAMP = "x-grove-timestamp";
const SIG_NONCE = "x-grove-nonce";
const SIG_SIGNATURE = "x-grove-signature";

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

/**
 * Pull a signed request off the wire, or return null if the caller did not
 * send one.
 *
 * All four headers or none: a partial set is treated as absent rather than as
 * a failure, so a proxy that strips one header degrades to "no signature"
 * instead of hard-failing a caller who also sent a perfectly good bearer.
 *
 * `path` is the request path with the query string cut off — the same rule the
 * signer follows. The query string is not covered by the signature, because
 * canonicalising it (ordering, encoding, repeated keys) is where interop bugs
 * live and every such bug is an unexplainable 401 for an honest agent.
 */
function signedRequest(req: FastifyRequest): SignedRequestHeaders | null {
  const publicKey = header(req, SIG_KEY);
  const timestamp = header(req, SIG_TIMESTAMP);
  const nonce = header(req, SIG_NONCE);
  const signature = header(req, SIG_SIGNATURE);
  if (!publicKey || !timestamp || !nonce || !signature) return null;
  return {
    publicKey,
    timestamp,
    nonce,
    signature,
    method: req.method,
    path: (req.url ?? "").split("?")[0] ?? "",
  };
}

export async function requireHuman(req: FastifyRequest, grove: GroveApp): Promise<Human> {
  const sid = req.cookies[COOKIE];
  const human = await grove.identity.sessionHuman(sid);
  if (!human) throw new GroveError("UNAUTHORIZED", "Sign in required.", { httpStatus: 401 });
  return human;
}

export async function optionalHuman(req: FastifyRequest, grove: GroveApp): Promise<Human | null> {
  return grove.identity.sessionHuman(req.cookies[COOKIE]);
}

/**
 * Bearer first, signature second.
 *
 * Order matters and is the whole compatibility story: an agent presenting a
 * token takes exactly the code path it took before keypairs existed, and the
 * signature branch is only reached by a request that carried all four signing
 * headers — i.e. by a caller who explicitly opted in. Nothing here asks any
 * existing agent to change.
 *
 * A failed signature throws its own specific 401 out of the domain (bad clock,
 * reused nonce, revoked key, …) rather than the generic one, because a caller
 * who signed plainly meant to authenticate and "Agent API key required" would
 * send them hunting in the wrong place.
 */
/**
 * The id of the signature proof this request arrived with, if any. Stashed on
 * the request rather than returned, so every existing `requireAgent` call site
 * keeps its shape — a route that wants to attest the event it produced reads it,
 * and a route that does not is unaffected. Null for bearer auth and for reads.
 */
const PROOF_ID = Symbol.for("grove.proofId");

export function proofIdOf(req: FastifyRequest): string | null {
  return (req as unknown as Record<symbol, string | null>)[PROOF_ID] ?? null;
}

export async function requireAgent(req: FastifyRequest, grove: GroveApp): Promise<Agent> {
  const token = bearer(req);
  const auth = await grove.identity.authenticateAgent(token);
  if (auth) return auth.agent;
  const signed = signedRequest(req);
  if (signed) {
    const verified = await grove.identity.authenticateSignature(signed);
    (req as unknown as Record<symbol, string | null>)[PROOF_ID] = verified.proofId;
    return verified.agent;
  }
  throw new GroveError("UNAUTHORIZED", "Agent API key required.", { httpStatus: 401 });
}

export async function optionalActor(req: FastifyRequest, grove: GroveApp): Promise<Actor | null> {
  const token = bearer(req);
  if (token) {
    const auth = await grove.identity.authenticateAgent(token);
    if (auth) return { kind: "agent", agent: auth.agent };
  }
  const signed = signedRequest(req);
  if (signed) {
    // Still throws on a bad signature even though the caller is "optional".
    // Sending four signing headers is an unambiguous attempt to authenticate,
    // and silently downgrading it to anonymous would turn a reused nonce or a
    // revoked key into a mysterious permission error three layers deeper.
    return { kind: "agent", agent: (await grove.identity.authenticateSignature(signed)).agent };
  }
  const human = await optionalHuman(req, grove);
  if (human) return { kind: "human", human };
  return null;
}

export async function requireActor(req: FastifyRequest, grove: GroveApp): Promise<Actor> {
  const actor = await optionalActor(req, grove);
  if (!actor) throw new GroveError("UNAUTHORIZED", "Authentication required.", { httpStatus: 401 });
  return actor;
}

export function requireOperator(human: Human): void {
  if (human.role !== "operator") throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
}

/**
 * The world the CLIENT asked for, straight off the x-grove-world header or the
 * grove_world cookie. Deliberately NOT exported, and deliberately not a string:
 * nothing has checked that the caller may see this world, so the only way out
 * of this module is assertWorldAccess(), which enforces membership.
 */
function requestedWorldId(req: FastifyRequest): UnverifiedWorldId {
  return resolveWorldId(req.headers[WORLD_HEADER], req.cookies[WORLD_COOKIE] ?? WORLD_ID);
}

/**
 * Resolve the requested world id and prove the caller may read it. Returns the
 * world id as a plain string; every world-scoped route should get its world id
 * from here and nowhere else.
 *
 * The canonical world (WORLD_ID) is the public commons: it is returned without
 * touching the database and without requiring any authentication at all, which
 * is what keeps the logged-out landing page (world/public, world/minimap)
 * working. Every other campus requires a human who is its owner or a member —
 * campus.isMember() is the single source of that truth. For an agent caller
 * membership is evaluated against its OWNER human, so an unclaimed agent (no
 * owner) can never reach a private campus.
 *
 * Pass `actor` when the route has already authenticated one, so the token or
 * session is not re-checked; omit it and the actor is resolved lazily, only
 * when the requested world is not the commons.
 */
export async function assertWorldAccess(
  req: FastifyRequest,
  grove: GroveApp,
  actor?: Actor | null,
): Promise<string> {
  const worldId = requestedWorldId(req).requested;
  if (worldId === WORLD_ID) return worldId;
  const resolved = actor === undefined ? await optionalActor(req, grove) : actor;
  const humanId =
    resolved === null || resolved === undefined
      ? null
      : resolved.kind === "human"
        ? resolved.human.id
        : resolved.agent.ownerHumanId;
  if (!humanId || !(await grove.campus.isMember(worldId, humanId))) {
    throw new GroveError("ROOM_FORBIDDEN", "You are not a member of this campus.", { httpStatus: 403 });
  }
  return worldId;
}
