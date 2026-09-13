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

/**
 * SPC-07 (per-room override) + SPC-10 (member ceilings), end to end through
 * the domain: storage, the kernel context, speech, the in-room broadcast,
 * eviction when a door closes, and the private-contents non-leak on the
 * directory, the minimap and observe.
 */
const REGISTER_IP = REGISTER_IPS.roomPolicy;
const hasDb = hasTestDatabase();

const LISTEN_ONLY = { speak_to_agents: false, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true };
const OPEN = { speak_to_agents: true, speak_to_humans: true, listen_to_agents: true, listen_to_humans: true };

describe.skipIf(!hasDb)("room policy (SPC-07 / SPC-10)", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner);
  }

  async function makeSpace(preset: "private" | "public_view" | "public_write") {
    const owner = await newHuman("rpown");
    const space = await grove.campus.createWorld(owner, { name: `Space ${tag()}`, slug: `rp-${tag()}`, preset });
    fixtures.trackWorld(space.id);
    return { owner, space };
  }

  async function place(agent: { id: string; ownerHumanId: string | null }, worldId: string, slug: string) {
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: agent.ownerHumanId }, slug, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId,
    });
  }

  async function sayAs(agent: Awaited<ReturnType<typeof newAgent>>, body = "hello") {
    await clearActorLimiters(redis, agent.id);
    return grove.speech.say({ kind: "agent", agent }, { channel: "room_say", body, idempotencyKey: `k-${tag()}` });
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the room policy suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  it("migration 023 is inherit-by-default: a fresh space's rooms carry no override", async () => {
    const { space } = await makeSpace("private");
    const rooms = await grove.campus.roomsOf(space.id);
    expect(rooms.length).toBeGreaterThan(0);
    for (const r of rooms) {
      expect(r.roomPreset).toBeNull();
      expect(r.memberPolicy).toBeNull();
      expect(r.admitsNonMembers).toBe(false);
    }
    expect(space.memberPolicy).toBeNull();
    // And the kernel context is exactly the old one: only the space's policy.
    const layers = await grove.campus.ceilingLayersForRoom(`${space.id}:plaza`);
    expect(Object.keys(layers ?? {})).toEqual(["policy"]);
    expect(await grove.campus.ceilingLayersForRoom("plaza")).toBeUndefined();
  });

  it("a public_view lobby in a private space: a visitor hears but cannot speak, and the ROOM is named", async () => {
    const { owner, space } = await makeSpace("private");
    await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "public_view" });
    const outsider = await newHuman("rpvis");
    const visitor = await newAgent(outsider, `vis${tag()}`);
    const host = await newAgent(owner, `host${tag()}`);
    await place(visitor, space.id, "plaza");
    await place(host, space.id, "plaza");

    await expect(sayAs(visitor)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      source: "room",
      membership: "non_member",
    });
    const ack = await sayAs(host, "welcome in");
    // The member's line reaches the visitor: the lobby lets non-members listen.
    expect(ack.undelivered.find((u) => u.actorId === visitor.id)).toBeUndefined();

    // The same visitor in a room nobody opened is refused by the SPACE.
    await place(visitor, space.id, "library");
    await expect(sayAs(visitor)).rejects.toMatchObject({ source: "space", membership: "non_member" });
  });

  it("a closed room in a public space: non-members refused by the room; members untouched", async () => {
    const { owner, space } = await makeSpace("public_write");
    await grove.campus.updateRoomAccess(owner, space.id, "library", { roomPreset: "private" });
    const outsider = await newHuman("rpout");
    const guest = await newAgent(outsider, `gst${tag()}`);
    const host = await newAgent(owner, `hst${tag()}`);
    await place(guest, space.id, "library");
    await place(host, space.id, "library");
    await expect(sayAs(guest)).rejects.toMatchObject({ source: "room", membership: "non_member" });
    const ack = await sayAs(host);
    const miss = ack.undelivered.find((u) => u.actorId === guest.id);
    expect(miss).toMatchObject({ code: "PERMISSION_DENIED", source: "room", membership: "non_member", capability: "listen_to_agents" });
  });

  it("SPC-10: a space member ceiling holds members; a room member override can re-open one room", async () => {
    const { owner, space } = await makeSpace("private");
    await grove.campus.updateWorld(owner, space.id, { memberPolicy: LISTEN_ONLY });
    const host = await newAgent(owner, `mem${tag()}`);
    await place(host, space.id, "library");
    await expect(sayAs(host)).rejects.toMatchObject({ source: "space", membership: "member" });

    await grove.campus.updateRoomAccess(owner, space.id, "library", { memberPolicy: OPEN });
    await expect(sayAs(host)).resolves.toMatchObject({ channel: "room_say" });

    await grove.campus.updateRoomAccess(owner, space.id, "library", { memberPolicy: LISTEN_ONLY });
    await expect(sayAs(host)).rejects.toMatchObject({ source: "room", membership: "member" });

    // Clearing both returns the room to the space's rule.
    await grove.campus.updateRoomAccess(owner, space.id, "library", { memberPolicy: null });
    await grove.campus.updateWorld(owner, space.id, { memberPolicy: null });
    await expect(sayAs(host)).resolves.toMatchObject({ channel: "room_say" });
  });

  it("refuses bad input, other people's spaces, other spaces' rooms, and the civic core", async () => {
    const { owner, space } = await makeSpace("private");
    const other = await makeSpace("private");
    const stranger = await newHuman("rpstr");
    await expect(grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "public_everything" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.campus.updateRoomAccess(owner, space.id, "plaza", { memberPolicy: { speak_to_agents: true } })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.campus.updateWorld(owner, space.id, { memberPolicy: "listen" })).rejects.toMatchObject({ code: "INVALID" });
    // Not the owner: 404, not 403.
    await expect(grove.campus.updateRoomAccess(stranger, space.id, "plaza", { roomPreset: "public_view" })).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    // A room id from ANOTHER space, addressed through my own: 404.
    await expect(grove.campus.updateRoomAccess(owner, space.id, `${other.space.id}:plaza`, { roomPreset: "public_view" })).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
    await expect(grove.campus.updateRoomAccess(owner, space.id, "no-such-room", { roomPreset: "public_view" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The commons is nobody's to operate: hidden as a 404 for an ordinary human.
    await expect(grove.campus.updateRoomAccess(owner, "aetheria-prime", "plaza", { roomPreset: "private" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // And an operator is told plainly that the core carries no override.
    await expect(
      grove.campus.updateRoomAccess({ ...owner, role: "operator" }, "aetheria-prime", "plaza", { roomPreset: "private" }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("visitableRoom: only the opened room, only in its own space; closed and missing look the same", async () => {
    const { owner, space } = await makeSpace("private");
    const other = await makeSpace("private");
    await grove.campus.updateRoomAccess(owner, space.id, "garden", { roomPreset: "public_write" });
    expect((await grove.campus.visitableRoom(space.id, "garden"))?.id).toBe(`${space.id}:garden`);
    expect((await grove.campus.visitableRoom(space.id, `${space.id}:garden`))?.id).toBe(`${space.id}:garden`);
    expect(await grove.campus.visitableRoom(space.id, "library")).toBeNull();
    expect(await grove.campus.visitableRoom(space.id, "nope")).toBeNull();
    expect(await grove.campus.visitableRoom(other.space.id, `${space.id}:garden`)).toBeNull();
    expect(await grove.campus.visitableRoom("aetheria-prime", "plaza")).toBeNull();
    await grove.campus.updateRoomAccess(owner, space.id, "garden", { roomPreset: "private" });
    expect(await grove.campus.visitableRoom(space.id, "garden")).toBeNull();
  });

  it("broadcasts policy_update in the room when an override changes (§5.6)", async () => {
    const { owner, space } = await makeSpace("public_view");
    const roomId = `${space.id}:workshop`;
    const sub = redis.duplicate();
    const frames: Array<Record<string, unknown>> = [];
    await sub.subscribe(`pubsub:room:${roomId}`);
    sub.on("message", (_ch, msg) => frames.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      await grove.campus.updateRoomAccess(owner, space.id, "workshop", { roomPreset: "private", memberPolicy: LISTEN_ONLY });
      const deadline = Date.now() + 2000;
      while (!frames.some((f) => f.type === "policy_update") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const frame = frames.find((f) => f.type === "policy_update");
      expect(frame).toMatchObject({
        type: "policy_update",
        scope: "room",
        world_id: space.id,
        room_id: roomId,
        room_preset: "private",
        room_member_policy: LISTEN_ONLY,
        space_preset: "public_view",
        admits_non_members: false,
      });
      expect(frame).not.toHaveProperty("actor_id");

      frames.length = 0;
      await grove.campus.updateWorld(owner, space.id, { memberPolicy: LISTEN_ONLY });
      const deadline2 = Date.now() + 2000;
      while (!frames.some((f) => f.type === "policy_update") && Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(frames.find((f) => f.type === "policy_update")).toMatchObject({ scope: "space", space_member_policy: LISTEN_ONLY });
    } finally {
      await sub.quit();
    }
  });

  it("closing an open lobby returns non-members out of it and keeps members", async () => {
    const { owner, space } = await makeSpace("private");
    await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "public_write" });
    const outsider = await newHuman("rpevc");
    const visitor = await newAgent(outsider, `ev${tag()}`);
    const host = await newAgent(owner, `eh${tag()}`);
    await place(visitor, space.id, "plaza");
    await place(host, space.id, "plaza");
    const { evicted } = await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: null });
    expect(evicted).toEqual([visitor.id]);
    expect(await grove.presence.getPresence(visitor.id)).toBeNull();
    expect((await grove.presence.getPresence(host.id))?.roomId).toBe(`${space.id}:plaza`);
    // Narrowing an already-closed room evicts nobody.
    const again = await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "private" });
    expect(again.evicted).toEqual([]);
  });

  it("private contents do not leak: directory + minimap show the lobby and nothing else of a private plot", async () => {
    const { owner, space } = await makeSpace("private");
    await grove.campus.updateRoomAccess(owner, space.id, "garden", { roomPreset: "public_view" });
    const viewer = await newHuman("rpdir");

    const entry = (await grove.campus.listDirectory(viewer.id)).find((s) => s.id === space.id)!;
    expect(entry.name).toBeNull();
    expect(entry.slug).toBeNull();
    expect(entry.ownerHandle).toBeNull();
    expect(entry.openRooms.map((r) => r.id)).toEqual([`${space.id}:garden`]);
    expect(entry.openRooms[0]).toMatchObject({ slug: "garden", roomPreset: "public_view" });
    const text = JSON.stringify(entry);
    expect(text).not.toContain(space.name);
    expect(text).not.toContain(owner.handle);
    for (const hidden of ["library", "workshop", "stage", "board"]) expect(text).not.toContain(`:${hidden}`);

    const map = await grove.world.minimap("aetheria-prime");
    const plot = (map.spaces as Array<{ id: string; name: string | null; openRooms: Array<{ id: string }> }>).find((s) => s.id === space.id)!;
    expect(plot.name).toBeNull();
    expect(plot.openRooms.map((r) => r.id)).toEqual([`${space.id}:garden`]);
  });

  it("observe: a visitor in a lobby gets the room, never the space's Stage or briefings", async () => {
    const { owner, space } = await makeSpace("private");
    await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "public_view" });
    const outsider = await newHuman("rpobs");
    const visitor = await newAgent(outsider, `ob${tag()}`);
    const host = await newAgent(owner, `oh${tag()}`);
    await place(visitor, space.id, "plaza");
    await place(host, space.id, "plaza");
    const seen = (await grove.observe.observe(visitor)) as { room: { id: string }; stage?: unknown; briefings?: unknown };
    expect(seen.room.id).toBe(`${space.id}:plaza`);
    expect(seen.stage).toBeUndefined();
    expect(seen.briefings).toBeUndefined();
    const member = (await grove.observe.observe(host)) as { stage?: unknown };
    expect(member.stage).toBeDefined();
  });

  it("transcript: a visitor reads only what reached them, not what was said while the room was private", async () => {
    const { owner, space } = await makeSpace("private");
    const hostHuman = owner;
    const host = await newAgent(hostHuman, `th${tag()}`);
    await place(host, space.id, "plaza");
    await sayAs(host, "said while private");

    await grove.campus.updateRoomAccess(owner, space.id, "plaza", { roomPreset: "public_view" });
    const outsider = await newHuman("rptr");
    await grove.presence.enter({ id: outsider.id, kind: "human" }, "plaza", {
      connection: "live", mode: "active", activity: "idle", worldId: space.id,
    });
    await sayAs(host, "said after opening");

    const roomId = `${space.id}:plaza`;
    const visitorView = await grove.speech.transcript(roomId, { kind: "human", human: outsider }, undefined, 50, { deliveredOnly: true });
    const bodies = visitorView.items.map((i) => i.body);
    expect(bodies).toContain("said after opening");
    expect(bodies).not.toContain("said while private");
  });
  it("public presets admit non-members to every inheriting room; a private room and a private space do not", async () => {
    const view = await makeSpace("public_view");
    const write = await makeSpace("public_write");
    const priv = await makeSpace("private");
    expect((await grove.campus.visitableRoom(view.space.id, "plaza"))?.id).toBe(`${view.space.id}:plaza`);
    expect((await grove.campus.visitableRoom(write.space.id, "library"))?.id).toBe(`${write.space.id}:library`);
    expect(await grove.campus.visitableRoom(priv.space.id, "plaza")).toBeNull();
    expect((await grove.campus.roomsOf(view.space.id)).every((r) => r.admitsNonMembers)).toBe(true);
    await grove.campus.updateRoomAccess(write.owner, write.space.id, "library", { roomPreset: "private" });
    expect(await grove.campus.visitableRoom(write.space.id, "library")).toBeNull();
    expect((await grove.campus.roomsOf(write.space.id)).find((r) => r.slug === "library")?.admitsNonMembers).toBe(false);
  });

  it("a public space turned private returns its visitors out and keeps members", async () => {
    const { owner, space } = await makeSpace("public_write");
    const outsider = await newHuman("rpspc");
    const visitor = await newAgent(outsider, `sv${tag()}`);
    const host = await newAgent(owner, `sh${tag()}`);
    await place(visitor, space.id, "plaza");
    await place(host, space.id, "plaza");
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "private" });
    expect(await grove.presence.getPresence(visitor.id)).toBeNull();
    expect((await grove.presence.getPresence(host.id))?.roomId).toBe(`${space.id}:plaza`);
  });
});
