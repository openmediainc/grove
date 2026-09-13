import type { FastifyInstance, FastifyReply } from "fastify";
import type { GroveApp } from "@grove/domain";
import { GroveError, isFirst24h } from "@grove/domain";
import { SPACE_POLICY_PRESETS, WORLD_ID, toCamel, type SpacePolicyPreset } from "@grove/protocol";
import { assertWorldAccess, optionalHuman, requireActor, requireHuman, requireOperator } from "./auth.js";
import { WORLD_COOKIE, sendOk } from "./http.js";

const PRESET_NAMES = Object.keys(SPACE_POLICY_PRESETS);

/**
 * Wire -> SpacePolicyPreset. `worlds.policy_preset` carries a CHECK constraint,
 * so an unknown value must be refused here as an INVALID; letting it reach the
 * database would surface as an opaque 500.
 */
function readPreset(value: unknown): SpacePolicyPreset {
  if (typeof value === "string" && (PRESET_NAMES as string[]).includes(value)) {
    return value as SpacePolicyPreset;
  }
  throw new GroveError("INVALID", `policy_preset must be one of: ${PRESET_NAMES.join(", ")}.`);
}

function body(req: { body: unknown }): Record<string, unknown> {
  return (toCamel(req.body ?? {}) as Record<string, unknown>) ?? {};
}

function setWorldCookie(reply: FastifyReply, grove: GroveApp, worldId: string) {
  reply.setCookie(WORLD_COOKIE, worldId, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    secure: grove.store.config.nodeEnv === "production",
    maxAge: 30 * 24 * 3600,
  });
}

export async function registerPlatform(app: FastifyInstance, grove: GroveApp) {
  app.get("/api/v1/worlds", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const worlds = await grove.campus.listForHuman(human.id);
    return sendOk(reply, { worlds });
  });

  app.post("/api/v1/worlds", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const world = await grove.campus.createWorld(human, {
      name: String(b.name ?? ""),
      slug: String(b.slug ?? ""),
      ...(b.policyPreset === undefined ? {} : { preset: readPreset(b.policyPreset) }),
    });
    return sendOk(reply, { world }, 201);
  });

  // The space directory. Deliberately readable signed-out: a claimed plot is
  // public knowledge (the minimap already shows it). listDirectory() does the
  // redacting, so a private space the viewer is not in returns its plot and
  // access level and nothing more.
  app.get("/api/v1/worlds/directory", async (req, reply) => {
    const human = await optionalHuman(req, grove);
    const spaces = await grove.campus.listDirectory(human?.id ?? null);
    return sendOk(reply, { spaces });
  });

  // One space, with its rooms and members. Membership gates the detail: a
  // non-member of a private space gets a 404 rather than a shape that confirms
  // what is inside, matching assertOperate's "hide it entirely" convention.
  app.get("/api/v1/worlds/:id", async (req, reply) => {
    const human = await optionalHuman(req, grove);
    const world = await grove.campus.requireWorld((req.params as { id: string }).id);
    const isMember = human ? await grove.campus.isMember(world.id, human.id) : false;
    if (world.policyPreset === "private" && !isMember) {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
    const [rooms, members, orgRender] = await Promise.all([
      grove.campus.roomsOf(world.id),
      // A public space lists its rooms to anyone, but who is inside it is
      // member-only: presence is not permission state.
      isMember ? grove.campus.membersOf(world.id) : Promise.resolve([]),
      grove.campus.orgRenderFor(world.id),
    ]);
    return sendOk(reply, {
      world,
      rooms,
      members,
      isMember,
      isOwner: Boolean(human && grove.campus.canOperate(human, world)),
      // Enough for a renderer to tint a body by its org: which orgs are bound,
      // in what mode, and the per-body assignment the mode resolves to. The
      // per-body list follows the roster, so it is member-only for the same
      // reason the roster is.
      orgRenderMode: orgRender.mode,
      orgs: orgRender.orgs,
      orgBodies: isMember ? orgRender.bodies : [],
    });
  });

  // Rename a space or change its access level. Owner-only; assertOperate inside
  // updateWorld() hides a space the caller does not operate as a 404.
  app.patch("/api/v1/worlds/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const world = await grove.campus.updateWorld(human, (req.params as { id: string }).id, {
      name: b.name === undefined ? undefined : String(b.name),
      policyPreset: b.policyPreset === undefined ? undefined : readPreset(b.policyPreset),
      orgRenderMode: b.orgRenderMode,
    });
    return sendOk(reply, { world });
  });

  app.post("/api/v1/worlds/:id/enter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const id = (req.params as { id: string }).id;
    const world = await grove.campus.requireWorld(id);
    // Membership is the gate. isMember() returns true unconditionally for the
    // canonical world (WORLD_ID), so Grove itself stays open to every signed-in
    // human; any other campus requires the human to already be its owner or a
    // member. Entering must never be what grants membership.
    if (!(await grove.campus.isMember(world.id, human.id))) {
      throw new GroveError("ROOM_FORBIDDEN", "You are not a member of this campus.", { httpStatus: 403 });
    }
    // Reached only by someone already entitled to be here; keeps the
    // world_members row in step for the canonical world.
    await grove.campus.addMember(world.id, human.id);
    setWorldCookie(reply, grove, world.id);
    const result = await grove.presence.enter(
      { id: human.id, kind: "human" },
      "plaza",
      {
        connection: "live",
        mode: human.lurk ? "lurk" : "active",
        activity: "idle",
        overflowPlaza: true,
        worldId: world.id,
      },
    );
    return sendOk(reply, { world, room: result.room, presence: result.presence, overflowed: result.overflowed });
  });

  app.post("/api/v1/worlds/:id/members", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const world = await grove.campus.requireWorld((req.params as { id: string }).id);
    await grove.campus.assertOperate(human, world);
    const b = body(req);
    const handle = String(b.handle ?? "").trim().replace(/^@/, "");
    if (!handle) throw new GroveError("INVALID", "handle is required.");
    const invitee = await grove.identity.getHumanByHandle(handle);
    if (!invitee) throw new GroveError("NOT_FOUND", "No human with that handle.", { httpStatus: 404 });
    await grove.campus.addMember(world.id, invitee.id);
    return sendOk(reply, { world, member: { humanId: invitee.id, handle: invitee.handle } }, 201);
  });

  // ------------------------------------------------------------------
  // SPC-05 — asking to join.
  //
  // Membership used to be owner-grants-by-handle only, which needs the owner to
  // already know you. This is the other direction.
  // ------------------------------------------------------------------

  app.post("/api/v1/worlds/:id/join-requests", async (req, reply) => {
    const human = await requireHuman(req, grove);
    // Charged before the write, and on every attempt including a repeat ask:
    // the cost to guard against is the sending, not the row.
    await grove.quota.consumeJoinRequest(human.id, isFirst24h(human.createdAt));
    const b = body(req);
    const request = await grove.campus.requestJoin(
      human,
      (req.params as { id: string }).id,
      b.note === undefined ? null : String(b.note),
    );
    // Deliberately thin: id, status, and the world id the caller already had
    // from the directory. Nothing here describes a private space.
    return sendOk(reply, { request }, 201);
  });

  app.get("/api/v1/worlds/:id/join-requests", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const requests = await grove.campus.listJoinRequests(human, (req.params as { id: string }).id);
    return sendOk(reply, { requests });
  });

  app.post("/api/v1/worlds/:id/join-requests/:requestId", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const p = req.params as { id: string; requestId: string };
    const b = body(req);
    const decision = String(b.decision ?? "");
    if (decision !== "approve" && decision !== "decline") {
      throw new GroveError("INVALID", "decision must be approve or decline.");
    }
    const request = await grove.campus.decideJoinRequest(human, p.id, p.requestId, decision);
    return sendOk(reply, { request });
  });

  // Dismiss answers from your own inbox once you have read them. The owner's
  // half of the inbox self-clears (deciding moves a request out of 'pending'),
  // so only the asker's half needs this. Mirrors mailbox.markRead: the caller's
  // own id scopes the UPDATE inside markJoinAnswersSeen(), so a borrowed
  // request id clears nothing and reveals nothing — the reply is a count.
  app.post("/api/v1/join-requests/seen", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const ids = Array.isArray(b.ids) ? b.ids.map((v) => String(v)) : undefined;
    const cleared = await grove.campus.markJoinAnswersSeen(human.id, ids);
    return sendOk(reply, { cleared });
  });

  // ------------------------------------------------------------------
  // SPC-06 — invite links.
  // ------------------------------------------------------------------

  app.post("/api/v1/worlds/:id/invites", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const invite = await grove.campus.createInvite(human, (req.params as { id: string }).id, {
      expiresInHours: b.expiresInHours == null ? undefined : Number(b.expiresInHours),
      singleUse: b.singleUse === undefined ? undefined : Boolean(b.singleUse),
    });
    return sendOk(reply, { invite }, 201);
  });

  app.get("/api/v1/worlds/:id/invites", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const invites = await grove.campus.listInvites(human, (req.params as { id: string }).id);
    return sendOk(reply, { invites });
  });

  app.delete("/api/v1/worlds/:id/invites/:code", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const p = req.params as { id: string; code: string };
    const invite = await grove.campus.revokeInvite(human, p.id, p.code);
    return sendOk(reply, { invite });
  });

  // Redeeming is not scoped by world on purpose: the code names the space, and
  // asking the caller to supply it too would mean publishing which space a link
  // points at before it is known to be good. Revoked, expired, spent and unknown
  // all come back as the same 404.
  app.post("/api/v1/invites/:code/redeem", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const result = await grove.campus.redeemInvite(human, (req.params as { code: string }).code);
    setWorldCookie(reply, grove, result.world.id);
    return sendOk(reply, { world: result.world, alreadyMember: result.alreadyMember });
  });

  // ------------------------------------------------------------------
  // SPC-03 — orgs, and their binding to spaces.
  // ------------------------------------------------------------------

  app.get("/api/v1/orgs", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const orgs = await grove.campus.listOrgsForHuman(human.id);
    return sendOk(reply, { orgs });
  });

  app.post("/api/v1/orgs", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const org = await grove.campus.createOrg(human, {
      name: String(b.name ?? ""),
      slug: b.slug === undefined ? undefined : String(b.slug),
      colour: b.colour === undefined ? undefined : String(b.colour),
    });
    return sendOk(reply, { org }, 201);
  });

  app.post("/api/v1/orgs/:id/members", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const handle = String(b.handle ?? "").trim().replace(/^@/, "");
    if (!handle) throw new GroveError("INVALID", "handle is required.");
    const invitee = await grove.identity.getHumanByHandle(handle);
    if (!invitee) throw new GroveError("NOT_FOUND", "No human with that handle.", { httpStatus: 404 });
    const org = await grove.campus.addOrgMember(human, (req.params as { id: string }).id, invitee.id);
    return sendOk(reply, { org, member: { humanId: invitee.id, handle: invitee.handle } }, 201);
  });

  // Bind / unbind. Owning both ends is the rule: see bindOrg().
  app.post("/api/v1/worlds/:id/orgs", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const orgId = String(b.orgId ?? b.org ?? "");
    if (!orgId) throw new GroveError("INVALID", "org_id is required.");
    const orgs = await grove.campus.bindOrg(human, (req.params as { id: string }).id, orgId);
    return sendOk(reply, { orgs }, 201);
  });

  app.delete("/api/v1/worlds/:id/orgs/:orgId", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const p = req.params as { id: string; orgId: string };
    const orgs = await grove.campus.unbindOrg(human, p.id, p.orgId);
    return sendOk(reply, { orgs });
  });

  app.get("/api/v1/stage/events", async (req, reply) => {
    const actor = await requireActor(req, grove);
    const worldId = await assertWorldAccess(req, grove, actor);
    const events = await grove.campus.listEvents(worldId);
    return sendOk(reply, { events });
  });

  app.post("/api/v1/stage/events", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const event = await grove.campus.createEvent(human, {
      worldId: b.worldId ? String(b.worldId) : await assertWorldAccess(req, grove, { kind: "human", human }),
      roomId: b.roomId ? String(b.roomId) : undefined,
      title: String(b.title ?? ""),
      startsAt: String(b.startsAt ?? b.starts_at ?? ""),
      endsAt: b.endsAt ? String(b.endsAt) : null,
    });
    return sendOk(reply, { event });
  });

  app.post("/api/v1/roles", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const role = await grove.campus.assignRole(human, {
      worldId: b.worldId ? String(b.worldId) : await assertWorldAccess(req, grove, { kind: "human", human }),
      key: String(b.key ?? ""),
      label: String(b.label ?? b.key ?? ""),
      prompt: String(b.prompt ?? ""),
      cadenceMinutes: b.cadenceMinutes != null ? Number(b.cadenceMinutes) : undefined,
      holderAgentId: String(b.holderAgentId ?? ""),
    });
    return sendOk(reply, { role });
  });

  app.post("/api/v1/webhooks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const webhook = await grove.webhooks.create(human.id, String(b.url ?? ""));
    return sendOk(reply, { webhook });
  });

  app.get("/api/v1/webhooks", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const webhooks = await grove.webhooks.list(human.id);
    return sendOk(reply, { webhooks });
  });

  app.patch("/api/v1/webhooks/:id", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const webhook = await grove.webhooks.patch(human.id, (req.params as { id: string }).id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      url: b.url ? String(b.url) : undefined,
    });
    return sendOk(reply, { webhook });
  });

  app.patch("/api/v1/agents/:id/hosted-brain", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const brain = await grove.brains.upsert((req.params as { id: string }).id, human.id, {
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
      tokenBudgetMonth: b.tokenBudgetMonth != null ? Number(b.tokenBudgetMonth) : undefined,
      model: b.model ? String(b.model) : undefined,
    });
    return sendOk(reply, { hostedBrain: brain });
  });

  app.get("/api/v1/agents/:id/hosted-brain", async (req, reply) => {
    const human = await requireHuman(req, grove);
    await grove.identity.requireOwned((req.params as { id: string }).id, human);
    const brain = await grove.brains.get((req.params as { id: string }).id);
    return sendOk(reply, { hostedBrain: brain });
  });


  // ------------------------------------------------------------------
  // The adapter registry — how Grove REACHES an agent.
  //
  // Owner-facing only, which is the whole exposure story:
  //   * the OWNER'S UI reads and writes one adapter at a time, here;
  //   * a future DISPATCHER reads every armed adapter in-process, through
  //     grove.identity.listDispatchableAdapters(), which has no route.
  // There is deliberately no "list every adapter" endpoint and no agent-facing
  // one. A directory of agent callback URLs is a map of other people's
  // infrastructure, and an agent that could rewrite its own destination could
  // aim Grove's outbound network position wherever it liked.
  //
  // Nothing here dispatches. See docs/ADAPTERS.md.
  // ------------------------------------------------------------------

  app.get("/api/v1/agents/:id/adapter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const adapter = await grove.identity.getAdapter((req.params as { id: string }).id, human);
    return sendOk(reply, { adapter });
  });

  // PUT, not PATCH: the legal shape of `config` depends on `kind`, so a partial
  // write could leave a stale destination from the previous kind sitting in the
  // row. Every write states the whole declaration and is revalidated from
  // scratch. Passing the raw body through is deliberate — validation belongs in
  // one place (IdentityService.validateAdapterConfig), and a route that
  // pre-cleaned the config would be a second, weaker copy of those rules.
  app.put("/api/v1/agents/:id/adapter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const b = body(req);
    const adapter = await grove.identity.setAdapter((req.params as { id: string }).id, human, {
      kind: b.kind,
      config: b.config,
      enabled: b.enabled,
      verifiedKeyId: b.verifiedKeyId,
    });
    return sendOk(reply, { adapter });
  });

  app.delete("/api/v1/agents/:id/adapter", async (req, reply) => {
    const human = await requireHuman(req, grove);
    const cleared = await grove.identity.deleteAdapter((req.params as { id: string }).id, human);
    return sendOk(reply, { cleared });
  });

  void requireOperator;
  void WORLD_ID;
}
