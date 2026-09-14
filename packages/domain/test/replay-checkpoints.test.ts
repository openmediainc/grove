import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { ReplayTimeline } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import type { ChronicleViewer } from "../src/services/chronicle.js";
import type { ReplayPage } from "../src/services/replay.js";
import {
  REPLAY_CHECKPOINT_BUCKET_MS,
  REPLAY_CHECKPOINT_GRACE_MS,
  REPLAY_CHECKPOINT_RETENTION_MS,
  type ReplaySeekPage,
} from "../src/services/replay-checkpoints.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.replayCheckpoints;
const hasDb = hasTestDatabase();

/**
 * Replay checkpoints (queue #63). Each test works inside its own open space (a
 * world of its own), so the ledger rows other suites write in parallel never
 * reach a checkpoint these assertions read.
 */
describe.skipIf(!hasDb)("replay checkpoints", { timeout: 60_000 }, () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);
  const ANON: ChronicleViewer = { humanId: null, isOperator: false };
  const asHuman = (id: string): ChronicleViewer => ({ humanId: id, isOperator: false });
  const tick = () => new Promise((r) => setTimeout(r, 15));

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

  async function enter(agent: { id: string }, owner: { id: string }, spaceId: string, room: string) {
    await clearActorLimiters(redis, agent.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${spaceId}:${room}`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: spaceId,
    });
    await tick();
  }

  /** A checkpoint "now": strictly after every row written so far. */
  async function checkpointNow(worldId: string): Promise<number> {
    await tick();
    const at = Date.now();
    await tick();
    await grove.replayCheckpoints.computeAt(worldId, at);
    return at;
  }

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

  /** id -> room at `t`, by playing the window through from its start. */
  async function playedThrough(viewer: ChronicleViewer, worldId: string, since: number, t: number) {
    const pages = await allPages(viewer, {
      since: new Date(since).toISOString(),
      until: new Date(t + 1).toISOString(),
      worldId,
    });
    const timeline = ReplayTimeline.build({
      since: new Date(since).toISOString(),
      until: new Date(t + 1).toISOString(),
      keyframe: pages[0]!.keyframe!.bodies,
      entries: pages.flatMap((p) => [...p.entries, ...p.trailing]),
    });
    return roomsOf(timeline, t);
  }

  function fromSeek(page: ReplaySeekPage, t: number) {
    const timeline = ReplayTimeline.build({
      since: page.window.since,
      until: page.window.until,
      keyframe: page.keyframe.bodies,
      entries: [...page.entries, ...page.trailing],
    });
    return roomsOf(timeline, t);
  }

  function roomsOf(timeline: ReplayTimeline, t: number): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [id, b] of timeline.stateAt(t).bodies) out[id] = b.roomId;
    return out;
  }

  async function rows(worldId: string) {
    const { rows } = await pg.query(`SELECT at, bodies, gone FROM replay_checkpoints WHERE world_id = $1 ORDER BY at`, [worldId]);
    return rows as Array<{ at: string; bodies: unknown; gone: unknown }>;
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the replay checkpoint suite");
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

  it("seeks to the same state as playing the window through, and computes each checkpoint once", async () => {
    const owner = await newHuman("cp-det-owner");
    const space = await grove.campus.createWorld(owner, { name: `Det ${tag()}`, slug: `det-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    const a = await newAgent(owner, `cpa${tag()}`);
    const b = await newAgent(owner, `cpb${tag()}`);
    const t0 = Date.now() - 1_000;

    await enter(a, owner, space.id, "plaza");
    await enter(b, owner, space.id, "library");
    const cp1 = await checkpointNow(space.id);
    await enter(a, owner, space.id, "library");
    await grove.presence.leave(b.id);
    await tick();
    const cp2 = await checkpointNow(space.id);
    await enter(b, owner, space.id, "plaza");
    await tick();
    const target = Date.now();

    // Idempotent: a second compute writes nothing and the row is unchanged.
    const before = await rows(space.id);
    expect(before.map((r) => new Date(r.at).getTime())).toEqual([cp1, cp2]);
    expect((await grove.replayCheckpoints.computeAt(space.id, cp2)).created).toBe(false);
    expect(await rows(space.id)).toEqual(before);
    // A chained checkpoint equals one bootstrapped from the keyframe.
    const chained = before[1]!.bodies;
    await pg.query(`DELETE FROM replay_checkpoints WHERE world_id = $1`, [space.id]);
    await grove.replayCheckpoints.computeAt(space.id, cp2);
    expect((await rows(space.id))[0]!.bodies).toEqual(chained);
    await grove.replayCheckpoints.computeAt(space.id, cp1);

    for (const viewer of [ANON, asHuman(owner.id)]) {
      const page = await grove.replayCheckpoints.seek(viewer, { at: new Date(target).toISOString(), worldId: space.id });
      expect(page.checkpoint?.at).toBe(new Date(cp2).toISOString());
      const seeked = fromSeek(page, target);
      expect(seeked).toEqual({ [a.id]: `${space.id}:library`, [b.id]: `${space.id}:plaza` });
      expect(seeked).toEqual(await playedThrough(viewer, space.id, t0, target));

      // Between the checkpoints too, from cp1.
      const mid = cp2 - 1;
      const midPage = await grove.replayCheckpoints.seek(viewer, { at: new Date(mid).toISOString(), worldId: space.id });
      expect(midPage.checkpoint?.at).toBe(new Date(cp1).toISOString());
      expect(fromSeek(midPage, mid)).toEqual(await playedThrough(viewer, space.id, t0, mid));
    }

    // With no checkpoint near enough it falls back to the keyframe, same answer.
    await pg.query(`DELETE FROM replay_checkpoints WHERE world_id = $1`, [space.id]);
    const fallback = await grove.replayCheckpoints.seek(ANON, { at: new Date(target).toISOString(), worldId: space.id });
    expect(fallback.checkpoint).toBeNull();
    expect(fromSeek(fallback, target)).toEqual(await playedThrough(ANON, space.id, t0, target));
  });

  it("keeps private rooms and private spaces out of every checkpoint, and layers a member's view on top", async () => {
    const owner = await newHuman("cp-vis-owner");
    const stranger = await newHuman("cp-vis-stranger");
    const space = await grove.campus.createWorld(owner, { name: `Vis ${tag()}`, slug: `vis-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    await grove.campus.updateRoomAccess(owner, space.id, `${space.id}:library`, { roomPreset: "private" });
    const hidden = await createPrivateSpace(owner);

    const pub = await newAgent(owner, `cppub${tag()}`);
    const secret = await newAgent(owner, `cpsec${tag()}`);
    const mover = await newAgent(owner, `cpmov${tag()}`);
    const resident = await newAgent(owner, `cpres${tag()}`);
    const t0 = Date.now() - 1_000;

    await enter(pub, owner, space.id, "plaza");
    await enter(secret, owner, space.id, "library");
    await enter(mover, owner, space.id, "plaza");
    await enter(mover, owner, space.id, "library");
    await enter(resident, owner, hidden, "plaza");
    const cp = await checkpointNow(space.id);
    const cpHidden = await checkpointNow(hidden);

    // Nothing private is in a stored row: not the closed room, not the body in it.
    const [row] = await rows(space.id);
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(secret.id);
    expect(raw).not.toContain(`${space.id}:library`);
    expect(raw).toContain(pub.id);
    const [hiddenRow] = await rows(hidden);
    expect(new Date(hiddenRow!.at).getTime()).toBe(cpHidden);
    expect(hiddenRow!.bodies).toEqual([]);
    expect(JSON.stringify(hiddenRow)).not.toContain(resident.id);

    const target = cp + 1;
    const at = new Date(target).toISOString();
    for (const viewer of [ANON, asHuman(stranger.id)]) {
      const page = await grove.replayCheckpoints.seek(viewer, { at, worldId: space.id });
      expect(page.checkpoint).not.toBeNull();
      expect(JSON.stringify(page)).not.toContain(secret.id);
      const seen = fromSeek(page, target);
      expect(seen).toEqual(await playedThrough(viewer, space.id, t0, target));
      expect(seen[pub.id]).toBe(`${space.id}:plaza`);
    }

    // The owner is inside the space: the closed room's bodies come back on top
    // of the public checkpoint, and the move into it outranks the public join.
    const ownerPage = await grove.replayCheckpoints.seek(asHuman(owner.id), { at, worldId: space.id });
    expect(ownerPage.checkpoint).not.toBeNull();
    const ownerView = fromSeek(ownerPage, target);
    expect(ownerView[secret.id]).toBe(`${space.id}:library`);
    expect(ownerView[mover.id]).toBe(`${space.id}:library`);
    expect(ownerView).toEqual(await playedThrough(asHuman(owner.id), space.id, t0, target));

    // A later PUBLIC movement outranks an older private one.
    await enter(mover, owner, space.id, "plaza");
    const cpLater = await checkpointNow(space.id);
    const later = await grove.replayCheckpoints.seek(asHuman(owner.id), { at: new Date(cpLater + 1).toISOString(), worldId: space.id });
    expect(later.checkpoint?.at).toBe(new Date(cpLater).toISOString());
    expect(fromSeek(later, cpLater + 1)[mover.id]).toBe(`${space.id}:plaza`);

    // A room closed after its checkpoint was written drops out of it at read time.
    await grove.campus.updateRoomAccess(owner, space.id, `${space.id}:plaza`, { roomPreset: "private" });
    const closed = await grove.replayCheckpoints.seek(ANON, { at: new Date(cpLater + 1).toISOString(), worldId: space.id });
    expect(closed.checkpoint).not.toBeNull();
    expect(JSON.stringify(closed.keyframe)).not.toContain(pub.id);
  });

  async function createPrivateSpace(owner: Awaited<ReturnType<typeof newHuman>>): Promise<string> {
    const s = await grove.campus.createWorld(owner, { name: `Held ${tag()}`, slug: `held-${tag()}`, preset: "private" });
    fixtures.trackWorld(s.id);
    return s.id;
  }

  it("advances through completed buckets only, resumably, and prunes past the replay window", async () => {
    const owner = await newHuman("cp-adv-owner");
    const space = await grove.campus.createWorld(owner, { name: `Adv ${tag()}`, slug: `adv-${tag()}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    const now = Date.now();
    const B = REPLAY_CHECKPOINT_BUCKET_MS;

    expect(await grove.replayCheckpoints.advance(space.id, now, 3)).toBe(3);
    const first = (await rows(space.id)).map((r) => new Date(r.at).getTime());
    expect(first).toHaveLength(3);
    expect(first[0]).toBe(Math.ceil((now - 24 * 3600_000) / B) * B);
    expect(first[1]! - first[0]!).toBe(B);
    // Resumes where it stopped.
    expect(await grove.replayCheckpoints.advance(space.id, now, 3)).toBe(3);
    const second = (await rows(space.id)).map((r) => new Date(r.at).getTime());
    expect(second.slice(0, 3)).toEqual(first);
    expect(second[3]! - second[2]!).toBe(B);

    // Catching all the way up never computes a bucket that has not ended (plus grace).
    await grove.replayCheckpoints.advance(space.id, now, 400);
    const all = (await rows(space.id)).map((r) => new Date(r.at).getTime());
    expect(Math.max(...all)).toBeLessThanOrEqual(now - REPLAY_CHECKPOINT_GRACE_MS);
    expect(Math.max(...all)).toBeGreaterThan(now - REPLAY_CHECKPOINT_GRACE_MS - B);
    expect(new Set(all).size).toBe(all.length);
    expect(await grove.replayCheckpoints.advance(space.id, now, 400)).toBe(0);

    // Prune: a row older than the replay window goes, the rest stay.
    const old = new Date(now - REPLAY_CHECKPOINT_RETENTION_MS - B).toISOString();
    await pg.query(`INSERT INTO replay_checkpoints (world_id, at) VALUES ($1, $2::timestamptz)`, [space.id, old]);
    const count = (await rows(space.id)).length;
    await grove.replayCheckpoints.prune(now);
    const left = await rows(space.id);
    expect(left).toHaveLength(count - 1);
    expect(left.map((r) => new Date(r.at).toISOString())).not.toContain(old);
  });

  it("validates the seek query", async () => {
    const now = Date.now();
    await expect(grove.replayCheckpoints.seek(ANON, { at: "nope", worldId: "aetheria-prime" })).rejects.toThrow(/ISO/);
    await expect(
      grove.replayCheckpoints.seek(ANON, { at: new Date(now).toISOString(), until: new Date(now - 1).toISOString(), worldId: "aetheria-prime" }),
    ).rejects.toThrow(/before at/);
    await expect(
      grove.replayCheckpoints.seek(ANON, {
        at: new Date(now - 3600_000).toISOString(),
        until: new Date(now - 3600_000 + 11 * 60_000).toISOString(),
        worldId: "aetheria-prime",
      }),
    ).rejects.toThrow(/10 minutes/);
  });
});
