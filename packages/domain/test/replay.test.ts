import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { WORLD_ID } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import type { ChronicleViewer } from "../src/services/chronicle.js";
import type { ReplayPage } from "../src/services/replay.js";
import { densityBucketSeconds } from "../src/services/replay.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.replay;
const hasDb = hasTestDatabase();

/**
 * Replay is a reader over the chronicle, so the property worth proving is the
 * one the chronicle proves, restated for the new shapes replay adds: forward
 * pages, the keyframe and the density histogram must each refuse exactly what
 * the live world refused. Like the chronicle suite, every assertion pins the
 * ledger rows an action produced, because other suites write to the same table
 * in parallel.
 */
describe.skipIf(!hasDb)("replay never shows what the moment refused", { timeout: 30_000 }, () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);
  const ANON: ChronicleViewer = { humanId: null, isOperator: false };
  const asHuman = (id: string): ChronicleViewer => ({ humanId: id, isOperator: false });
  const asOperator = (id: string): ChronicleViewer => ({ humanId: id, isOperator: true });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
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

  const windowAround = (startMs: number) => ({
    since: new Date(startMs - 5_000).toISOString(),
    until: new Date(Date.now() + 5_000).toISOString(),
  });

  /** Every page of a window, in order. */
  async function allPages(viewer: ChronicleViewer, q: { since: string; until: string; worldId: string }) {
    const pages: ReplayPage[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 60; i++) {
      const page = await grove.replay.window(viewer, { ...q, cursor, limit: 1000 });
      pages.push(page);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
    }
    throw new Error("replay pagination did not terminate");
  }

  const idsOf = (pages: ReplayPage[]) => new Set(pages.flatMap((p) => [...p.entries, ...p.trailing].map((e) => e.id)));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the replay suite");
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

  it("keeps a private space's movements out of a stranger's replay — entries, keyframe and density", async () => {
    const owner = await newHuman("replay-space-owner");
    const space = await grove.campus.createWorld(owner, {
      name: `Hidden ${tag()}`,
      slug: `hidden-${tag()}`,
      preset: "private",
    });
    fixtures.trackWorld(space.id);
    const resident = await newAgent(owner, `resident${tag()}`);
    const t0 = Date.now();
    await grove.presence.enter({ id: resident.id, kind: "agent", ownerHumanId: owner.id }, `${space.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: space.id,
    });
    const joined = await lastEventId("actor_joined_room", resident.id);
    const stranger = await newHuman("replay-stranger");
    const operator = await newHuman("replay-op");
    await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [operator.id]);

    const win = windowAround(t0);
    for (const worldId of [space.id, WORLD_ID]) {
      for (const viewer of [asHuman(stranger.id), ANON, asOperator(operator.id)]) {
        const pages = await allPages(viewer, { ...win, worldId });
        expect(idsOf(pages)).not.toContain(joined);
        // Inside the space's own world, not even the resident's name leaks.
        // (Its registration is a worldless civic event and lives in the commons.)
        if (worldId === space.id) expect(JSON.stringify(pages)).not.toContain(resident.id);
      }
    }
    // The density of the private space is empty for the stranger: a histogram
    // is a disclosure too ("something happened in there at 03:00").
    const strangerView = await grove.replay.window(asHuman(stranger.id), { ...win, worldId: space.id });
    expect(strangerView.density?.buckets ?? []).toHaveLength(0);

    // The owner sees it all, in the space's own world.
    const ownerPages = await allPages(asHuman(owner.id), { ...win, worldId: space.id });
    expect(idsOf(ownerPages)).toContain(joined);
    expect(ownerPages[0]!.density!.buckets.reduce((n, b) => n + b.n, 0)).toBeGreaterThan(0);

    // A keyframe AFTER the join holds the body for the owner and never for the stranger.
    const later = { since: new Date(Date.now() + 1_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString() };
    const ownerFrame = await grove.replay.window(asHuman(owner.id), { ...later, worldId: space.id });
    expect(ownerFrame.keyframe!.bodies.map((b) => b.actorId)).toContain(resident.id);
    const strangerFrame = await grove.replay.window(asHuman(stranger.id), { ...later, worldId: space.id });
    expect(strangerFrame.keyframe!.bodies.map((b) => b.actorId)).not.toContain(resident.id);
    const anonFrame = await grove.replay.window(ANON, { ...later, worldId: WORLD_ID });
    expect(anonFrame.keyframe!.bodies.map((b) => b.actorId)).not.toContain(resident.id);

    // Membership lifts it, exactly as it lifts the live directory.
    await grove.campus.addMember(space.id, stranger.id);
    expect(idsOf(await allPages(asHuman(stranger.id), { ...win, worldId: space.id }))).toContain(joined);
  });

  it("plays a spoken line only to those it was delivered to — like the room feed, not even the fact — and never a whisper", async () => {
    const speakerOwner = await newHuman("replay-speaker");
    const listenerOwner = await newHuman("replay-listener");
    const bystander = await newHuman("replay-bystander");
    const speaker = await newAgent(speakerOwner, `rspeaker${tag()}`);
    const listener = await newAgent(listenerOwner, `rlistener${tag()}`);
    const t0 = Date.now();
    for (const [agent, owner] of [
      [speaker, speakerOwner],
      [listener, listenerOwner],
    ] as const) {
      await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "library", {
        connection: "async",
        mode: "autonomous",
        activity: "idle",
      });
    }
    const body = `replayed lamps ${tag()}`;
    await clearActorLimiters(redis, speaker.id);
    await grove.speech.say({ kind: "agent", agent: speaker }, { channel: "room_say", body, idempotencyKey: `k-${tag()}` });
    const said = await lastEventId("speech", speaker.id);

    const secret = `only for you ${tag()}`;
    await clearActorLimiters(redis, speakerOwner.id);
    await grove.speech.say(
      { kind: "human", human: speakerOwner },
      { channel: "owner_instruction", targetId: speaker.id, body: secret, idempotencyKey: `k-${tag()}` },
    );
    const whispered = await lastEventId("speech", speakerOwner.id);

    const win = { ...windowAround(t0), worldId: WORLD_ID };
    const find = (pages: ReplayPage[], id: string) => pages.flatMap((p) => p.entries).find((e) => e.id === id) ?? null;

    const listenerPages = await allPages(asHuman(listenerOwner.id), win);
    expect(find(listenerPages, said)?.body).toBe(body);

    // realtime.roomFrameFor drops the frame for a non-recipient, so replay does
    // too: no body, and no row saying a line was said.
    const bystanderPages = await allPages(asHuman(bystander.id), win);
    expect(find(bystanderPages, said)).toBeNull();
    expect(JSON.stringify(bystanderPages)).not.toContain(body);

    expect(idsOf(await allPages(ANON, win))).not.toContain(said);

    const senderPages = await allPages(asHuman(speakerOwner.id), win);
    expect(idsOf(senderPages)).not.toContain(whispered);
    expect(JSON.stringify(senderPages)).not.toContain(secret);
  });

  it("replays tool-call spans to the owner only, and never out of a private space", async () => {
    const owner = await newHuman("replay-tools");
    const stranger = await newHuman("replay-tools-stranger");
    const operator = await newHuman("replay-tools-op");
    await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [operator.id]);
    const agent = await newAgent(owner, `tools${tag()}`);
    const t0 = Date.now();
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "workshop", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    await clearActorLimiters(redis, agent.id);
    const callId = `c${tag()}`;
    await grove.toolCalls.start(agent.id, { callId, name: "Bash", args: "pnpm test" });
    await grove.toolCalls.finish(agent.id, callId, { outcome: "ok", result: "green" });
    const win = { ...windowAround(t0), worldId: WORLD_ID };
    const spansFor = async (v: ChronicleViewer) =>
      (await grove.replay.window(v, win)).toolCalls.filter((s) => s.actorId === agent.id);

    const mine = await spansFor(asHuman(owner.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ callId, name: "Bash", outcome: "ok" });
    expect(await spansFor(asOperator(operator.id))).toHaveLength(1);
    expect(await spansFor(asHuman(stranger.id))).toHaveLength(0);
    expect(await spansFor(ANON)).toHaveLength(0);

    // In a private space, even an operator who is not a member reads nothing.
    const space = await grove.campus.createWorld(owner, { name: `T ${tag()}`, slug: `t-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${space.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: space.id,
    });
    const hidden = `h${tag()}`;
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.start(agent.id, { callId: hidden, name: "Edit" });
    const spaceWin = { ...windowAround(t0), worldId: space.id };
    const opSpans = (await grove.replay.window(asOperator(operator.id), spaceWin)).toolCalls;
    expect(opSpans.map((s) => s.callId)).not.toContain(hidden);
    const ownerSpans = (await grove.replay.window(asHuman(owner.id), spaceWin)).toolCalls;
    expect(ownerSpans.map((s) => s.callId)).toContain(hidden);
    // ...and it does not leak into the commons replay either.
    const commons = (await grove.replay.window(asOperator(operator.id), win)).toolCalls;
    expect(commons.map((s) => s.callId)).not.toContain(hidden);
  });

  it("records a departure, so the keyframe after it no longer holds the body", async () => {
    const owner = await newHuman("replay-leaver");
    const agent = await newAgent(owner, `leaver${tag()}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "garden", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    const afterJoin = new Date(Date.now() + 5).toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const during = await grove.replay.window(asHuman(owner.id), {
      since: afterJoin,
      until: new Date(Date.now() + 60_000).toISOString(),
      worldId: WORLD_ID,
    });
    expect(during.keyframe!.bodies.find((b) => b.actorId === agent.id)?.roomId).toBe("garden");

    await grove.presence.leave(agent.id);
    const left = await lastEventId("actor_left_room", agent.id);
    const { rows } = await pg.query("SELECT payload FROM world_events WHERE id = $1", [left]);
    expect((rows[0] as { payload: Record<string, unknown> }).payload).toMatchObject({ room: "garden", reason: "left" });

    // Anonymous readers see departures from the commons just as they see arrivals.
    const anonPages = await allPages(ANON, { since: afterJoin, until: new Date(Date.now() + 5_000).toISOString(), worldId: WORLD_ID });
    const leaving = anonPages.flatMap((p) => p.entries).find((e) => e.id === left);
    expect(leaving?.kind).toBe("movement");
    expect(leaving?.summary).toContain("left");

    await new Promise((r) => setTimeout(r, 20));
    const after = await grove.replay.window(ANON, {
      since: new Date().toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      worldId: WORLD_ID,
    });
    expect(after.keyframe!.bodies.map((b) => b.actorId)).not.toContain(agent.id);
  });

  it("walks forwards, pages without overlap, and answers the same window the same way twice", async () => {
    const owner = await newHuman("replay-order");
    const agent = await newAgent(owner, `order${tag()}`);
    const since = new Date(Date.now() - 1_000).toISOString();
    for (const room of ["plaza", "library", "workshop"]) {
      await clearActorLimiters(redis, agent.id);
      await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, room, {
        connection: "async",
        mode: "autonomous",
        activity: "idle",
      });
    }
    const until = new Date(Date.now() + 1_000).toISOString();
    const q = { since, until, worldId: WORLD_ID };
    const viewer = asHuman(owner.id);

    const small: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 500; i++) {
      const page = await grove.replay.window(viewer, { ...q, cursor, limit: 2 });
      small.push(...page.entries.map((e) => e.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const asNumbers = small.map((id) => BigInt(id));
    expect([...asNumbers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(asNumbers);
    expect(new Set(small).size).toBe(small.length);
    const mine = (await allPages(viewer, q)).flatMap((p) => p.entries).filter((e) => e.actor?.id === agent.id && e.type === "actor_joined_room");
    expect(mine.map((e) => e.roomId)).toEqual(["plaza", "library", "workshop"]);

    const once = await grove.replay.window(viewer, { ...q, limit: 1000 });
    const twice = await grove.replay.window(viewer, { ...q, limit: 1000 });
    const own = (p: ReplayPage) => p.entries.filter((e) => e.actor?.id === agent.id);
    expect(own(twice)).toEqual(own(once));
  });

  it("refuses a window longer than a day, or one that ends before it starts", async () => {
    const now = Date.now();
    await expect(
      grove.replay.window(ANON, {
        since: new Date(now - 25 * 3600_000).toISOString(),
        until: new Date(now).toISOString(),
        worldId: WORLD_ID,
      }),
    ).rejects.toThrow(/24 hours/);
    await expect(
      grove.replay.window(ANON, { since: new Date(now).toISOString(), until: new Date(now - 1).toISOString(), worldId: WORLD_ID }),
    ).rejects.toThrow(/after since/);
    expect(densityBucketSeconds(3600_000)).toBe(30);
    expect(densityBucketSeconds(24 * 3600_000)).toBe(900);
  });
});
