import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.spaceAccess;

// Writes real rows, so it refuses any database not named *_test. A bare
// "is DATABASE_URL set?" check is not enough: importing the domain package
// loads .env as a side effect and populates it from the deployed config.
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("space access reaches the kernel", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  // Shared apparatus: foreign-key ordered sweep, protected-id guards,
  // derive-don't-trust owner sweeps, loud on failure. See ./support/fixtures.ts.
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  const tag = () => Math.random().toString(36).slice(2, 10);

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    // Own bucket, so clearing it cannot disturb a test file running in parallel.
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    return agent;
  }

  /** Clear the per-actor speech limiters so back-to-back fixtures don't trip them. */
  async function unthrottle(id: string) {
    await clearActorLimiters(redis, id);
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the space access suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    // cleanup() throws if anything failed to delete, so a leak fails the suite
    // loudly. Close the connections either way.
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function makeSpace(preset: "private" | "public_view" | "public_write") {
    const owner = await newHuman("owner");
    const space = await grove.campus.createWorld(owner, {
      name: `Space ${tag()}`,
      slug: `space-${tag()}`,
      preset,
    });
    fixtures.trackWorld(space.id);
    return { owner, space };
  }

  it("allocates every claimed space a distinct plot, and none to the civic core", async () => {
    const a = await makeSpace("public_write");
    const b = await makeSpace("public_write");
    expect(a.space.plotIndex).not.toBeNull();
    expect(b.space.plotIndex).not.toBeNull();
    expect(a.space.plotIndex).not.toBe(b.space.plotIndex);
    const core = await grove.campus.getWorld("aetheria-prime");
    expect(core?.plotIndex).toBeNull();
  });

  it("leaves the commons wide open: no space ceiling on a canonical room", async () => {
    expect(await grove.campus.spacePolicyForRoom("plaza")).toBeUndefined();
    expect(await grove.campus.memberIdsOf("aetheria-prime")).toBeNull();
  });

  it("resolves a private space's ceiling from its preset", async () => {
    const { space } = await makeSpace("private");
    const policy = await grove.campus.spacePolicyForRoom(`${space.id}:plaza`);
    expect(policy).toEqual({
      speakToAgents: false,
      speakToHumans: false,
      listenToAgents: false,
      listenToHumans: false,
    });
  });

  it("counts the owner as a member without an explicit membership row", async () => {
    const { owner, space } = await makeSpace("private");
    const members = await grove.campus.memberIdsOf(space.id);
    expect(members).not.toBeNull();
    expect(members!.has(owner.id)).toBe(true);
  });

  it("silences a non-member in a private space but not the owner", async () => {
    const { owner, space } = await makeSpace("private");
    const outsider = await newHuman("outsider");
    const ownerAgent = await newAgent(owner, `host${tag()}`);
    const guestAgent = await newAgent(outsider, `guest${tag()}`);
    const room = `${space.id}:plaza`;

    await grove.presence.enter({ id: ownerAgent.id, kind: "agent", ownerHumanId: owner.id }, room, {
      connection: "async", mode: "autonomous", activity: "idle", worldId: space.id,
    });
    await grove.presence.enter({ id: guestAgent.id, kind: "agent", ownerHumanId: outsider.id }, room, {
      connection: "async", mode: "autonomous", activity: "idle", worldId: space.id,
    });

    await unthrottle(guestAgent.id);
    const guestCtx = await grove.speech.buildContext(
      { kind: "agent", agent: guestAgent },
      { channel: "room_say", body: "can anyone hear me" },
    );
    expect(guestCtx.sender.isSpaceMember).toBe(false);
    expect(guestCtx.room?.policy).toBeDefined();

    await unthrottle(ownerAgent.id);
    const ownerCtx = await grove.speech.buildContext(
      { kind: "agent", agent: ownerAgent },
      { channel: "room_say", body: "my house" },
    );
    expect(ownerCtx.sender.isSpaceMember).toBe(true);

    // The real proof: same room, same four-boolean agent policy, opposite outcome.
    await unthrottle(guestAgent.id);
    await expect(
      grove.speech.say({ kind: "agent", agent: guestAgent }, {
        channel: "room_say", body: "can anyone hear me", idempotencyKey: `k-${tag()}`,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await unthrottle(ownerAgent.id);
    const ack = await grove.speech.say({ kind: "agent", agent: ownerAgent }, {
      channel: "room_say", body: "my house", idempotencyKey: `k-${tag()}`,
    });
    expect(ack.deliveredCount).toBeGreaterThanOrEqual(0);
  });

  it("public_view lets a non-member listen but not speak", async () => {
    const { owner, space } = await makeSpace("public_view");
    const outsider = await newHuman("viewer");
    const guestAgent = await newAgent(outsider, `viewer${tag()}`);
    const room = `${space.id}:plaza`;
    await grove.presence.enter({ id: guestAgent.id, kind: "agent", ownerHumanId: outsider.id }, room, {
      connection: "async", mode: "autonomous", activity: "idle", worldId: space.id,
    });
    const policy = await grove.campus.spacePolicyForRoom(room);
    expect(policy).toEqual({
      speakToAgents: false,
      speakToHumans: false,
      listenToAgents: true,
      listenToHumans: true,
    });
    await unthrottle(guestAgent.id);
    await expect(
      grove.speech.say({ kind: "agent", agent: guestAgent }, {
        channel: "room_say", body: "hello?", idempotencyKey: `k-${tag()}`,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(owner.id).toBeTruthy();
  });

  it("refuses a raw campus room id when the request names the commons", async () => {
    // The gate on POST /rooms/:slug/enter is only worth anything if the room
    // lookup itself is world-scoped. getRoom's id fallback used to ignore the
    // world entirely, so a stranger could walk into a private campus by id.
    const { space } = await makeSpace("private");
    const outsider = await newHuman("walkin");
    const guest = await newAgent(outsider, `walkin${tag()}`);
    await expect(
      grove.presence.enter({ id: guest.id, kind: "agent", ownerHumanId: outsider.id }, `${space.id}:plaza`, {
        connection: "async", mode: "autonomous", activity: "idle", worldId: "aetheria-prime",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("still resolves a campus room by trusted id for someone already standing in it", async () => {
    // The scoping fix must not strand an actor inside their own space: observe
    // and speech resolve the room from the presence table, which is trusted.
    const { owner, space } = await makeSpace("private");
    const agent = await newAgent(owner, `resident${tag()}`);
    const room = `${space.id}:plaza`;
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, room, {
      connection: "async", mode: "autonomous", activity: "idle", worldId: space.id,
    });
    expect(await grove.presence.getRoomById(room)).toMatchObject({ id: room });
    expect(await grove.presence.getRoom(room, "aetheria-prime")).toBeNull();
    const ctx = await grove.speech.buildContext(
      { kind: "agent", agent },
      { channel: "room_say", body: "still here" },
    );
    expect(ctx.room?.id).toBe(room);
  });

  it("public_write behaves exactly as an ungated room for a non-member", async () => {
    const { space } = await makeSpace("public_write");
    const outsider = await newHuman("writer");
    const guestAgent = await newAgent(outsider, `writer${tag()}`);
    const room = `${space.id}:plaza`;
    await grove.presence.enter({ id: guestAgent.id, kind: "agent", ownerHumanId: outsider.id }, room, {
      connection: "async", mode: "autonomous", activity: "idle", worldId: space.id,
    });
    await unthrottle(guestAgent.id);
    const ack = await grove.speech.say({ kind: "agent", agent: guestAgent }, {
      channel: "room_say", body: "open house", idempotencyKey: `k-${tag()}`,
    });
    expect(ack.id).toBeTruthy();
  });
});
