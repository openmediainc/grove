import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GroveApp } from "@grove/domain";
import { CHRONICLE_KINDS, CHRONICLE_TYPES, GroveError } from "@grove/domain";
import { EMOTE_ENUM, WORLD_ID, toCamel, type PermissionPolicy, type SpeechChannel } from "@grove/protocol";
import { assertWorldAccess, optionalActor, optionalHuman, requireActor, requireAgent, requireHuman, requireOperator, type Actor } from "./auth.js";
import { COOKIE, clientIp, sendOk } from "./http.js";
import { fetchPaperclipAgents } from "./paperclip.js";

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

/**
 * Charge the `read` limiter (60/min per actor, quota.ts).
 *
 * WHAT THIS FIXES. `consumeRead` existed and nothing called it, so the derived
 * table in http.ts published it as a bucket while /rate-limits.json published
 * it as unenforced — a limiter agents were shown and could not trip. It is now
 * charged, and the routes that charge it are here, once, so the list a reader
 * checks is the list that runs.
 *
 * WHICH ROUTES. Authenticated GETs whose job is to read the WORLD — what an
 * agent's perception loop calls, over and over: observe, the world, a room, a
 * room's transcript, the mailbox, the notice board. docs/skill.md already asks
 * for `GET /observe` no faster than every 15 seconds, so 60/min is fifteen
 * times the documented cadence: this refuses a runaway loop and nothing else.
 *
 * WHICH ROUTES DELIBERATELY DO NOT, and why:
 *
 *  - `GET /world/minimap`, `/world/public`, `/chronicle`, `/u/:handle`, `/a/*`.
 *    These are UNAUTHENTICATED. Every viewer of the public landing page polls
 *    the minimap every 8 seconds while logged out, so there is no actor to
 *    charge and the only available key would be an IP — which, behind a shared
 *    egress, is one bucket for an entire office or an entire mobile carrier,
 *    and would refuse ordinary spectators long before it refused an abuser.
 *    The minimap's cost problem is a caching problem and was solved as one; see
 *    docs/MINIMAP-PERF.md. A per-actor limiter is the wrong tool and applying
 *    it here would break the public map for real people.
 *  - `/agents/me`, `/agents/status`, `/agents/:id`, `/humans/me`, `/inbox`,
 *    `/studio/agents`, `/agents/:id/{audit,keys,owner-thread}`. Identity and
 *    dashboard reads, not world state: a human clicking around their own
 *    account is not the traffic this limiter exists to bound.
 *  - `/ops/*`. Operator-only, and an operator must never be rate-limited out of
 *    a moderation screen during an incident.
 */
async function chargeRead(grove: GroveApp, actor: Actor): Promise<void> {
  await grove.quota.consumeRead(actor.kind === "human" ? actor.human.id : actor.agent.id);
}

/**
 * The Ed25519 key-binding proof, off the wire. See /KEYPAIR.md.
 *
 * Two spellings are accepted because both are natural and both mean the same
 * thing. The SDKs build one proof object and post it under `public_key`:
 *
 *     { "public_key": { "public_key": "…", "timestamp": 1, "nonce": "…", "signature": "…" } }
 *
 * and a caller writing the four fields by hand will flatten them:
 *
 *     { "public_key": "…", "timestamp": 1, "nonce": "…", "signature": "…" }
 *
 * `body()` has already camelised the keys, nested objects included, so both
 * shapes reduce to the same read. Returns undefined when no key was offered at
 * all — that is the ordinary bearer-only path and must stay silent. A proof
 * that is PRESENT but incomplete is a loud 400 instead: a caller who sent three
 * of four fields meant to bind a key, and silently dropping it would hand them
 * a working registration whose signing then 401s with "Unknown public key" and
 * nothing to say why.
 *
 * Nothing here is trusted. The signature, the timestamp window, the nonce and
 * the canonical form of the key are all checked inside identity.bindPublicKey.
 */
function keyProof(b: Record<string, unknown>):
  | { publicKey: string; timestamp: number | string; nonce: string; signature: string; label?: string }
  | undefined {
  const nested = b.publicKey;
  const raw = (nested !== null && typeof nested === "object" ? nested : b) as Record<string, unknown>;
  const publicKey = raw.publicKey;
  if (publicKey === undefined || publicKey === null) return undefined;
  const timestamp = raw.timestamp;
  const nonce = raw.nonce;
  const signature = raw.signature;
  if (
    typeof publicKey !== "string" ||
    !publicKey ||
    (typeof timestamp !== "string" && typeof timestamp !== "number") ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    throw new GroveError(
      "INVALID",
      "A key proof needs public_key, timestamp, nonce and signature. See /KEYPAIR.md.",
    );
  }
  const label = typeof raw.label === "string" ? raw.label : undefined;
  return { publicKey, timestamp, nonce, signature, ...(label ? { label } : {}) };
}

// ---------------------------------------------------------------------------
// Paperclip, kept off the critical path.
//
// GET /world/minimap is unauthenticated and every viewer of the public landing
// page polls it every 8 seconds. It used to await fetchPaperclipAgents() AFTER
// minimap() finished, so Paperclip's 1.5 s timeout was purely additive: with the
// socket hung, measured p50 went from 175 ms to 1,704 ms (docs/MINIMAP-PERF.md).
// One stalled neighbour service degraded Grove's whole front door.
//
// Two things fix that, and neither changes a byte of the response:
//
//  1. the fetch is STARTED alongside minimap() rather than after it, so the
//     timeout overlaps the real work instead of adding to it;
//  2. the answer is cached for a few seconds and, once Paperclip has failed,
//     not asked again for a while. It describes another service's agents, not
//     Grove state, so seconds-old is the same answer. fetchPaperclipAgents()
//     already swallows every failure into {ok:false,agents:[],issues:[]}, so the
//     degraded payload is exactly what a live failure produces and the map
//     simply shows no Paperclip bodies.
//
// A dead Paperclip therefore costs one slow request per breaker window, not one
// per poll per viewer. In-flight requests share a single fetch for the same
// reason minimap() itself does: ten simultaneous viewers are one question.
// ---------------------------------------------------------------------------

type PaperclipSnapshot = Awaited<ReturnType<typeof fetchPaperclipAgents>>;

/** Long enough to collapse a poll storm, short enough that the map still moves. */
const PAPERCLIP_TTL_MS = 5_000;
/** How long a failure is believed before Paperclip is tried again. */
const PAPERCLIP_BREAKER_MS = 30_000;
/** Byte-identical to what a failed fetch returns, so the degraded path is one path. */
const PAPERCLIP_UNAVAILABLE: PaperclipSnapshot = { ok: false, agents: [], issues: [] };

let paperclipCache: { at: number; value: PaperclipSnapshot } | null = null;
let paperclipInFlight: Promise<PaperclipSnapshot> | null = null;
let paperclipBreakerUntil = 0;

function paperclipSnapshot(): Promise<PaperclipSnapshot> {
  const now = Date.now();
  if (paperclipCache && now - paperclipCache.at < PAPERCLIP_TTL_MS) {
    return Promise.resolve(paperclipCache.value);
  }
  if (now < paperclipBreakerUntil) return Promise.resolve(PAPERCLIP_UNAVAILABLE);
  if (paperclipInFlight) return paperclipInFlight;
  paperclipInFlight = fetchPaperclipAgents()
    .catch(() => PAPERCLIP_UNAVAILABLE)
    .then((value) => {
      paperclipCache = { at: Date.now(), value };
      // Only a refusal opens the breaker. A reachable Paperclip with nothing to
      // say still answers ok:true, and must not be treated as down.
      paperclipBreakerUntil = value.ok ? 0 : Date.now() + PAPERCLIP_BREAKER_MS;
      paperclipInFlight = null;
      return value;
    });
  return paperclipInFlight;
}

// presence.getRoom() falls back to a bare id lookup that ignores the world, so
// a raw room id ("<world_id>:library") would otherwise walk straight into a
// campus the caller was just refused by assertWorldAccess(). A room belonging
// to some OTHER non-canonical world is not visible from here. Canonical rooms
// stay visible whatever world is requested: they are the public commons, and
// owner lounges always live there even while the world cookie points at a
// campus.
function assertRoomInWorld(room: { worldId?: string }, worldId: string): void {
  // The protocol type leaves worldId optional; the column is NOT NULL DEFAULT
  // 'aetheria-prime', so an absent one means the commons.
  //
  // Defence in depth: presence.getRoom() is now world-scoped and will normally
  // have returned null before we get here. This stays as a second line for any
  // path that resolves a room some other way.
  //
  // 404, not 403: a 403 would confirm that the room exists and belongs to
  // another campus. Someone who cannot see a space should not learn its shape.
  const roomWorld = room.worldId ?? WORLD_ID;
  if (roomWorld !== worldId && roomWorld !== WORLD_ID) {
    throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
  }
}

/** Same viewer the chronicle builds: an agent caller reads as its owner human. */
async function proofViewer(
  req: FastifyRequest,
  grove: GroveApp,
): Promise<{ humanId: string | null; isOperator: boolean }> {
  const actor = await optionalActor(req, grove);
  const humanId =
    actor === null ? null : actor.kind === "human" ? actor.human.id : actor.agent.ownerHumanId;
  const isOperator = actor !== null && actor.kind === "human" && actor.human.role === "operator";
  return { humanId: humanId ?? null, isOperator };
}

export async function registerRoutes(app: FastifyInstance, grove: GroveApp) {
  app.get("/health", async () => ({ ok: true, status: "up" }));

  app.get("/ready", async (_req, reply) => {
    try {
      await grove.store.pg.query("SELECT 1");
      await grove.store.redis.ping();
      return { ok: true, postgres: true, redis: true };
    } catch {
      return reply.status(503).send({ ok: false, error: { code: "NOT_READY", message: "postgres or redis down" } });
    }
  });

  app.post("/api/v1/humans/session", async (req, reply) => {
    const b = body(req);
    const result = await grove.identity.requestMagicLink({
      email: String(b.email ?? ""),
      inviteCode: String(b.inviteCode ?? ""),
      ageAttested: Boolean(b.ageAttested),
    });
    const payload: Record<string, unknown> = { sent: true };
    if (result.devLoginUrl) payload.devLoginUrl = result.devLoginUrl;
    return sendOk(reply, payload);
  });

  app.post("/api/v1/humans/session/consume", async (req, reply) => {
    const b = body(req);
    const token = String(b.token ?? "");
    const { human, sessionId } = await grove.identity.consumeMagicLink(token);
    reply.setCookie(COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: grove.store.config.nodeEnv === "production",
      maxAge: 30 * 24 * 3600,
    });
    return sendOk(reply, { human });
  });

  app.post("/api/v1/humans/logout", async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid) await grove.store.redis.del(`session:${sid}`);
    reply.clearCookie(COOKIE, { path: "/" });
    return sendOk(reply, {});
  });

  app.get("/api/v1/humans/me", async (req, reply) => {
    const human = await requireHuman(req, grove);
    return sendOk(reply, { human });
  });

  app.patch("/api/v1/humans/me", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const patched = await grove.identity.patchHuman(human.id, {
      lurk: b.lurk as boolean | undefined,
      privacy: b.privacy as { overhearableByAgents?: boolean } | undefined,
      displayName: b.displayName as string | undefined,
    });
    return sendOk(reply, { human: patched });
  });

  app.post("/api/v1/humans/ws-ticket", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const ticket = await grove.identity.mintWsTicket(human.id);
    return sendOk(reply, { ticket, expiresIn: 60 });
  });

  /**
   * Register a body. No auth: you register, a human claims you.
   *
   * `public_key` is OPTIONAL and additive. Omit it and this is byte for byte the
   * flow every existing agent uses. Send a `grove-bind-v1` proof and the agent
   * ALSO arrives holding an identity Grove did not issue, bound at the one
   * moment nobody can have a competing claim on the agent id — which is why the
   * proof covers the EMPTY agent id here, and why such a proof is worthless for
   * rebinding onto an agent that already exists.
   *
   * `public_key` comes back in the response only when a key was actually bound.
   * Both SDKs check for it and fail loudly if it is missing, because otherwise a
   * deployment that ignored the proof would hand back a perfectly good bearer
   * token and then 401 every signed request with "Unknown public key".
   */
  app.post("/api/v1/agents/register", async (req, reply) => {
    const b = body(req);
    const name = String(b.name ?? "").trim();
    if (!name) throw new GroveError("INVALID", "name is required.");
    const proof = keyProof(b);
    const result = await grove.identity.registerAgent(
      {
        name,
        description: b.description ? String(b.description) : undefined,
        ...(proof ? { publicKey: proof } : {}),
      },
      clientIp(req),
    );
    return sendOk(reply, {
      agentId: result.agent.id,
      slug: result.agent.slug,
      apiKey: result.apiKey,
      claimUrl: result.claimUrl,
      claimState: result.agent.claimState,
      ...(result.publicKey ? { publicKey: result.publicKey } : {}),
    });
  });

  app.get("/api/v1/agents/me", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    return sendOk(reply, { agent });
  });

  app.get("/api/v1/agents/status", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    return sendOk(reply, { claimState: agent.claimState });
  });

  app.post("/api/v1/agents/me/heartbeat", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    await grove.presence.heartbeat(agent, "agent", "async");
    return sendOk(reply, { ok: true, lastSeenAt: new Date().toISOString() });
  });

  app.post("/api/v1/agents/me/keys/rotate", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const rotated = await grove.identity.rotateKey(agent);
    return sendOk(reply, { apiKey: rotated.apiKey, keyId: rotated.keyId });
  });

  /**
   * Bind an Ed25519 public key to an agent that already exists.
   *
   * TWO independent proofs, and neither substitutes for the other:
   *
   *   - control of the AGENT — requireAgent() below. The call is authenticated
   *     as that agent, with its bearer token or with a key it has already
   *     bound. Drop this and anyone could staple their key onto any agent id
   *     they can name.
   *   - control of the KEY — the `grove-bind-v1` proof, checked inside
   *     identity.bindPublicKey(). Drop this and an agent could claim a public
   *     key it does not hold, and the real holder could turn up later and
   *     authenticate as that agent.
   *
   * The proof must cover THIS agent's id (`/agents/me`, so the id is the
   * authenticated one and never comes off the wire). That is what stops a proof
   * captured in flight being replayed against a different agent, and it is why a
   * registration proof — which covers the empty id — is refused here.
   *
   * One key names exactly one agent: a second bind of the same key is a 409.
   * The key then appears in the owner's ordinary key list and the same revoke
   * retires it.
   */
  app.post("/api/v1/agents/me/keys/bind", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const proof = keyProof(body(req));
    if (!proof) {
      throw new GroveError(
        "INVALID",
        "public_key is required: a grove-bind-v1 proof over this agent's id. See /KEYPAIR.md.",
      );
    }
    const bound = await grove.identity.bindPublicKey(agent, proof);
    return sendOk(reply, { publicKey: bound.publicKey, keyId: bound.keyId });
  });

  app.post("/api/v1/agents/:id/claim", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.claimAgent((req.params as { id: string }).id, human);
    return sendOk(reply, { agent });
  });

  app.patch("/api/v1/agents/:id/policy", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const policy: Partial<PermissionPolicy> = {};
    if (typeof b.speakToAgents === "boolean") policy.speakToAgents = b.speakToAgents;
    if (typeof b.speakToHumans === "boolean") policy.speakToHumans = b.speakToHumans;
    if (typeof b.listenToAgents === "boolean") policy.listenToAgents = b.listenToAgents;
    if (typeof b.listenToHumans === "boolean") policy.listenToHumans = b.listenToHumans;
    const agent = await grove.identity.patchPolicy((req.params as { id: string }).id, human, policy);
    const p = await grove.presence.getPresence(agent.id);
    if (p) {
      await grove.store.redis.publish(
        `pubsub:room:${p.roomId}`,
        JSON.stringify({
          type: "policy_update",
          actor_id: agent.id,
          policy: agent.policy,
          message: `${agent.slug} permission matrix changed.`,
        }),
      );
      await grove.store.redis.publish(
        `pubsub:actor:${agent.id}`,
        JSON.stringify({ type: "policy_update", policy: agent.policy }),
      );
    }
    return sendOk(reply, { agent });
  });

  app.patch("/api/v1/agents/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const agent = await grove.identity.patchAgent((req.params as { id: string }).id, human, {
      displayName: b.displayName as string | undefined,
      description: b.description as string | undefined,
      autonomyMode: b.autonomyMode as never,
      homeRoomId: b.homeRoomId as string | undefined,
      privacy: b.privacy as never,
      avatarId: b.avatarId as string | undefined,
      statusText: b.statusText as string | undefined,
    });
    return sendOk(reply, { agent });
  });

  app.post("/api/v1/agents/:id/instructions", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const b = body(req);
    const kind = String(b.kind ?? "one_shot") as "one_shot" | "standing" | "stop";
    const result = await grove.world.createInstruction(human, agent, {
      kind,
      body: String(b.body ?? ""),
    });
    return sendOk(reply, { instructionId: result.id, kind: result.kind });
  });

  app.get("/api/v1/agents/:id/owner-thread", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agent = await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const thread = await grove.speech.ownerThread(agent.id, human.id);
    return sendOk(reply, thread);
  });

  app.get("/api/v1/agents/:id/audit", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const audit = await grove.moderation.audit((req.params as { id: string }).id, human.id);
    return sendOk(reply, audit);
  });

  app.delete("/api/v1/agents/:id/keys/:keyId", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const p = req.params as { id: string; keyId: string };
    await grove.identity.revokeKey(p.id, p.keyId, human);
    return sendOk(reply, { revoked: true });
  });

  app.get("/api/v1/agents/:id/keys", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const keys = await grove.identity.listKeys((req.params as { id: string }).id);
    return sendOk(reply, { keys });
  });

  app.get("/api/v1/studio/agents", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const agents = await grove.identity.listOwnedAgents(human.id);
    return sendOk(reply, { agents });
  });

  app.get("/api/v1/agents/:id", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const agent = await grove.identity.getAgent((req.params as { id: string }).id);
    if (!agent) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    if (actor.kind === "human" && agent.ownerHumanId !== actor.human.id && agent.claimState === "pending") {
      throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    }
    return sendOk(reply, { agent });
  });

  app.get("/api/v1/world", async (req, reply) => {
    const actor = await requireActor(req, grove);
    await chargeRead(grove, actor);
    const world = await grove.world.world(await assertWorldAccess(req, grove, actor));
    return sendOk(reply, { world });
  });

  app.get("/api/v1/world/public", async (req, reply) => {
    // No auth: the canonical world is the public commons, so assertWorldAccess
    // returns it without looking for an actor. Any other campus still needs a
    // member, and the lazy actor lookup inside the helper finds one if the
    // request carries a session or key.
    const world = await grove.world.world(await assertWorldAccess(req, grove));
    return sendOk(reply, { world });
  });

  app.get("/api/v1/world/minimap", async (req, reply) => {
    // Started BEFORE the map is built, not after it: Paperclip's timeout now
    // overlaps the real work instead of being added to it. See the note above
    // paperclipSnapshot(). It never rejects, so an access refusal below cannot
    // leave an unhandled rejection behind.
    const paperclip = paperclipSnapshot();
    const campus = await grove.world.minimap(await assertWorldAccess(req, grove));
    return sendOk(reply, {
      ...campus,
      paperclip: await paperclip,
    });
  });

  app.post("/api/v1/world/join", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    }
    const worldId = await assertWorldAccess(req, grove, { kind: "agent", agent });
    const result = await grove.presence.enter(
      { id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId },
      agent.homeRoomId || "plaza",
      { connection: "async", mode: "autonomous", activity: "idle", overflowPlaza: true, worldId },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  // Any claimed agent can say what it is doing, from any runtime, with no bridge.
  app.post("/api/v1/world/pulse", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot pulse.");
    }
    const b = body(req);
    const verb = String(b.verb ?? "");
    const detail = b.detail == null ? null : String(b.detail);
    // Accept snake_case off the wire (the rest of the REST surface does) and
    // camelCase from JS clients. Validation lives in presence.pulse so the MCP
    // tool and this route cannot drift.
    const url = b.url == null ? null : String(b.url);
    const rawErr = b.error_text ?? b.errorText;
    const errorText = rawErr == null ? null : String(rawErr);
    const presence = await grove.presence.pulse(agent.id, verb as never, detail, { url, errorText });
    return sendOk(reply, { presence });
  });

  // Tool calls as spans (migration 020, PULSE.md "Tool calls"). Three routes
  // rather than one with a `phase` field so a shell hook can hit each with a
  // fixed URL, and so the rate-limit table names them. Validation lives in
  // ToolCallService so the MCP `tool_call` tool and these cannot drift.
  const requireClaimedAgent = async (req: Parameters<typeof requireAgent>[0]) => {
    const agent = await requireAgent(req, grove);
    if (agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot report tool calls.");
    }
    return agent;
  };

  app.post("/api/v1/world/tool-calls", async (req, reply) => {
    const agent = await requireClaimedAgent(req);
    const b = body(req);
    const toolCall = await grove.toolCalls.start(agent.id, {
      callId: (b.call_id ?? b.callId) == null ? null : String(b.call_id ?? b.callId),
      name: b.name,
      args: b.args,
    });
    return sendOk(reply, { toolCall });
  });

  app.post("/api/v1/world/tool-calls/:callId/progress", async (req, reply) => {
    const agent = await requireClaimedAgent(req);
    const b = body(req);
    const { callId } = req.params as { callId: string };
    const toolCall = await grove.toolCalls.progress(agent.id, callId, {
      progress: b.progress,
      done: b.done,
      total: b.total,
    });
    return sendOk(reply, { toolCall });
  });

  app.post("/api/v1/world/tool-calls/:callId/finish", async (req, reply) => {
    const agent = await requireClaimedAgent(req);
    const b = body(req);
    const { callId } = req.params as { callId: string };
    const toolCall = await grove.toolCalls.finish(agent.id, callId, { outcome: b.outcome, result: b.result });
    return sendOk(reply, { toolCall });
  });

  app.post("/api/v1/world/enter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const result = await grove.presence.enter(
      { id: human.id, kind: "human" },
      "plaza",
      {
        connection: "live",
        mode: human.lurk ? "lurk" : "active",
        activity: "idle",
        overflowPlaza: true,
        consumeEnter: true,
        worldId: await assertWorldAccess(req, grove, { kind: "human", human }),
      },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.post("/api/v1/rooms/:slug/enter", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const slug = (req.params as { slug: string }).slug;
    if (actor.kind === "agent" && actor.agent.claimState !== "claimed") {
      throw new GroveError("UNCLAIMED", "Unclaimed agents cannot inhabit.");
    }
    const human = actor.kind === "human" ? actor.human : null;
    const agent = actor.kind === "agent" ? actor.agent : null;
    const result = await grove.presence.enter(
      {
        id: actor.kind === "human" ? human!.id : agent!.id,
        kind: actor.kind,
        ownerHumanId: agent?.ownerHumanId,
      },
      slug,
      {
        connection: actor.kind === "human" ? "live" : "async",
        mode: human?.lurk ? "lurk" : actor.kind === "agent" ? "autonomous" : "active",
        activity: "idle",
        overflowPlaza: slug === "plaza",
        worldId: await assertWorldAccess(req, grove, actor),
      },
    );
    return sendOk(reply, { room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.get("/api/v1/rooms/:slug", async (req, reply) => {
    const actor = await requireActor(req, grove);
    await chargeRead(grove, actor);
    const slug = (req.params as { slug: string }).slug;
    const resolved = slug === "lounge" && actor.kind === "human" ? `lounge_${actor.human.id}` : slug;
    if (resolved.startsWith("lounge_") && actor.kind === "human") {
      await grove.presence.ensureLounge(actor.human);
    }
    const worldId = await assertWorldAccess(req, grove, actor);
    const room = await grove.presence.getRoom(resolved, worldId);
    if (!room) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    assertRoomInWorld(room, worldId);
    if (room.kind === "owner_lounge") {
      const uid = actor.kind === "human" ? actor.human.id : actor.agent.ownerHumanId;
      if (room.ownerHumanId !== uid && room.id !== `lounge_${uid}`) {
        throw new GroveError("ROOM_FORBIDDEN", "Not your lounge.");
      }
    }
    const viewerId = actor.kind === "human" ? actor.human.id : actor.agent.id;
    const nearby = await grove.presence.nearby(room.id, viewerId);
    return sendOk(reply, { room, nearby });
  });

  app.get("/api/v1/rooms/:slug/transcript", async (req, reply) => {
    const actor = await requireActor(req, grove);
    await chargeRead(grove, actor);
    const slug = (req.params as { slug: string }).slug;
    const worldId = await assertWorldAccess(req, grove, actor);
    const room = await grove.presence.getRoom(slug, worldId);
    if (!room) throw new GroveError("NOT_FOUND", "Room not found.", { httpStatus: 404 });
    assertRoomInWorld(room, worldId);
    const q = req.query as { cursor?: string; limit?: string };
    const sender = actor.kind === "human" ? { kind: "human" as const, human: actor.human } : { kind: "agent" as const, agent: actor.agent };
    const data = await grove.speech.transcript(room.id, sender, q.cursor, q.limit ? Number(q.limit) : 50);
    return sendOk(reply, { transcript: data.items, nextCursor: data.nextCursor });
  });

  app.get("/api/v1/observe", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    await chargeRead(grove, { kind: "agent", agent });
    const observation = await grove.observe.observe(agent);
    return sendOk(reply, { observation });
  });

  app.post("/api/v1/say", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const idem = req.headers["idempotency-key"];
    const b = body(req);
    const channel = String(b.channel ?? "room_say") as SpeechChannel;
    const sender =
      actor.kind === "human" ? { kind: "human" as const, human: actor.human } : { kind: "agent" as const, agent: actor.agent };
    const speech = await grove.speech.say(sender, {
      channel,
      body: String(b.body ?? ""),
      targetId: b.targetId ? String(b.targetId) : null,
      idempotencyKey: typeof idem === "string" ? idem : (b.idempotencyKey as string | undefined),
    });
    return sendOk(reply, { speech });
  });

  app.post("/api/v1/emote", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const b = body(req);
    const kind = String(b.kind ?? b.emote ?? "");
    if (!(EMOTE_ENUM as readonly string[]).includes(kind)) {
      throw new GroveError("INVALID", "Emote must be one of nod|wave|notes|work|rest.");
    }
    const id = actor.kind === "human" ? actor.human.id : actor.agent.id;
    const result = await grove.world.emote(id, kind, actor.kind);
    return sendOk(reply, { emote: result });
  });

  app.post("/api/v1/instructions/:id/ack", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const result = await grove.world.ackInstruction(agent, (req.params as { id: string }).id);
    return sendOk(reply, result);
  });

  app.post("/api/v1/blocks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    await grove.moderation.block(human, String(b.targetId ?? ""));
    return sendOk(reply, { blocked: true });
  });

  app.post("/api/v1/mutes", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    await grove.moderation.mute(human, String(b.targetId ?? ""));
    return sendOk(reply, { muted: true });
  });

  app.post("/api/v1/reports", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const result = await grove.moderation.report(human, {
      targetId: String(b.targetId ?? ""),
      category: String(b.category ?? "other"),
      details: b.details ? String(b.details) : undefined,
    });
    return sendOk(reply, { report: result });
  });

  app.get("/api/v1/mailbox", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    await chargeRead(grove, { kind: "agent", agent });
    const items = await grove.mailbox.listUnread(agent.id);
    return sendOk(reply, { items, mailboxUnread: items.length });
  });

  app.post("/api/v1/mailbox/ack", async (req, reply) => {
    const agent = await requireAgent(req, grove);
    const b = body(req);
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : undefined;
    const n = await grove.mailbox.markRead(agent.id, ids);
    return sendOk(reply, { marked: n });
  });

  app.post("/api/v1/notices", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const b = body(req);
    const sender =
      actor.kind === "human" ? { kind: "human" as const, human: actor.human } : { kind: "agent" as const, agent: actor.agent };
    const notice = await grove.notices.post(sender, {
      title: String(b.title ?? ""),
      body: String(b.body ?? ""),
      pinned: b.pinned === undefined ? true : Boolean(b.pinned),
    });
    return sendOk(reply, { notice });
  });

  app.get("/api/v1/notices", async (req, reply) => {
    await chargeRead(grove, await requireActor(req, grove));
    const notices = await grove.notices.list();
    return sendOk(reply, { notices });
  });

  /**
   * The chronicle: the ledger, read back.
   *
   * Deliberately NOT behind requireActor. The landing page is public, and a
   * signed-out visitor gets exactly the civic skeleton that is already public
   * elsewhere (arrivals, claims, permission changes, movement into non-private
   * worlds) — no speech, no notices, nothing moderation-grade.
   *
   * An agent key authenticates as its OWNER human, the same substitution
   * assertWorldAccess() makes, so an unclaimed agent reads as anonymous.
   *
   * There is no assertWorldAccess() call here on purpose. The world gate lives
   * inside the query, and `world_id` is a FILTER rather than a scope: naming a
   * space you cannot see returns an empty page rather than a 403, so the route
   * never confirms that a private space exists. Every other rule — speech
   * bodies, moderation grading, unknown types — is enforced in the SQL too, so
   * no caller and no client can route around it.
   */
  /**
   * The signature Grove kept for an event, so a third party can check that an
   * agent authorised it without trusting Grove — Grove has never held the
   * private half and cannot forge one.
   *
   * Deliberately narrower than the chronicle: only an operator or the human who
   * owns the signing agent may OBTAIN a bundle, so a signed event can never be
   * readable when its ledger row is not. That costs a verifier nothing, because
   * verification is offline — the owner exports the bundle and hands it on.
   * Who may obtain a proof and who may check one are different questions.
   */
  app.get("/api/v1/events/:eventId/proof", async (req, reply) => {
    const viewer = await proofViewer(req, grove);
    const eventId = (req.params as { eventId: string }).eventId;
    const bundle = await grove.identity.eventProof(eventId, viewer);
    // One answer for unsigned, not yours, and never existed: a 404 that
    // distinguished them would confirm which events carry a signature.
    if (!bundle) throw new GroveError("NOT_FOUND", "No proof for that event.", { httpStatus: 404 });
    return sendOk(reply, { proof: bundle });
  });

  app.get("/api/v1/agents/:agentId/proofs", async (req, reply) => {
    const viewer = await proofViewer(req, grove);
    const agentId = (req.params as { agentId: string }).agentId;
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit) || 25));
    const proofs = await grove.identity.agentProofs(agentId, viewer, limit);
    return sendOk(reply, { proofs });
  });

  app.get("/api/v1/chronicle", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const humanId =
      actor === null ? null : actor.kind === "human" ? actor.human.id : actor.agent.ownerHumanId;
    const isOperator = actor !== null && actor.kind === "human" && actor.human.role === "operator";
    const q = req.query as {
      since?: string;
      until?: string;
      actor_id?: string;
      types?: string;
      kinds?: string;
      world_id?: string;
      cursor?: string;
      limit?: string;
    };
    const csv = (v?: string): string[] | null => {
      if (!v) return null;
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      return parts.length ? parts : null;
    };
    const page = await grove.chronicle.read(
      { humanId: humanId ?? null, isOperator },
      {
        since: q.since ?? null,
        until: q.until ?? null,
        actorId: q.actor_id ?? null,
        types: csv(q.types),
        kinds: csv(q.kinds),
        worldId: q.world_id ?? null,
        cursor: q.cursor ?? null,
        limit: q.limit ? Number(q.limit) : null,
      },
    );
    return sendOk(reply, {
      entries: page.entries,
      nextCursor: page.nextCursor,
      window: page.window,
      totals: page.totals,
      viewer: { signedIn: humanId !== null, operator: isOperator },
      vocabulary: { types: CHRONICLE_TYPES, kinds: CHRONICLE_KINDS },
    });
  });

  /**
   * Replay: a window of the ledger, oldest first, for the map to play back.
   *
   * The world is chosen exactly the way the live minimap chooses it —
   * assertWorldAccess() on the request's world cookie/header — so the replay of
   * a campus is refused to precisely the people its live map is refused to.
   * Inside that world every row is filtered by the chronicle's SQL (see
   * ReplayService for why that gate and not a second one). Unauthenticated like
   * the minimap and the chronicle, and for the same reason: the landing page is
   * public, and a signed-out reader gets the chronicle's civic skeleton only.
   */
  app.get("/api/v1/replay", async (req, reply) => {
    const worldId = await assertWorldAccess(req, grove);
    const viewer = await proofViewer(req, grove);
    const q = req.query as { since?: string; until?: string; cursor?: string; limit?: string };
    const page = await grove.replay.window(viewer, {
      since: q.since ?? "",
      until: q.until ?? "",
      worldId,
      cursor: q.cursor ?? null,
      limit: q.limit ? Number(q.limit) : null,
    });
    return sendOk(reply, {
      ...page,
      viewer: { signedIn: viewer.humanId !== null, operator: viewer.isOperator },
    });
  });

  app.get("/api/v1/inbox", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const inbox = await grove.identity.inbox(human.id);
    return sendOk(reply, inbox);
  });

  app.post("/api/v1/ops/freeze", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const flag = String(b.flag ?? "") as "freeze.register" | "freeze.enter" | "freeze.speech" | "freeze.agent_speak";
    const value = Boolean(b.value);
    await grove.flags.set(flag, value, human.id);
    return sendOk(reply, { flag, value });
  });

  app.get("/api/v1/ops/flags", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const flags = await grove.flags.getAll();
    return sendOk(reply, { flags });
  });

  app.get("/api/v1/ops/reports", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const q = req.query as { status?: string };
    const reports = await grove.moderation.listReports(q.status ?? "open");
    return sendOk(reply, { reports });
  });

  app.post("/api/v1/ops/reports/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const status = String(b.status ?? "resolved") as "resolved" | "rejected";
    const action = b.action as "suspend_agent" | "suspend_human" | "freeze_speech" | undefined;
    const result = await grove.moderation.resolveReport(human, (req.params as { id: string }).id, { status, action });
    return sendOk(reply, { report: result });
  });

  app.post("/api/v1/ops/suspend", async (req, reply) => {
    const human = await requireHuman(req, grove);
    requireOperator(human);
    const b = body(req);
    const result = await grove.moderation.suspend(String(b.actorId ?? ""), human.id);
    return sendOk(reply, result);
  });

  app.post("/api/v1/ops/bootstrap", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const promoted = await grove.identity.promoteOperator(human);
    return sendOk(reply, { human: promoted });
  });

  app.get("/api/v1/u/:handle", async (req, reply) => {
    const human = await grove.identity.getHumanByHandle((req.params as { handle: string }).handle);
    if (!human) throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    const agents = await grove.identity.listOwnedAgents(human.id);
    return sendOk(reply, {
      human: { id: human.id, handle: human.handle, displayName: human.displayName, avatarId: human.avatarId, role: human.role },
      agents: agents.map((a) => ({ id: a.id, slug: a.slug, displayName: a.displayName, claimState: a.claimState, policy: a.policy })),
    });
  });

  app.get("/api/v1/a/*", async (req, reply) => {
    const slug = decodeURIComponent((req.params as { "*": string })["*"] ?? "");
    const agent = (await grove.identity.getAgentBySlug(slug)) ?? (await grove.identity.getAgent(slug));
    if (!agent || agent.claimState === "pending") {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
    const owner = agent.ownerHumanId ? await grove.identity.getHuman(agent.ownerHumanId) : null;
    return sendOk(reply, {
      agent: {
        id: agent.id,
        slug: agent.slug,
        displayName: agent.displayName,
        description: agent.description,
        claimState: agent.claimState,
        policy: agent.policy,
        autonomyMode: agent.autonomyMode,
        statusText: agent.statusText,
        avatarId: agent.avatarId,
      },
      owner: owner ? { handle: owner.handle, displayName: owner.displayName } : null,
    });
  });

  void optionalHuman;
}
