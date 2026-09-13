/**
 * Queue #50: nothing that happens behind a closed door reaches anyone outside
 * it, whatever reader asks and whatever the event type.
 *
 * Doors: a private space, a private room (room_preset 'private') inside an open
 * space, and an owner's lounge. Readers: the chronicle (unfiltered and by
 * world), replay, tool-call history, follow notices, reactions, the space
 * directory, the public minimap's plots and search. Outsiders: a signed-out
 * visitor (which is also what a guest pass reads as), a signed-in stranger and
 * an operator who is not inside. Insiders get it.
 *
 * Like the chronicle suite, every assertion pins the exact rows an action wrote,
 * because other suites write to the same tables in parallel.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { WORLD_ID } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import type { ChronicleViewer } from "../src/services/chronicle.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.privateActivity;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("private activity never leaves its door", { timeout: 60_000 }, () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);
  const ANON: ChronicleViewer = { humanId: null, isOperator: false };
  const asHuman = (id: string): ChronicleViewer => ({ humanId: id, isOperator: false });
  const asOperator = (id: string): ChronicleViewer => ({ humanId: id, isOperator: true });

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the private activity suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await redis.quit();
    await pg.end();
  });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newOperator(prefix: string) {
    const human = await newHuman(prefix);
    await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [human.id]);
    return { ...human, role: "operator" as const };
  }

  async function newAgent(owner: { id: string }, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner as never);
  }

  async function lastEventId(type: string, actorId: string): Promise<string> {
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 1`,
      [type, actorId],
    );
    const row = rows[0] as { id: string } | undefined;
    if (!row) throw new Error(`no ${type} event for ${actorId}`);
    return String(row.id);
  }

  /** Every event id a viewer can reach in the recent window, over every page. */
  async function idsFor(viewer: ChronicleViewer, worldId: string | null = null): Promise<Set<string>> {
    const out = new Set<string>();
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    let cursor: string | null = null;
    for (let page = 0; page < 60; page++) {
      const p = await grove.chronicle.read(viewer, { since, worldId, limit: 200, cursor });
      for (const e of p.entries) out.add(e.id);
      if (!p.nextCursor) return out;
      cursor = p.nextCursor;
    }
    throw new Error("chronicle pagination did not terminate");
  }

  const enterAs = (agent: { id: string }, ownerId: string, slug: string, worldId?: string) =>
    grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: ownerId }, slug, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      ...(worldId ? { worldId } : {}),
    });

  it("gates EVERY event type by its place, notices included, with no operator bypass", async () => {
    const owner = await newHuman("pa-owner");
    const stranger = await newHuman("pa-stranger");
    const operator = await newOperator("pa-op");
    const space = await grove.campus.createWorld(owner, { name: `Shut ${tag()}`, slug: `shut-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    const resident = await newAgent(owner, `pares${tag()}`);
    await enterAs(resident, owner.id, `${space.id}:plaza`, space.id);
    const joined = await lastEventId("actor_joined_room", resident.id);

    // A notice-typed row that names a room inside the private space: the arm of
    // the CASE that had no world gate (found by #26). Written the way every
    // ledger writer writes, so any future type naming a room is covered the same.
    const secret = `behind the door ${tag()}`;
    await grove.identity.audit("notice", owner.id, { title: secret, roomId: `${space.id}:plaza` });
    const notice = await lastEventId("notice", owner.id);

    for (const outsider of [ANON, asHuman(stranger.id), asOperator(operator.id)]) {
      const ids = await idsFor(outsider);
      expect(ids).not.toContain(joined);
      expect(ids).not.toContain(notice);
      const page = await grove.chronicle.read(outsider, { limit: 200 });
      expect(JSON.stringify(page)).not.toContain(secret);
      expect(JSON.stringify(page)).not.toContain(space.id);
      expect(await grove.chronicle.entryById(outsider, notice)).toBeNull();
    }
    const mine = await idsFor(asHuman(owner.id));
    expect(mine).toContain(joined);
    expect(mine).toContain(notice);
    expect(await idsFor(asHuman(owner.id), space.id)).toContain(notice);

    // Membership lifts it; it is the door, not the person.
    await grove.campus.addMember(space.id, stranger.id);
    expect(await idsFor(asHuman(stranger.id))).toContain(notice);
  });

  it("keeps a private room inside an open space, and an owner's lounge, to the people inside", async () => {
    const owner = await newHuman("pa-room-owner");
    const stranger = await newHuman("pa-room-stranger");
    const operator = await newOperator("pa-room-op");
    const space = await grove.campus.createWorld(owner, { name: `Half ${tag()}`, slug: `half-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    await grove.campus.updateRoomAccess(owner, space.id, `${space.id}:library`, { roomPreset: "private" });
    const resident = await newAgent(owner, `parr${tag()}`);
    await enterAs(resident, owner.id, `${space.id}:library`, space.id);
    const inRoom = await lastEventId("actor_joined_room", resident.id);

    await grove.presence.enter({ id: owner.id, kind: "human" }, "lounge", {
      connection: "live",
      mode: "active",
      activity: "idle",
    });
    const inLounge = await lastEventId("actor_joined_room", owner.id);

    for (const outsider of [ANON, asHuman(stranger.id), asOperator(operator.id)]) {
      const ids = await idsFor(outsider);
      expect(ids).not.toContain(inRoom);
      expect(ids).not.toContain(inLounge);
    }
    const mine = await idsFor(asHuman(owner.id));
    expect(mine).toContain(inRoom);
    expect(mine).toContain(inLounge);

    // Replay of the space, as an outsider who somehow reached the route, and as the owner.
    const win = { since: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 5_000).toISOString(), worldId: space.id };
    const outsiderReplay = await grove.replay.window(asHuman(stranger.id), win);
    expect(outsiderReplay.entries.map((e) => e.id)).not.toContain(inRoom);
    expect(outsiderReplay.keyframe?.bodies.map((b) => b.actorId) ?? []).not.toContain(resident.id);
    expect((await grove.replay.window(asHuman(owner.id), win)).entries.map((e) => e.id)).toContain(inRoom);

    // Nobody walks into someone else's lounge: it answers like no such room.
    await clearActorLimiters(redis, stranger.id);
    await expect(
      grove.presence.enter({ id: stranger.id, kind: "human" }, `lounge_${owner.id}`, {
        connection: "live",
        mode: "active",
        activity: "idle",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shows a notice's words only to its author, operators and the author's owner", async () => {
    const author = await newHuman("pa-notice");
    const reader = await newHuman("pa-notice-reader");
    const operator = await newOperator("pa-notice-op");
    await grove.presence.enter({ id: author.id, kind: "human" }, "board", { connection: "live", mode: "active", activity: "idle" });
    await clearActorLimiters(redis, author.id);
    const title = `pinned words ${tag()}`;
    await grove.notices.post({ kind: "human", human: author }, { title, body: "body stays on the board", pinned: false });
    const id = await lastEventId("notice", author.id);

    const readerEntry = await grove.chronicle.entryById(asHuman(reader.id), id);
    expect(readerEntry).not.toBeNull();
    expect(readerEntry!.detail.title).toBeUndefined();
    expect(JSON.stringify(readerEntry)).not.toContain(title);
    expect(await grove.chronicle.entryById(ANON, id)).toBeNull();
    expect((await grove.chronicle.entryById(asHuman(author.id), id))!.detail.title).toBe(title);
    expect((await grove.chronicle.entryById(asOperator(operator.id), id))!.detail.title).toBe(title);
  });

  it("keeps a private room's tool-call history and follow notices inside it", async () => {
    const owner = await newHuman("pa-tc-owner");
    const fan = await newHuman("pa-tc-fan");
    const operator = await newOperator("pa-tc-op");
    const space = await grove.campus.createWorld(owner, { name: `Work ${tag()}`, slug: `work-${tag()}`, preset: "public_write" });
    fixtures.trackWorld(space.id);
    await grove.campus.updateRoomAccess(owner, space.id, `${space.id}:workshop`, { roomPreset: "private" });
    const agent = await newAgent(owner, `patc${tag()}`);
    await grove.follows.setFollow({ kind: "human", human: fan }, "agent", agent.slug, true);
    await enterAs(agent, owner.id, `${space.id}:workshop`, space.id);
    const t0 = Date.now();
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.start(agent.id, { callId: `c-${tag()}`, name: "Bash", args: "make" });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "error", "broke inside", { errorText: "exit 2" });

    const q = { since: new Date(t0 - 5_000).toISOString(), until: new Date(Date.now() + 5_000).toISOString(), worldId: space.id };
    expect(await grove.chronicle.toolCallHistory(asOperator(operator.id), q)).toEqual([]);
    expect((await grove.chronicle.toolCallHistory(asHuman(owner.id), q)).length).toBe(1);
    expect((await grove.follows.notices(fan.id)).items).toEqual([]);
  });

  it("counts no headcount behind a closed door on the minimap, the directory or search", async () => {
    const owner = await newHuman("pa-occ-owner");
    const stranger = await newHuman("pa-occ-stranger");
    const shut = await grove.campus.createWorld(owner, { name: `Hush ${tag()}`, slug: `hush-${tag()}`, preset: "private" });
    fixtures.trackWorld(shut.id);
    const open = await grove.campus.createWorld(owner, { name: `Airy ${tag()}`, slug: `airy-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(open.id);
    await grove.campus.updateRoomAccess(owner, open.id, `${open.id}:library`, { roomPreset: "private" });
    await enterAs(await newAgent(owner, `paoa${tag()}`), owner.id, `${shut.id}:plaza`, shut.id);
    await enterAs(await newAgent(owner, `paob${tag()}`), owner.id, `${open.id}:library`, open.id);

    const map = await grove.world.minimap(WORLD_ID);
    expect(map.spaces.find((s) => s.id === shut.id)?.occupancy).toBe(0);
    expect(map.spaces.find((s) => s.id === open.id)?.occupancy).toBe(0);

    const dirStranger = await grove.campus.listDirectory(stranger.id);
    expect(dirStranger.find((s) => s.id === shut.id)?.occupancy).toBe(0);
    expect(dirStranger.find((s) => s.id === open.id)?.occupancy).toBe(0);
    expect((await grove.campus.listDirectory(null)).find((s) => s.id === shut.id)?.occupancy).toBe(0);
    const dirOwner = await grove.campus.listDirectory(owner.id);
    expect(dirOwner.find((s) => s.id === shut.id)?.occupancy).toBe(1);
    expect(dirOwner.find((s) => s.id === open.id)?.occupancy).toBe(1);

    const found = await grove.search.search(stranger.id, open.slug);
    expect(found.spaces.find((s) => s.slug === open.slug)?.occupancy).toBe(0);
    expect((await grove.search.search(stranger.id, shut.slug)).spaces).toEqual([]);
    expect((await grove.search.search(owner.id, open.slug)).spaces.find((s) => s.slug === open.slug)?.occupancy).toBe(1);
  });

  it("never reads out a private event's reaction count through an unreact", async () => {
    const owner = await newHuman("pa-rx-owner");
    const stranger = await newHuman("pa-rx-stranger");
    const space = await grove.campus.createWorld(owner, { name: `Rx ${tag()}`, slug: `rx-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    const resident = await newAgent(owner, `parx${tag()}`);
    await enterAs(resident, owner.id, `${space.id}:plaza`, space.id);
    const joined = await lastEventId("actor_joined_room", resident.id);

    await clearActorLimiters(redis, owner.id);
    const mine = await grove.reactions.react({ kind: "human", human: owner }, { targetKind: "event", targetId: joined, emoji: "up" });
    expect(mine.summary.counts.up).toBe(1);

    await expect(
      grove.reactions.react({ kind: "human", human: stranger }, { targetKind: "event", targetId: joined, emoji: "up" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const off = await grove.reactions.react(
      { kind: "human", human: stranger },
      { targetKind: "event", targetId: joined, emoji: "up", on: false },
    );
    expect(off.summary).toEqual({ counts: {}, mine: [] });
  });
});
