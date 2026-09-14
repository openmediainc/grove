/**
 * Discovery on Explore (queue #40): the shelves are ordered by activity with
 * ties to the most recent, never include a private space or activity behind a
 * closed door, and are served from a one-minute kv cache.
 *
 * Other suites write to the same tables in parallel, so DB assertions look only
 * at this file's own rows and read with a large cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  DISCOVERY_CACHE_KEY,
  DISCOVERY_SHELF_MAX,
  GroveApp,
  orderArrivals,
  orderShelf,
  plotCentre,
  plotScore,
  type ArrivalItem,
} from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { assertTestDatabase, clearRegisterLimiter, createFixtures, hasTestDatabase, REGISTER_IPS } from "./support/fixtures.js";

describe("discovery ordering (pure)", () => {
  const row = (id: string, speakers: number, spans: number, visitors: number, last: string | null) => ({ id, speakers, spans, visitors, last });

  it("orders by the metric, breaks ties by recency then id, drops zero and caps", () => {
    const rows = [
      row("a", 3, 0, 0, "2026-09-13T10:00:00Z"),
      row("b", 1, 0, 2, "2026-09-13T11:00:00Z"),
      row("c", 0, 5, 0, "2026-09-13T09:00:00Z"),
      row("d", 0, 0, 0, "2026-09-13T12:00:00Z"),
      row("e", 1, 1, 1, "2026-09-13T11:00:00Z"),
    ];
    const ordered = orderShelf(rows, plotScore, (r) => r.last).map((r) => r.id);
    expect(ordered).toEqual(["c", "b", "e", "a"]);
    expect(orderShelf(rows, plotScore, (r) => r.last, 2).map((r) => r.id)).toEqual(["c", "b"]);
    expect(orderShelf([], plotScore, () => null)).toEqual([]);
    // A missing timestamp loses the tie.
    expect(orderShelf([row("x", 1, 0, 0, null), row("y", 1, 0, 0, "2026-01-01T00:00:00Z")], plotScore, (r) => r.last).map((r) => r.id)).toEqual(["y", "x"]);
  });

  it("puts the newest arrival first and caps at the shelf max", () => {
    const items = Array.from({ length: DISCOVERY_SHELF_MAX + 5 }, (_, i) => ({
      kind: "agent",
      id: `ag${String(i).padStart(2, "0")}`,
      arrivedAt: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
    })) as unknown as ArrivalItem[];
    const out = orderArrivals(items);
    expect(out).toHaveLength(DISCOVERY_SHELF_MAX);
    expect(out[0]!.id).toBe(`ag${DISCOVERY_SHELF_MAX + 4}`);
  });

  it("centres a jump on the plot, and has none without one", () => {
    const c = plotCentre(0);
    expect(c).not.toBeNull();
    expect(Number.isInteger(c!.tx) && Number.isInteger(c!.ty)).toBe(true);
    expect(plotCentre(null)).toBeNull();
    expect(plotCentre(-1)).toBeNull();
  });
});

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("discovery shelves", { timeout: 60_000 }, () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);
  const BIG = 100_000;
  let seq = 0;

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the discovery suite");
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

  async function newSpace(owner: Awaited<ReturnType<typeof newHuman>>, preset: "public_write" | "public_view" | "private") {
    const w = await grove.campus.createWorld(owner, { name: `Disc ${tag()}`, slug: `disc-${tag()}`, preset });
    fixtures.trackWorld(w.id);
    return w;
  }

  async function newAgent(owner: { id: string } | null, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IPS.discovery);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IPS.discovery);
    fixtures.trackAgent(reg.agent.id);
    if (!owner) return reg.agent;
    return grove.identity.claimAgent(reg.agent.id, owner as never);
  }

  async function say(senderId: string, kind: "human" | "agent", roomId: string, agoSeconds: number) {
    const id = `sp_disc_${tag()}${seq++}`;
    await pg.query(
      `INSERT INTO speech (id, channel, sender_id, sender_kind, room_id, body, grapheme_count, created_at)
       VALUES ($1, 'room_say', $2, $3, $4, 'hello', 5, now() - ($5 * interval '1 second'))`,
      [id, senderId, kind, roomId, agoSeconds],
    );
    return id;
  }

  async function visit(actorId: string, roomId: string, agoSeconds: number) {
    await pg.query(
      `INSERT INTO world_events (type, actor_id, payload, created_at)
       VALUES ('actor_joined_room', $1, $2, now() - ($3 * interval '1 second'))`,
      [actorId, JSON.stringify({ room: roomId, seat: 0 }), agoSeconds],
    );
  }

  async function follow(followerId: string, agentId: string, agoSeconds: number) {
    await pg.query(
      `INSERT INTO follows (follower_id, follower_kind, subject_kind, subject_id, created_at)
       VALUES ($1, 'human', 'agent', $2, now() - ($3 * interval '1 second'))`,
      [followerId, agentId, agoSeconds],
    );
  }

  async function react(actorId: string, speechId: string, agoSeconds: number) {
    await pg.query(
      `INSERT INTO reactions (target_kind, target_id, actor_id, actor_kind, emoji, created_at)
       VALUES ('speech', $1, $2, 'human', 'heart', now() - ($3 * interval '1 second'))`,
      [speechId, actorId, agoSeconds],
    );
  }

  it("ranks public plots by 24h activity with ties to the most recent, and never shows a private space", async () => {
    const owner = await newHuman("disc-owner");
    const talkers = await Promise.all([newHuman("disc-t1"), newHuman("disc-t2"), newHuman("disc-t3")]);
    const open = await newSpace(owner, "public_write");
    const watch = await newSpace(owner, "public_view");
    const shut = await newSpace(owner, "private");
    const half = await newSpace(owner, "public_write");
    await grove.campus.updateRoomAccess(owner, half.id, `${half.id}:library`, { roomPreset: "private" });
    const stale = await newSpace(owner, "public_write");

    // open: 3 distinct speakers (one twice), two hours ago.
    for (const t of talkers) await say(t.id, "human", `${open.id}:plaza`, 7200);
    await say(talkers[0]!.id, "human", `${open.id}:plaza`, 7100);
    // watch: 1 speaker + 2 visitors = 3 too, but a minute ago: wins the tie.
    await say(talkers[0]!.id, "human", `${watch.id}:plaza`, 600);
    await visit(talkers[1]!.id, `${watch.id}:plaza`, 60);
    await visit(talkers[2]!.id, `${watch.id}:library`, 90);
    // shut: far busier, behind a private door.
    for (const t of talkers) await say(t.id, "human", `${shut.id}:plaza`, 30);
    for (const t of talkers) await visit(t.id, `${shut.id}:plaza`, 30);
    // half: everything in its private library, nothing public.
    for (const t of talkers) await say(t.id, "human", `${half.id}:library`, 30);
    // stale: two days ago.
    await say(talkers[0]!.id, "human", `${stale.id}:plaza`, 2 * 86_400);

    const plots = await grove.discovery.busiestPlots(BIG);
    const ids = plots.map((p) => p.id);
    expect(ids).toContain(open.id);
    expect(ids).toContain(watch.id);
    expect(ids).not.toContain(shut.id);
    expect(ids).not.toContain(half.id);
    expect(ids).not.toContain(stale.id);
    expect(JSON.stringify(plots)).not.toContain(shut.slug);

    const mine = plots.filter((p) => p.id === open.id || p.id === watch.id);
    expect(mine.map((p) => p.id)).toEqual([watch.id, open.id]);
    expect(mine[0]).toMatchObject({ speakers: 1, visitors: 2, spans: 0, policyPreset: "public_view", slug: watch.slug });
    expect(mine[1]).toMatchObject({ speakers: 3, visitors: 0, spans: 0 });
    expect(mine[1]!.at).toEqual(plotCentre(mine[1]!.plotIndex));
    expect(JSON.stringify(plots)).not.toMatch(/cost|micros|rank/i);
  });

  it("ranks public agents by a week of follows and reactions in public rooms only", async () => {
    const owner = await newHuman("disc-aowner");
    const fans = await Promise.all([newHuman("disc-f1"), newHuman("disc-f2"), newHuman("disc-f3")]);
    const shut = await newSpace(owner, "private");
    const x = await newAgent(owner, `discx${tag()}`);
    const y = await newAgent(owner, `discy${tag()}`);
    const z = await newAgent(owner, `discz${tag()}`);
    const pending = await newAgent(null, `discp${tag()}`);
    const old = await newAgent(owner, `disco${tag()}`);

    // x: 2 follows, an hour ago. y: 1 follow + 1 reaction on a public line, a minute ago (tie, more recent).
    await follow(fans[0]!.id, x.id, 3600);
    await follow(fans[1]!.id, x.id, 3500);
    await follow(fans[0]!.id, y.id, 3000);
    await react(fans[1]!.id, await say(y.id, "agent", "plaza", 100), 60);
    // z: loved inside a private space only.
    const hidden = await say(z.id, "agent", `${shut.id}:plaza`, 100);
    for (const f of fans) await react(f.id, hidden, 30);
    // pending: followed, but not public.
    await follow(fans[2]!.id, pending.id, 30);
    // old: followed eight days ago.
    await follow(fans[2]!.id, old.id, 8 * 86_400);

    const agents = await grove.discovery.mostWatchedAgents(BIG);
    const ids = agents.map((a) => a.id);
    expect(ids).not.toContain(z.id);
    expect(ids).not.toContain(pending.id);
    expect(ids).not.toContain(old.id);
    const mine = agents.filter((a) => a.id === x.id || a.id === y.id);
    expect(mine.map((a) => a.id)).toEqual([y.id, x.id]);
    expect(mine[0]).toMatchObject({ followsWeek: 1, reactionsWeek: 1, followers: 1 });
    expect(mine[1]).toMatchObject({ followsWeek: 2, reactionsWeek: 0, followers: 2 });
  });

  it("lists new public spaces and newly claimed agents, newest first, never a private space", async () => {
    const owner = await newHuman("disc-new");
    const a = await newSpace(owner, "public_write");
    const shut = await newSpace(owner, "private");
    const agent = await newAgent(owner, `discn${tag()}`);
    const b = await newSpace(owner, "public_view");
    const pending = await newAgent(null, `discq${tag()}`);
    await pg.query(`UPDATE worlds SET created_at = now() - interval '8 days' WHERE id = $1`, [a.id]);
    await pg.query(`UPDATE agents SET claimed_at = now() - interval '1 minute' WHERE id = $1`, [agent.id]);
    await pg.query(`UPDATE worlds SET created_at = now() - interval '10 seconds' WHERE id = $1`, [b.id]);

    const items = await grove.discovery.justArrived(BIG);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(shut.id);
    expect(ids).not.toContain(pending.id);
    const mine = items.filter((i) => i.id === b.id || i.id === agent.id);
    expect(mine.map((i) => i.kind)).toEqual(["space", "agent"]);
  });

  it("serves the shelves from a one-minute cache", async () => {
    await redis.del(DISCOVERY_CACHE_KEY);
    const first = await grove.discovery.discovery();
    expect(first.ttlSeconds).toBe(60);
    const ttl = await redis.ttl(DISCOVERY_CACHE_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    const second = await grove.discovery.discovery();
    expect(second.generatedAt).toBe(first.generatedAt);
    const fresh = await grove.discovery.discovery({ fresh: true });
    expect(fresh.generatedAt >= first.generatedAt).toBe(true);
    for (const shelf of [first.busiestPlots, first.mostWatchedAgents, first.justArrived]) {
      expect(shelf.length).toBeLessThanOrEqual(DISCOVERY_SHELF_MAX);
    }
    await redis.del(DISCOVERY_CACHE_KEY);
  });
});
