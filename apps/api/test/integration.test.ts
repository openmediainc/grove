import { afterAll, afterEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { WORLD_ID } from "@grove/protocol";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import {
  assertTestDatabase,
  createFixtures,
  databaseName,
  hasTestDatabase,
  isTestDatabase,
  TEST_DB_SUFFIX,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

// These tests write real rows. They must never touch a live campus, so the
// suite refuses to run unless DATABASE_URL names a database ending in "_test".
// A bare "is DATABASE_URL set?" check is NOT enough: importing @grove/domain
// loads .env as a side effect, which populates DATABASE_URL from the deployed
// configuration before this line is ever evaluated.
//
// The guard, the protected ids and the whole fixture sweep are shared with the
// domain suites: packages/domain/test/support/fixtures.ts. Compose with it.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const hasDb = hasTestDatabase();
warnIfNotTestDatabase("integration suite");

// Wire shapes for the space-access and org routes. The API answers snake_case.
type JoinRequestWire = {
  id: string;
  human_id: string;
  handle: string;
  display_name: string;
  note: string | null;
  status: string;
};
type InviteWire = {
  code: string;
  world_id: string;
  expires_at: string;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
  active: boolean;
};
type OrgWire = { id: string; slug: string; name: string; colour: string };

// The human inbox. The two space halves are what tells an owner an ask landed
// and an asker what came of theirs; before them the queue was a dead letterbox.
type InboxRequestWire = {
  request_id: string;
  world_id: string;
  world_slug: string;
  world_name: string;
  handle: string;
  display_name: string;
  note: string | null;
};
type InboxAnswerWire = {
  request_id: string;
  world_id: string;
  plot_index: number | null;
  policy_preset: string;
  status: string;
  slug: string | null;
  name: string | null;
  owner_handle: string | null;
};
type InboxWire = {
  items: unknown[];
  space_requests: InboxRequestWire[];
  space_request_count: number;
  space_answers: InboxAnswerWire[];
  space_answer_count: number;
};

describe.skipIf(!hasDb)("api integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let grove: GroveApp | undefined;

  async function boot() {
    if (app) return app;
    const config = loadConfig();
    // Second gate, on the URL actually used: loadConfig() can supply its own
    // default, so the module-level check on process.env is not the last word.
    assertTestDatabase(config.databaseUrl, "run integration tests");
    await migrate(config.databaseUrl);
    const pg = createPool(config.databaseUrl);
    const redis = new Redis(config.redisUrl);
    const leftover = await redis.keys("ratelimit:ip:*:register:*");
    if (leftover.length) await redis.del(...leftover);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    return app;
  }

  // Every row a test creates is registered here and removed in afterEach, so a
  // failing test leaks nothing either. The tracking sets, the foreign-key
  // ordered sweep, the protected-id guards and the loud-on-failure aggregation
  // all live in packages/domain/test/support/fixtures.ts — extend THAT, not a
  // private copy here. Backends are resolved lazily because grove is built
  // inside boot(), which runs in the first test rather than at module load.
  const fixtures = createFixtures(() => grove?.store);
  const { trackHuman, trackWorld, trackAgent, trackOrg } = fixtures;
  const cleanupFixtures = () => fixtures.cleanup();

  afterEach(async () => {
    await cleanupFixtures();
  });

  async function signIn(
    server: Awaited<ReturnType<typeof buildApp>>,
    tag: string,
  ): Promise<{ cookie: string; handle: string; id: string }> {
    // sanitizeHandle() clips a new human's handle to the first 20 characters of
    // the email local part, and createHuman's de-dupe loop re-clips, so a long
    // local part collides forever and the signup 500s. Keep this short.
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${local}@example.com`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    expect(magic.statusCode).toBe(200);
    const token = new URL(
      (magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=",
    ).searchParams.get("token");
    const consumed = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    const raw = consumed.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : raw;
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    trackHuman(human.id, cookie);
    return { cookie: cookie ?? "", handle: human.handle, id: human.id };
  }

  afterAll(async () => {
    await cleanupFixtures();
    if (app) await app.close();
    await grove?.store.pg.end();
    grove?.store.redis.disconnect();
  });

  it("health and ready", async () => {
    const server = await boot();
    const h = await server.inject({ method: "GET", url: "/health" });
    expect(h.statusCode).toBe(200);
    const r = await server.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(200);
    // The test database was migrated from this tree, so disk and ledger agree.
    // The alert runner treats anything else as schema drift (docs/ALERTS.md).
    const schema = (r.json() as { schema: Record<string, unknown> }).schema;
    expect(schema.ok).toBe(true);
    expect(schema.pending).toEqual([]);
    expect(schema.unknown).toEqual([]);
    expect(schema.on_disk).toBe(schema.applied);

    // A ledger row with no file behind it is drift too, and must be named.
    const ghost = "999_alerts_ghost_migration.sql";
    await grove!.store.pg.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING", [ghost]);
    try {
      const drift = (await server.inject({ method: "GET", url: "/ready" })).json() as {
        schema: { ok: boolean; unknown: string[] };
      };
      expect(drift.schema.ok).toBe(false);
      expect(drift.schema.unknown).toContain(ghost);
    } finally {
      await grove!.store.pg.query("DELETE FROM schema_migrations WHERE id = $1", [ghost]);
    }
  });

  it("listen-only room_say 403 vs owner_reply 200; unclaimed observe has no room", async () => {
    const server = await boot();
    const g = grove!;
    const email = `itest-${Date.now()}@example.com`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    expect(magic.statusCode).toBe(200);
    const magicBody = magic.json() as { dev_login_url?: string };
    const token = new URL(magicBody.dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    const cookie = consumed.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    trackHuman((consumed.json() as { human: { id: string } }).human.id, cookieHeader);

    const uniqueIp = `203.0.113.${Date.now() % 250}`;
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": uniqueIp },
      payload: { name: "scribe", description: "listen-only" },
    });
    expect(reg.statusCode).toBe(200);
    const regBody = reg.json() as { agent_id: string; api_key: string; slug: string };
    expect(regBody.slug).toBe(regBody.agent_id);
    expect(regBody.api_key.startsWith("aeth_live_")).toBe(true);

    const obsPending = await server.inject({
      method: "GET",
      url: "/api/v1/observe",
      headers: { authorization: `Bearer ${regBody.api_key}` },
    });
    expect(obsPending.statusCode).toBe(200);
    const pending = obsPending.json() as { observation: Record<string, unknown> };
    expect(pending.observation.kind).toBe("pending");
    expect(pending.observation.room).toBeUndefined();

    const claim = await server.inject({
      method: "POST",
      url: `/api/v1/agents/${regBody.agent_id}/claim`,
      headers: { cookie: cookieHeader ?? "" },
    });
    expect(claim.statusCode).toBe(200);

    await server.inject({
      method: "PATCH",
      url: `/api/v1/agents/${regBody.agent_id}/policy`,
      headers: { cookie: cookieHeader ?? "" },
      payload: {
        speak_to_agents: false,
        speak_to_humans: false,
        listen_to_agents: true,
        listen_to_humans: true,
      },
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/world/enter",
      headers: { cookie: cookieHeader ?? "" },
    });
    await server.inject({
      method: "POST",
      url: "/api/v1/world/join",
      headers: { authorization: `Bearer ${regBody.api_key}` },
    });

    const denied = await server.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: {
        authorization: `Bearer ${regBody.api_key}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { channel: "room_say", body: "digest" },
    });
    expect(denied.statusCode).toBe(403);
    const deniedBody = denied.json() as { error: { code: string; capability: string } };
    expect(deniedBody.error.code).toBe("PERMISSION_DENIED");
    expect(deniedBody.error.capability).toBe("speak_to_humans");

    const allowed = await server.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: {
        authorization: `Bearer ${regBody.api_key}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { channel: "owner_reply", body: "digest" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("creates a private campus and copies public rooms", async () => {
    const server = await boot();
    const email = `world-${Date.now()}@example.com`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get(
      "token",
    );
    const consumed = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    const cookie = consumed.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    trackHuman((consumed.json() as { human: { id: string } }).human.id, cookieHeader);
    const slug = `grove-itest-${Date.now()}`;
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: cookieHeader ?? "" },
      payload: { name: "Itest Campus", slug },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string } }).world;
    trackWorld(world.id);
    expect(world.slug).toBe(slug);
    const entered = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: cookieHeader ?? "" },
    });
    expect(entered.statusCode).toBe(200);
    const plaza = await server.inject({
      method: "GET",
      url: "/api/v1/rooms/plaza",
      headers: { cookie: cookieHeader ?? "", "x-grove-world": world.id },
    });
    expect(plaza.statusCode).toBe(200);
    const room = (plaza.json() as { room: { id: string; slug: string; world_id: string } }).room;
    expect(room.slug).toBe("plaza");
    expect(room.world_id).toBe(world.id);
    expect(room.id).not.toBe("plaza");
  });

  it("the canonical world stays open to every signed-in human", async () => {
    const server = await boot();
    const visitor = await signIn(server, "mcan");
    const entered = await server.inject({
      method: "POST",
      url: "/api/v1/worlds/aetheria-prime/enter",
      headers: { cookie: visitor.cookie },
    });
    expect(entered.statusCode).toBe(200);
    expect((entered.json() as { world: { id: string } }).world.id).toBe("aetheria-prime");
  });

  it("a private campus refuses non-members and entering does not grant membership", async () => {
    const server = await boot();
    const owner = await signIn(server, "mown");
    const outsider = await signIn(server, "mout");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Closed Campus", slug: `grove-closed-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    const denied = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: outsider.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe("ROOM_FORBIDDEN");

    // The refused attempt must not have written a world_members row.
    expect(await grove!.campus.isMember(world.id, outsider.id)).toBe(false);
    const stillDenied = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: outsider.cookie },
    });
    expect(stillDenied.statusCode).toBe(403);

    // The campus never shows up in the outsider's own world list.
    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/worlds",
      headers: { cookie: outsider.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const ids = (listed.json() as { worlds: Array<{ id: string }> }).worlds.map((w) => w.id);
    expect(ids).not.toContain(world.id);

    // The owner is a member by construction and may still enter.
    const ownerEntered = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerEntered.statusCode).toBe(200);
  });

  it("only the owner may admit members, and an admitted human may enter", async () => {
    const server = await boot();
    const owner = await signIn(server, "aown");
    const guest = await signIn(server, "agst");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Invite Campus", slug: `grove-invite-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    // A non-owner cannot admit anyone (assertOperate hides the campus as 404).
    const selfAdmit = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: guest.cookie },
      payload: { handle: guest.handle },
    });
    expect(selfAdmit.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);

    // An unknown handle is a 404, not a silent no-op.
    const unknown = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: { handle: `nobody-${Date.now()}` },
    });
    expect(unknown.statusCode).toBe(404);

    // A missing handle is rejected before any lookup.
    const blank = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(blank.statusCode).toBe(400);
    expect((blank.json() as { error: { code: string } }).error.code).toBe("INVALID");

    // The owner admits the guest by handle; the wire stays snake_case.
    const admitted = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: { handle: guest.handle },
    });
    expect(admitted.statusCode).toBe(201);
    const member = (admitted.json() as { member: { human_id: string; handle: string } }).member;
    expect(member.human_id).toBe(guest.id);
    expect(member.handle).toBe(guest.handle);

    // Admitting twice is idempotent.
    const again = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: { handle: guest.handle },
    });
    expect(again.statusCode).toBe(201);

    const entered = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: guest.cookie },
    });
    expect(entered.statusCode).toBe(200);
    expect((entered.json() as { world: { id: string } }).world.id).toBe(world.id);

    const listed = await server.inject({
      method: "GET",
      url: "/api/v1/worlds",
      headers: { cookie: guest.cookie },
    });
    const ids = (listed.json() as { worlds: Array<{ id: string }> }).worlds.map((w) => w.id);
    expect(ids).toContain(world.id);
  });

  it("PATCH /worlds/:id: owner-only, validates the preset, and renames", async () => {
    const server = await boot();
    const owner = await signIn(server, "pown");
    const outsider = await signIn(server, "pout");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Patch Campus", slug: `grove-patch-${Date.now()}`, policy_preset: "public_view" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; policy_preset: string } }).world;
    trackWorld(world.id);
    // POST carried the preset through rather than silently defaulting.
    expect(world.policy_preset).toBe("public_view");

    // Signed out is a 401, not a 404: nothing is revealed about the space.
    const anon = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      payload: { policy_preset: "private" },
    });
    expect(anon.statusCode).toBe(401);

    // A non-owner gets assertOperate's 404, and the row is untouched.
    const stranger = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: outsider.cookie },
      payload: { policy_preset: "public_write" },
    });
    expect(stranger.statusCode).toBe(404);
    expect((await grove!.campus.requireWorld(world.id)).policyPreset).toBe("public_view");

    // A value outside the three presets is refused BEFORE it reaches the DB
    // CHECK constraint, so it is a 400 INVALID and never an opaque 500.
    const bogus = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { policy_preset: "public_everything" },
    });
    expect(bogus.statusCode).toBe(400);
    expect((bogus.json() as { error: { code: string } }).error.code).toBe("INVALID");
    expect((await grove!.campus.requireWorld(world.id)).policyPreset).toBe("public_view");

    // An empty patch is rejected rather than treated as a no-op success.
    const empty = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: { code: string } }).error.code).toBe("INVALID");

    // The owner narrows the space. The wire stays snake_case.
    const narrowed = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { policy_preset: "private" },
    });
    expect(narrowed.statusCode).toBe(200);
    expect((narrowed.json() as { world: { policy_preset: string } }).world.policy_preset).toBe("private");
    expect((await grove!.campus.requireWorld(world.id)).policyPreset).toBe("private");

    // Renaming works on the same route and leaves the preset alone.
    const renamed = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { name: "Patched Campus" },
    });
    expect(renamed.statusCode).toBe(200);
    const after = (renamed.json() as { world: { name: string; policy_preset: string; plot_index: number } }).world;
    expect(after.name).toBe("Patched Campus");
    expect(after.policy_preset).toBe("private");
    // The plot is held for life: nothing on this route may move it.
    expect(after.plot_index).toBe((created.json() as { world: { plot_index: number } }).world.plot_index);

    // A blank name is refused, so a space can never lose its label.
    const blank = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { name: "   " },
    });
    expect(blank.statusCode).toBe(400);

    // The civic core has no access level to change, even for its operator.
    const core = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${WORLD_ID}`,
      headers: { cookie: owner.cookie },
      payload: { policy_preset: "private" },
    });
    expect([400, 404]).toContain(core.statusCode);
    expect((await grove!.campus.requireWorld(WORLD_ID)).policyPreset).toBe("public_write");
  });

  it("the space directory is public but redacts a private space from non-members", async () => {
    const server = await boot();
    const owner = await signIn(server, "down");
    const outsider = await signIn(server, "dout");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Hidden Study", slug: `grove-hidden-${Date.now()}`, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    type Entry = {
      id: string;
      name: string | null;
      slug: string | null;
      owner_handle: string | null;
      policy_preset: string;
      plot_index: number;
      is_member: boolean;
    };
    const find = (res: { json: () => unknown }) =>
      (res.json() as { spaces: Entry[] }).spaces.find((e) => e.id === world.id);

    // Signed out: the plot is public knowledge, its contents are not.
    const anon = await server.inject({ method: "GET", url: "/api/v1/worlds/directory" });
    expect(anon.statusCode).toBe(200);
    const hidden = find(anon);
    expect(hidden).toBeDefined();
    expect(hidden!.policy_preset).toBe("private");
    expect(typeof hidden!.plot_index).toBe("number");
    expect(hidden!.name).toBeNull();
    expect(hidden!.slug).toBeNull();
    expect(hidden!.owner_handle).toBeNull();

    // A signed-in non-member sees exactly the same redaction.
    const stranger = await server.inject({
      method: "GET",
      url: "/api/v1/worlds/directory",
      headers: { cookie: outsider.cookie },
    });
    expect(find(stranger)!.name).toBeNull();
    expect(find(stranger)!.is_member).toBe(false);

    // The owner sees their own space in full.
    const mine = await server.inject({
      method: "GET",
      url: "/api/v1/worlds/directory",
      headers: { cookie: owner.cookie },
    });
    expect(find(mine)!.name).toBe("Hidden Study");
    expect(find(mine)!.owner_handle).toBe(owner.handle);
    expect(find(mine)!.is_member).toBe(true);

    // Detail is hidden entirely from a non-member of a private space.
    const detailDenied = await server.inject({
      method: "GET",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: outsider.cookie },
    });
    expect(detailDenied.statusCode).toBe(404);

    const detail = await server.inject({
      method: "GET",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as {
      rooms: Array<{ slug: string }>;
      members: Array<{ handle: string; is_owner: boolean }>;
      is_owner: boolean;
    };
    expect(d.is_owner).toBe(true);
    expect(d.rooms.length).toBeGreaterThan(0);
    expect(d.members.some((m) => m.handle === owner.handle && m.is_owner)).toBe(true);
  });

  it("AWN join inhabits home room and action maps to say/heartbeat", async () => {
    const server = await boot();
    const ping = await server.inject({ method: "GET", url: "/peer/ping" });
    expect(ping.statusCode).toBe(200);
    expect((ping.json() as { world: string }).world).toBe("aetheria-prime");
    const announced = await server.inject({ method: "POST", url: "/peer/announce" });
    expect(announced.statusCode).toBe(204);

    const email = `awn-${Date.now()}@example.com`;
    const magic = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get(
      "token",
    );
    const consumed = await server.inject({
      method: "POST",
      url: "/api/v1/humans/session/consume",
      payload: { token },
    });
    const cookie = consumed.headers["set-cookie"];
    const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
    trackHuman((consumed.json() as { human: { id: string } }).human.id, cookieHeader);
    const uniqueIp = `203.0.113.${(Date.now() % 200) + 1}`;
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": uniqueIp },
      payload: { name: "awnbot", description: "bridge" },
    });
    const regBody = reg.json() as { agent_id: string; api_key: string };
    await server.inject({
      method: "POST",
      url: `/api/v1/agents/${regBody.agent_id}/claim`,
      headers: { cookie: cookieHeader ?? "" },
    });
    const joined = await server.inject({
      method: "POST",
      url: "/awn/join",
      headers: { authorization: `Bearer ${regBody.api_key}` },
      payload: { alias: "Awn Bot" },
    });
    expect(joined.statusCode).toBe(200);
    const presence = (joined.json() as { presence: { room_id: string } }).presence;
    expect(presence.room_id).toBe("plaza");
    const beat = await server.inject({
      method: "POST",
      url: "/awn/action",
      headers: { authorization: `Bearer ${regBody.api_key}` },
      payload: { action: "heartbeat" },
    });
    expect(beat.statusCode).toBe(200);
    const said = await server.inject({
      method: "POST",
      url: "/awn/action",
      headers: { authorization: `Bearer ${regBody.api_key}` },
      payload: { action: "say", body: "hello from the bridge", channel: "room_say" },
    });
    expect(said.statusCode).toBe(200);
  });

  // --- world scope: the x-grove-world header is a request, not a grant -------

  let ipCounter = 0;

  async function registerAgent(
    server: Awaited<ReturnType<typeof buildApp>>,
    name: string,
  ): Promise<{ id: string; apiKey: string }> {
    // A fresh IP per registration: the limiter allows only 3 per IP per hour.
    const ip = `198.51.100.${(ipCounter++ % 250) + 1}`;
    const reg = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": ip },
      payload: { name },
    });
    expect(reg.statusCode).toBe(200);
    const b = reg.json() as { agent_id: string; api_key: string };
    trackAgent(b.agent_id);
    return { id: b.agent_id, apiKey: b.api_key };
  }

  async function createCampus(
    server: Awaited<ReturnType<typeof buildApp>>,
    ownerCookie: string,
    tag: string,
  ): Promise<{ id: string }> {
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: ownerCookie },
      payload: { name: `${tag} campus`, slug: `grove-${tag}-${Date.now()}${Math.floor(Math.random() * 1000)}` },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);
    return world;
  }

  // Every route that scopes off the client-supplied world id.
  const SCOPED_READS = ["/api/v1/rooms/plaza", "/api/v1/rooms/plaza/transcript", "/api/v1/world", "/api/v1/world/minimap"];

  it("an outsider cannot read a private campus by setting x-grove-world", async () => {
    const server = await boot();
    const owner = await signIn(server, "sown");
    const outsider = await signIn(server, "sout");
    const world = await createCampus(server, owner.cookie, "scope");

    for (const url of SCOPED_READS) {
      const res = await server.inject({
        method: "GET",
        url,
        headers: { cookie: outsider.cookie, "x-grove-world": world.id },
      });
      expect(`${url} -> ${res.statusCode}`).toBe(`${url} -> 403`);
      expect((res.json() as { error: { code: string } }).error.code).toBe("ROOM_FORBIDDEN");
    }

    // The same refusal with no session at all: the header alone proves nothing.
    const anonymous = await server.inject({
      method: "GET",
      url: "/api/v1/world/minimap",
      headers: { "x-grove-world": world.id },
    });
    expect(anonymous.statusCode).toBe(403);

    // And via the cookie, which is the other half of resolveWorldId().
    const viaCookie = await server.inject({
      method: "GET",
      url: "/api/v1/world/minimap",
      headers: { cookie: `${outsider.cookie}; grove_world=${world.id}` },
    });
    expect(viaCookie.statusCode).toBe(403);

    // Refusing must not have admitted them as a side effect.
    expect(await grove!.campus.isMember(world.id, outsider.id)).toBe(false);
  });

  it("a member of that campus reads the same routes", async () => {
    const server = await boot();
    const owner = await signIn(server, "mbow");
    const guest = await signIn(server, "mbgu");
    const world = await createCampus(server, owner.cookie, "member");

    const admitted = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: { handle: guest.handle },
    });
    expect(admitted.statusCode).toBe(201);

    for (const cookie of [owner.cookie, guest.cookie]) {
      for (const url of SCOPED_READS) {
        const res = await server.inject({
          method: "GET",
          url,
          headers: { cookie, "x-grove-world": world.id },
        });
        expect(`${url} -> ${res.statusCode}`).toBe(`${url} -> 200`);
      }
    }

    // The rooms they see are the campus's own, not the commons'.
    const plaza = await server.inject({
      method: "GET",
      url: "/api/v1/rooms/plaza",
      headers: { cookie: guest.cookie, "x-grove-world": world.id },
    });
    const room = (plaza.json() as { room: { id: string; world_id: string } }).room;
    expect(room.world_id).toBe(world.id);
    expect(room.id).toBe(`${world.id}:plaza`);
  });

  it("the canonical world stays readable with no authentication (landing page)", async () => {
    const server = await boot();
    // The logged-out landing page calls these with no cookie and no header.
    const minimap = await server.inject({ method: "GET", url: "/api/v1/world/minimap" });
    expect(minimap.statusCode).toBe(200);
    const publicWorld = await server.inject({ method: "GET", url: "/api/v1/world/public" });
    expect(publicWorld.statusCode).toBe(200);
    expect((publicWorld.json() as { world: { id: string } }).world.id).toBe(WORLD_ID);

    // Naming the commons explicitly is still fine, signed in or not.
    const named = await server.inject({
      method: "GET",
      url: "/api/v1/world/minimap",
      headers: { "x-grove-world": WORLD_ID },
    });
    expect(named.statusCode).toBe(200);
  });

  it("an agent reaches a campus only through its owner's membership", async () => {
    const server = await boot();
    const owner = await signIn(server, "agow");
    const stranger = await signIn(server, "agst");
    const world = await createCampus(server, owner.cookie, "agent");

    const mine = await registerAgent(server, "insider");
    const theirs = await registerAgent(server, "outsider");
    const orphan = await registerAgent(server, "orphan");

    for (const [agent, cookie] of [
      [mine, owner.cookie],
      [theirs, stranger.cookie],
    ] as const) {
      const claimed = await server.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.id}/claim`,
        headers: { cookie },
      });
      expect(claimed.statusCode).toBe(200);
    }

    const allowed = await server.inject({
      method: "GET",
      url: "/api/v1/rooms/plaza",
      headers: { authorization: `Bearer ${mine.apiKey}`, "x-grove-world": world.id },
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { room: { world_id: string } }).room.world_id).toBe(world.id);

    // Owned by someone who is not a member.
    const refused = await server.inject({
      method: "GET",
      url: "/api/v1/rooms/plaza",
      headers: { authorization: `Bearer ${theirs.apiKey}`, "x-grove-world": world.id },
    });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { error: { code: string } }).error.code).toBe("ROOM_FORBIDDEN");

    // Unclaimed: no owner at all, so no membership to inherit.
    const unclaimed = await server.inject({
      method: "GET",
      url: "/api/v1/rooms/plaza",
      headers: { authorization: `Bearer ${orphan.apiKey}`, "x-grove-world": world.id },
    });
    expect(unclaimed.statusCode).toBe(403);
    expect((unclaimed.json() as { error: { code: string } }).error.code).toBe("ROOM_FORBIDDEN");

    // An unclaimed agent is still welcome in the commons.
    const commons = await server.inject({
      method: "GET",
      url: "/api/v1/world/minimap",
      headers: { authorization: `Bearer ${orphan.apiKey}` },
    });
    expect(commons.statusCode).toBe(200);
  });

  it("a raw campus room id does not slip past the world check", async () => {
    const server = await boot();
    const owner = await signIn(server, "rawo");
    const outsider = await signIn(server, "rawx");
    const world = await createCampus(server, owner.cookie, "rawid");

    // No world header, so the request is scoped to the commons. presence.getRoom()
    // is world-scoped, so the campus room does not resolve at all.
    //
    // 404 rather than 403 is deliberate: refusing with "forbidden" would confirm
    // the room exists and belongs to another campus. An outsider learns nothing.
    for (const url of [`/api/v1/rooms/${world.id}:plaza`, `/api/v1/rooms/${world.id}:plaza/transcript`]) {
      const res = await server.inject({ method: "GET", url, headers: { cookie: outsider.cookie } });
      expect(`${url} -> ${res.statusCode}`).toBe(`${url} -> 404`);
    }

    // A member addressing the same room, with the campus named, is fine.
    const ok = await server.inject({
      method: "GET",
      url: `/api/v1/rooms/${world.id}:plaza`,
      headers: { cookie: owner.cookie, "x-grove-world": world.id },
    });
    expect(ok.statusCode).toBe(200);
  });
  // ------------------------------------------------------------------
  // SPC-05 — asking to join.
  // ------------------------------------------------------------------

  it("a non-member asks to join, the owner approves, and only then may they enter", async () => {
    const server = await boot();
    const owner = await signIn(server, "jown");
    const guest = await signIn(server, "jgst");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Asked Campus", slug: `grove-ask-${Date.now()}`, policy_preset: "public_view" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    // Entering is refused before the ask: membership is the gate, not interest.
    const early = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: guest.cookie },
    });
    expect(early.statusCode).toBe(403);

    const asked = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: { note: "I build the thing next door." },
    });
    expect(asked.statusCode).toBe(201);
    const request = (asked.json() as { request: { id: string; status: string } }).request;
    expect(request.status).toBe("pending");

    // Asking again while pending is idempotent, not an error or a second row.
    const again = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(201);
    expect((again.json() as { request: { id: string } }).request.id).toBe(request.id);

    // The queue is the owner's alone.
    const peeked = await server.inject({
      method: "GET",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
    });
    expect(peeked.statusCode).toBe(404);

    const queue = await server.inject({
      method: "GET",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: owner.cookie },
    });
    expect(queue.statusCode).toBe(200);
    const pending = (queue.json() as { requests: JoinRequestWire[] }).requests;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.handle).toBe(guest.handle);
    expect(pending[0]!.note).toBe("I build the thing next door.");

    // A non-owner cannot decide, even holding a real request id.
    const forged = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${request.id}`,
      headers: { cookie: guest.cookie },
      payload: { decision: "approve" },
    });
    expect(forged.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);

    const approved = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${request.id}`,
      headers: { cookie: owner.cookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as { request: { status: string } }).request.status).toBe("approved");
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(true);

    const entered = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/enter`,
      headers: { cookie: guest.cookie },
    });
    expect(entered.statusCode).toBe(200);

    // Deciding twice does nothing: the UPDATE only matches a pending row.
    const replay = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${request.id}`,
      headers: { cookie: owner.cookie },
      payload: { decision: "decline" },
    });
    expect(replay.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(true);
  });

  it("a declined request grants nothing, and the ask is rate limited", async () => {
    const server = await boot();
    const owner = await signIn(server, "down2");
    const guest = await signIn(server, "dgst");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Declined Campus", slug: `grove-dec-${Date.now()}` },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    const asked = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(asked.statusCode).toBe(201);
    const requestId = (asked.json() as { request: { id: string } }).request.id;

    const declined = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${requestId}`,
      headers: { cookie: owner.cookie },
      payload: { decision: "decline" },
    });
    expect(declined.statusCode).toBe(200);
    expect((declined.json() as { request: { status: string } }).request.status).toBe("declined");
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);

    // A decline does not leave a pending row behind, so the guest may ask again
    // — which is the second of three the hourly limiter allows.
    const second = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(second.statusCode).toBe(201);

    const third = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(third.statusCode).toBe(201);

    // Fourth ask in the hour: refused. The limiter is charged per attempt, so a
    // repeat ask costs the same as a new one.
    const fourth = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(fourth.statusCode).toBe(429);
    expect((fourth.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    // Clear the window so a re-run of this suite within the hour is not poisoned
    // by its own leftovers.
    await grove!.store.redis.del(
      `ratelimit:${guest.id}:join_request:hour`,
      `ratelimit:${guest.id}:join_request:day`,
    );
  });

  it("asking about a private space leaks nothing beyond the directory", async () => {
    const server = await boot();
    const owner = await signIn(server, "pjow");
    const guest = await signIn(server, "pjgs");
    const slug = `grove-secret-${Date.now()}`;
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Founders Only", slug, policy_preset: "private" },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    // The slug is NOT on the directory for a non-member, so it must not be a
    // key here either — otherwise asking becomes a way to confirm a guess.
    const bySlug = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${slug}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(bySlug.statusCode).toBe(404);

    // By id — which the directory does publish — the ask works, and the reply
    // carries no name, slug or owner.
    const byId = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(byId.statusCode).toBe(201);
    const payload = byId.json() as { request: Record<string, unknown> };
    expect(Object.keys(payload.request).sort()).toEqual(["created_at", "id", "status", "world_id"]);
  });

  // ------------------------------------------------------------------
  // The join-request loop is only useful if somebody is told. These cover the
  // owner's half, the asker's half, the idempotence of a re-ask, and the
  // silence everybody else is owed.
  // ------------------------------------------------------------------

  it("an ask reaches the owner's inbox once, survives a re-ask, and the approval reaches the asker", async () => {
    const server = await boot();
    const owner = await signIn(server, "iown");
    const guest = await signIn(server, "igst");
    const stranger = await signIn(server, "istr");

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Inbox Campus", slug: `grove-inb-${Date.now()}`, policy_preset: "public_view" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string } }).world;
    trackWorld(world.id);

    const inboxOf = async (cookie: string) => {
      const res = await server.inject({ method: "GET", url: "/api/v1/inbox", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return res.json() as InboxWire;
    };

    // Nothing has happened yet: the owner's queue is empty, not absent.
    const before = await inboxOf(owner.cookie);
    expect(before.space_request_count).toBe(0);
    expect(before.space_requests).toHaveLength(0);

    const asked = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: { note: "I keep the bees next door." },
    });
    expect(asked.statusCode).toBe(201);
    const requestId = (asked.json() as { request: { id: string } }).request.id;

    // The owner is told, from the one place they already visit.
    const notified = await inboxOf(owner.cookie);
    expect(notified.space_request_count).toBe(1);
    expect(notified.space_requests).toHaveLength(1);
    expect(notified.space_requests[0]!.request_id).toBe(requestId);
    expect(notified.space_requests[0]!.handle).toBe(guest.handle);
    expect(notified.space_requests[0]!.world_id).toBe(world.id);
    expect(notified.space_requests[0]!.note).toBe("I keep the bees next door.");

    // Re-asking is idempotent at the row, so it must be idempotent at the
    // notification too: one knock, one entry, however many times it is tapped.
    const again = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(201);
    expect((again.json() as { request: { id: string } }).request.id).toBe(requestId);
    const afterRepeat = await inboxOf(owner.cookie);
    expect(afterRepeat.space_request_count).toBe(1);
    expect(afterRepeat.space_requests).toHaveLength(1);

    // A third party is told nothing at all — not that a space exists, not that
    // anybody knocked on it.
    const outsider = await inboxOf(stranger.cookie);
    expect(outsider.space_request_count).toBe(0);
    expect(outsider.space_requests).toHaveLength(0);
    expect(outsider.space_answers).toHaveLength(0);
    const outsiderText = JSON.stringify(outsider);
    expect(outsiderText).not.toContain(world.id);
    expect(outsiderText).not.toContain(guest.handle);

    // The asker is not told about their own pending ask as an answer, and does
    // not inherit the owner's queue.
    const waiting = await inboxOf(guest.cookie);
    expect(waiting.space_request_count).toBe(0);
    expect(waiting.space_answers).toHaveLength(0);

    const approved = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${requestId}`,
      headers: { cookie: owner.cookie },
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);

    // Deciding clears the owner's half with no second write to keep in step.
    const settled = await inboxOf(owner.cookie);
    expect(settled.space_request_count).toBe(0);
    expect(settled.space_requests).toHaveLength(0);

    // ...and the asker learns of it. They are a member now, so the space is no
    // longer redacted from them.
    const answered = await inboxOf(guest.cookie);
    expect(answered.space_answer_count).toBe(1);
    expect(answered.space_answers[0]!.status).toBe("approved");
    expect(answered.space_answers[0]!.request_id).toBe(requestId);
    expect(answered.space_answers[0]!.slug).toBe(world.slug);

    // Dismissing is scoped to the caller: the stranger holding the same id
    // clears nothing.
    const forgedDismiss = await server.inject({
      method: "POST",
      url: "/api/v1/join-requests/seen",
      headers: { cookie: stranger.cookie },
      payload: { ids: [requestId] },
    });
    expect(forgedDismiss.statusCode).toBe(200);
    expect((forgedDismiss.json() as { cleared: number }).cleared).toBe(0);
    expect((await inboxOf(guest.cookie)).space_answer_count).toBe(1);

    const dismissed = await server.inject({
      method: "POST",
      url: "/api/v1/join-requests/seen",
      headers: { cookie: guest.cookie },
      payload: { ids: [requestId] },
    });
    expect(dismissed.statusCode).toBe(200);
    expect((dismissed.json() as { cleared: number }).cleared).toBe(1);
    const cleared = await inboxOf(guest.cookie);
    expect(cleared.space_answer_count).toBe(0);
    expect(cleared.space_answers).toHaveLength(0);
  });

  it("a decline reaches the asker and still says nothing about a private space", async () => {
    const server = await boot();
    const owner = await signIn(server, "down");
    const guest = await signIn(server, "dgst");
    const stranger = await signIn(server, "dstr");

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Sealed Room", slug: `grove-seal-${Date.now()}`, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string; name: string } }).world;
    trackWorld(world.id);

    const inboxOf = async (cookie: string) => {
      const res = await server.inject({ method: "GET", url: "/api/v1/inbox", headers: { cookie } });
      expect(res.statusCode).toBe(200);
      return res.json() as InboxWire;
    };

    // A private space is addressable by id only; the directory publishes that id.
    const asked = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests`,
      headers: { cookie: guest.cookie },
      payload: { note: "let me in" },
    });
    expect(asked.statusCode).toBe(201);
    const requestId = (asked.json() as { request: { id: string } }).request.id;
    expect((await inboxOf(owner.cookie)).space_request_count).toBe(1);

    const declined = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/join-requests/${requestId}`,
      headers: { cookie: owner.cookie },
      payload: { decision: "decline" },
    });
    expect(declined.statusCode).toBe(200);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);

    const answered = await inboxOf(guest.cookie);
    expect(answered.space_answer_count).toBe(1);
    const answer = answered.space_answers[0]!;
    expect(answer.status).toBe("declined");
    expect(answer.world_id).toBe(world.id);
    // Exactly what the public directory already shows for a held private plot,
    // and not one field more: a plot number and an access level.
    expect(answer.policy_preset).toBe("private");
    expect(typeof answer.plot_index).toBe("number");
    expect(answer.slug).toBeNull();
    expect(answer.name).toBeNull();
    expect(answer.owner_handle).toBeNull();
    // The owner's reasoning and identity never travel with a decline.
    const answerText = JSON.stringify(answer);
    expect(answerText).not.toContain(world.slug);
    expect(answerText).not.toContain(world.name);
    expect(answerText).not.toContain(owner.handle);
    expect(answerText).not.toContain(owner.id);
    expect(Object.keys(answer)).not.toContain("decided_by");
    expect(Object.keys(answer)).not.toContain("reason");
    expect(Object.keys(answer)).not.toContain("note");

    // The owner's queue empties, and nobody else hears that any of it happened.
    expect((await inboxOf(owner.cookie)).space_request_count).toBe(0);
    const outsider = await inboxOf(stranger.cookie);
    expect(outsider.space_requests).toHaveLength(0);
    expect(outsider.space_answers).toHaveLength(0);
    expect(JSON.stringify(outsider)).not.toContain(world.id);
  });

  // ------------------------------------------------------------------
  // SPC-06 — invite links.
  // ------------------------------------------------------------------

  it("an invite link admits its holder, and a spent single-use one fails closed", async () => {
    const server = await boot();
    const owner = await signIn(server, "iown");
    const first = await signIn(server, "ifst");
    const second = await signIn(server, "isnd");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Invited Campus", slug: `grove-link-${Date.now()}`, policy_preset: "private" },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    // Only the owner may mint.
    const stolen = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/invites`,
      headers: { cookie: first.cookie },
      payload: { single_use: true },
    });
    expect(stolen.statusCode).toBe(404);

    const minted = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/invites`,
      headers: { cookie: owner.cookie },
      payload: { single_use: true, expires_in_hours: 24 },
    });
    expect(minted.statusCode).toBe(201);
    const invite = (minted.json() as { invite: InviteWire }).invite;
    expect(invite.max_uses).toBe(1);
    expect(invite.uses).toBe(0);
    expect(invite.active).toBe(true);

    const redeemed = await server.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.code}/redeem`,
      headers: { cookie: first.cookie },
      payload: {},
    });
    expect(redeemed.statusCode).toBe(200);
    expect((redeemed.json() as { world: { id: string } }).world.id).toBe(world.id);
    expect(await grove!.campus.isMember(world.id, first.id)).toBe(true);

    // The single use is spent. A second holder gets the same closed 404 an
    // unknown code gets — nothing distinguishes "spent" from "never existed".
    const spent = await server.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.code}/redeem`,
      headers: { cookie: second.cookie },
      payload: {},
    });
    expect(spent.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, second.id)).toBe(false);

    const nonsense = await server.inject({
      method: "POST",
      url: `/api/v1/invites/not-a-real-code/redeem`,
      headers: { cookie: second.cookie },
      payload: {},
    });
    expect(nonsense.statusCode).toBe(404);
    expect((nonsense.json() as { error: { message: string } }).error.message).toBe(
      (spent.json() as { error: { message: string } }).error.message,
    );

    // The human already admitted by this link may re-open it without burning
    // anything: the use count must not move.
    const replay = await server.inject({
      method: "POST",
      url: `/api/v1/invites/${invite.code}/redeem`,
      headers: { cookie: first.cookie },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { already_member: boolean }).already_member).toBe(true);
    const listed = await server.inject({
      method: "GET",
      url: `/api/v1/worlds/${world.id}/invites`,
      headers: { cookie: owner.cookie },
    });
    expect((listed.json() as { invites: InviteWire[] }).invites[0]!.uses).toBe(1);
  });

  it("an expired invite and a revoked invite both fail closed", async () => {
    const server = await boot();
    const owner = await signIn(server, "eown");
    const guest = await signIn(server, "egst");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Expiry Campus", slug: `grove-exp-${Date.now()}`, policy_preset: "private" },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    const mintedA = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/invites`,
      headers: { cookie: owner.cookie },
      payload: { expires_in_hours: 1 },
    });
    const expiring = (mintedA.json() as { invite: InviteWire }).invite;

    // Push it into the past. There is no API for this on purpose — an invite is
    // never mintable already-dead — so the clock is moved directly.
    await grove!.store.pg.query(
      `UPDATE space_invites SET expires_at = now() - interval '1 minute' WHERE code = $1`,
      [expiring.code],
    );

    const stale = await server.inject({
      method: "POST",
      url: `/api/v1/invites/${expiring.code}/redeem`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(stale.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);

    // The expired link must not have been burned on the way to failing.
    const after = await grove!.store.pg.query<{ uses: number }>(
      `SELECT uses FROM space_invites WHERE code = $1`,
      [expiring.code],
    );
    expect(Number(after.rows[0]!.uses)).toBe(0);

    const mintedB = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/invites`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    const revocable = (mintedB.json() as { invite: InviteWire }).invite;

    const revoked = await server.inject({
      method: "DELETE",
      url: `/api/v1/worlds/${world.id}/invites/${revocable.code}`,
      headers: { cookie: owner.cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { invite: InviteWire }).invite.active).toBe(false);

    const dead = await server.inject({
      method: "POST",
      url: `/api/v1/invites/${revocable.code}/redeem`,
      headers: { cookie: guest.cookie },
      payload: {},
    });
    expect(dead.statusCode).toBe(404);
    expect(await grove!.campus.isMember(world.id, guest.id)).toBe(false);
  });

  // ------------------------------------------------------------------
  // SPC-03 — orgs bound to spaces, in both render modes.
  // ------------------------------------------------------------------

  it("both org render modes resolve from the same bindings", async () => {
    const server = await boot();
    const owner = await signIn(server, "oown");
    const red = await signIn(server, "ored");
    const blue = await signIn(server, "oblu");
    const plain = await signIn(server, "opln");

    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Two Orgs", slug: `grove-orgs-${Date.now()}`, policy_preset: "public_view" },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    const mkOrg = async (name: string, colour: string) => {
      const res = await server.inject({
        method: "POST",
        url: "/api/v1/orgs",
        headers: { cookie: owner.cookie },
        payload: { name, slug: `${name.toLowerCase()}-${Date.now()}${Math.random().toString(36).slice(2, 5)}`, colour },
      });
      expect(res.statusCode).toBe(201);
      const org = (res.json() as { org: OrgWire }).org;
      trackOrg(org.id);
      return org;
    };

    const orgRed = await mkOrg("Redco", "#ff0044");
    const orgBlue = await mkOrg("Bluivy", "#0044ff");
    expect(orgRed.colour).toBe("#ff0044");

    // A colour that is not a hex triple is refused rather than quietly coerced.
    const badColour = await server.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: { cookie: owner.cookie },
      payload: { name: "Nope", colour: "rebeccapurple" },
    });
    expect(badColour.statusCode).toBe(400);

    for (const [org, human] of [
      [orgRed, red],
      [orgBlue, blue],
    ] as const) {
      const added = await server.inject({
        method: "POST",
        url: `/api/v1/orgs/${org.id}/members`,
        headers: { cookie: owner.cookie },
        payload: { handle: human.handle },
      });
      expect(added.statusCode).toBe(201);
      const admitted = await server.inject({
        method: "POST",
        url: `/api/v1/worlds/${world.id}/members`,
        headers: { cookie: owner.cookie },
        payload: { handle: human.handle },
      });
      expect(admitted.statusCode).toBe(201);
    }
    // A member of the space who belongs to no bound org: they must come back
    // untinted in shared mode and tinted in dedicated mode.
    await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/members`,
      headers: { cookie: owner.cookie },
      payload: { handle: plain.handle },
    });

    // Someone else's org cannot be dragged onto this plot.
    const strangerOrg = await server.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: { cookie: red.cookie },
      payload: { name: "Redsown", colour: "#112233" },
    });
    const foreign = (strangerOrg.json() as { org: OrgWire }).org;
    trackOrg(foreign.id);
    const hijack = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/orgs`,
      headers: { cookie: owner.cookie },
      payload: { org_id: foreign.id },
    });
    expect(hijack.statusCode).toBe(404);

    for (const org of [orgRed, orgBlue]) {
      const bound = await server.inject({
        method: "POST",
        url: `/api/v1/worlds/${world.id}/orgs`,
        headers: { cookie: owner.cookie },
        payload: { org_id: org.id },
      });
      expect(bound.statusCode).toBe(201);
    }

    const readDetail = async () =>
      (
        await server.inject({
          method: "GET",
          url: `/api/v1/worlds/${world.id}`,
          headers: { cookie: owner.cookie },
        })
      ).json() as {
        org_render_mode: string;
        orgs: OrgWire[];
        org_bodies: Array<{ human_id: string; org_id: string; colour: string }>;
      };

    // SHARED: both orgs show, and each body takes its OWN org's colour.
    const shared = await readDetail();
    expect(shared.org_render_mode).toBe("shared");
    expect(shared.orgs.map((o) => o.id).sort()).toEqual([orgRed.id, orgBlue.id].sort());
    const tint = (humanId: string) => shared.org_bodies.find((b) => b.human_id === humanId);
    expect(tint(red.id)!.colour).toBe("#ff0044");
    expect(tint(blue.id)!.colour).toBe("#0044ff");
    expect(tint(plain.id)).toBeUndefined();

    // The directory carries the same bindings, so a minimap can tint a plot.
    const directory = await server.inject({
      method: "GET",
      url: "/api/v1/worlds/directory",
      headers: { cookie: owner.cookie },
    });
    const entry = (
      directory.json() as { spaces: Array<{ id: string; orgs: OrgWire[]; org_render_mode: string }> }
    ).spaces.find((e) => e.id === world.id);
    expect(entry!.org_render_mode).toBe("shared");
    expect(entry!.orgs.map((o) => o.colour).sort()).toEqual(["#0044ff", "#ff0044"]);

    // DEDICATED refuses to turn on while two orgs are bound: the render would
    // have to pick one silently.
    const tooMany = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { org_render_mode: "dedicated" },
    });
    expect(tooMany.statusCode).toBe(400);
    expect((tooMany.json() as { error: { code: string } }).error.code).toBe("INVALID");

    const unbound = await server.inject({
      method: "DELETE",
      url: `/api/v1/worlds/${world.id}/orgs/${orgBlue.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(unbound.statusCode).toBe(200);

    const flipped = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { org_render_mode: "dedicated" },
    });
    expect(flipped.statusCode).toBe(200);

    // DEDICATED: the space IS Redco's home, so EVERY body reads as Redco —
    // including the human who belongs to no org at all.
    const dedicated = await readDetail();
    expect(dedicated.org_render_mode).toBe("dedicated");
    expect(dedicated.orgs).toHaveLength(1);
    const everyone = new Set(dedicated.org_bodies.map((b) => b.human_id));
    expect(everyone.has(owner.id)).toBe(true);
    expect(everyone.has(plain.id)).toBe(true);
    expect(everyone.has(blue.id)).toBe(true);
    expect(dedicated.org_bodies.every((b) => b.colour === "#ff0044")).toBe(true);

    // While dedicated, a second binding is refused — same rule from the other
    // side, so the two modes can never disagree about how many orgs are here.
    const secondBind = await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/orgs`,
      headers: { cookie: owner.cookie },
      payload: { org_id: orgBlue.id },
    });
    expect(secondBind.statusCode).toBe(400);

    // Back to shared, and the bindings are exactly where they were: the mode is
    // a toggle over one model, not a migration between two.
    const backToShared = await server.inject({
      method: "PATCH",
      url: `/api/v1/worlds/${world.id}`,
      headers: { cookie: owner.cookie },
      payload: { org_render_mode: "shared" },
    });
    expect(backToShared.statusCode).toBe(200);
    const reshared = await readDetail();
    expect(reshared.orgs.map((o) => o.id)).toEqual([orgRed.id]);
    expect(reshared.org_bodies.find((b) => b.human_id === plain.id)).toBeUndefined();
    expect(reshared.org_bodies.find((b) => b.human_id === red.id)!.colour).toBe("#ff0044");
  });

  it("a non-member of a private space sees no org bodies", async () => {
    const server = await boot();
    const owner = await signIn(server, "obow");
    const outsider = await signIn(server, "oout");
    const created = await server.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Tinted View", slug: `grove-tint-${Date.now()}`, policy_preset: "public_view" },
    });
    const world = (created.json() as { world: { id: string } }).world;
    trackWorld(world.id);

    const org = (
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/orgs",
          headers: { cookie: owner.cookie },
          payload: { name: "Viewco", colour: "#33ddaa" },
        })
      ).json() as { org: OrgWire }
    ).org;
    trackOrg(org.id);
    await server.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/orgs`,
      headers: { cookie: owner.cookie },
      payload: { org_id: org.id },
    });

    // The binding is public — it is part of what the plot looks like. Who is
    // inside it, tinted or not, is not.
    const seen = (
      await server.inject({
        method: "GET",
        url: `/api/v1/worlds/${world.id}`,
        headers: { cookie: outsider.cookie },
      })
    ).json() as { orgs: OrgWire[]; org_bodies: unknown[]; members: unknown[] };
    expect(seen.orgs.map((o) => o.colour)).toEqual(["#33ddaa"]);
    expect(seen.org_bodies).toEqual([]);
    expect(seen.members).toEqual([]);
  });

});

describe("integration db guard", () => {
  it("runs only against a database whose name ends in _test", () => {
    expect(isTestDatabase("postgres://u:p@localhost:5432/grove_test")).toBe(true);
    expect(isTestDatabase("postgresql://u:p@db.internal:5432/grove_test?sslmode=require")).toBe(true);
    // Live campuses, and anything merely test-ish, must not qualify.
    expect(isTestDatabase("postgres://u:p@localhost:5432/grove")).toBe(false);
    expect(isTestDatabase("postgres://u:p@localhost:5432/grove_prod")).toBe(false);
    expect(isTestDatabase("postgres://u:p@localhost:5432/test_grove")).toBe(false);
    expect(isTestDatabase("postgres://u:p@localhost:5432/grove_testing")).toBe(false);
    expect(isTestDatabase("postgres://u:p@localhost:5432/")).toBe(false);
    expect(isTestDatabase("not a url")).toBe(false);
    expect(isTestDatabase("")).toBe(false);
  });

  it("gates the suite on that check alone, not on DATABASE_URL being set", () => {
    // @grove/domain loads .env on import, so DATABASE_URL is almost always set
    // by the time this file is evaluated; only the _test suffix may open the gate.
    expect(hasDb).toBe(isTestDatabase(DATABASE_URL));
    if (hasDb) expect(databaseName(DATABASE_URL)?.endsWith(TEST_DB_SUFFIX)).toBe(true);
  });
});
