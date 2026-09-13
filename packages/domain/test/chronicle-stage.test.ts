import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { CHRONICLE_TYPES, type ChronicleQuery, type ChronicleViewer } from "../src/services/chronicle.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();

/**
 * `stage.started` / `stage.ended` in the chronicle.
 *
 * They were falling through the fail-closed ELSE arm, which made every Stage
 * transition in Grove operators-only — correct as a default, wrong for these.
 * They now take `actor_joined_room`'s rule exactly: the WORLD GATE and nothing
 * else, because GET /api/v1/civic and GET /api/v1/civic/stage already hand the
 * same title and window to a signed-out visitor for every world the same gate
 * lets them reach.
 *
 * As in chronicle.test.ts: the ledger is a table every suite writes to and
 * vitest runs files in parallel, so nothing here asserts on counts or on "the
 * first entry". Every assertion pins the exact world_events row an action
 * produced and asks whether that id reached a given viewer.
 */
describe.skipIf(!hasDb)("a Stage transition is as civic as its Stage", () => {
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
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newOperator(prefix: string) {
    const human = await newHuman(prefix);
    await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [human.id]);
    return human;
  }

  async function makeSpace(preset: "private" | "public_view" | "public_write") {
    const owner = await newHuman("impresario");
    const space = await grove.campus.createWorld(owner, {
      name: `Stage ${tag()}`,
      slug: `stage-${tag()}`,
      preset,
    });
    fixtures.trackWorld(space.id);
    return { owner, space };
  }

  /** The ledger row a transition just wrote, by the event it names. */
  async function stageEventId(type: "stage.started" | "stage.ended", eventId: string): Promise<string> {
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = $1 AND payload->>'eventId' = $2 ORDER BY id DESC LIMIT 1`,
      [type, eventId],
    );
    const row = rows[0] as { id: string } | undefined;
    if (!row) throw new Error(`no ${type} ledger row for ${eventId}`);
    return String(row.id);
  }

  async function idsFor(viewer: ChronicleViewer, query: ChronicleQuery = {}): Promise<Set<string>> {
    const out = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 40; page++) {
      const p = await grove.chronicle.read(viewer, { ...query, limit: 200, cursor });
      for (const e of p.entries) out.add(e.id);
      if (!p.nextCursor) return out;
      cursor = p.nextCursor;
    }
    throw new Error("chronicle pagination did not terminate");
  }

  async function entryFor(viewer: ChronicleViewer, id: string) {
    for (let cursor: string | null = null, page = 0; page < 40; page++) {
      const p: Awaited<ReturnType<typeof grove.chronicle.read>> = await grove.chronicle.read(viewer, {
        limit: 200,
        cursor,
      });
      const hit = p.entries.find((e) => e.id === id);
      if (hit) return hit;
      if (!p.nextCursor) return null;
      cursor = p.nextCursor;
    }
    return null;
  }

  /** An event whose window has already opened and closed, then read once to announce both edges. */
  async function runAndEnd(owner: { id: string }, spaceId: string, title: string) {
    const event = await grove.campus.createEvent(owner as never, {
      worldId: spaceId,
      title,
      startsAt: new Date(Date.now() - 120_000).toISOString(),
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // stageNow() is what crosses the edges; nothing announces on a timer.
    await grove.campus.stageNow(spaceId);
    return event;
  }

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the chronicle stage suite");
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

  it("shows a public space's Stage to a stranger and to a signed-out visitor", async () => {
    const { owner, space } = await makeSpace("public_write");
    const event = await runAndEnd(owner, space.id, `Open mic ${tag()}`);
    const started = await stageEventId("stage.started", event.id);
    const ended = await stageEventId("stage.ended", event.id);

    const stranger = await newHuman("stranger");
    for (const viewer of [asHuman(owner.id), asHuman(stranger.id), ANON]) {
      const ids = await idsFor(viewer);
      expect(ids).toContain(started);
      expect(ids).toContain(ended);
    }
  });

  it("hides a private space's Stage from everyone outside it, operators included", async () => {
    const { owner, space } = await makeSpace("private");
    const event = await runAndEnd(owner, space.id, `Closed rehearsal ${tag()}`);
    const started = await stageEventId("stage.started", event.id);

    const outsider = await newHuman("outsider");
    const operator = await newOperator("stage-op");

    expect(await idsFor(asHuman(owner.id))).toContain(started);
    expect(await idsFor(asHuman(outsider.id))).not.toContain(started);
    expect(await idsFor(ANON)).not.toContain(started);
    // No operator bypass on the world gate — rule 1 gives them none either, and
    // the chronicle must not be the back door into a plot the front door
    // refuses. An operator who JOINS the space sees it, like anyone else.
    expect(await idsFor(asOperator(operator.id))).not.toContain(started);
  });

  it("reads as an event, not as an act by whoever booked it", async () => {
    const { owner, space } = await makeSpace("public_write");
    const title = `Late set ${tag()}`;
    const event = await runAndEnd(owner, space.id, title);

    const started = await entryFor(ANON, await stageEventId("stage.started", event.id));
    const ended = await entryFor(ANON, await stageEventId("stage.ended", event.id));

    expect(started?.summary).toBe(`“${title}” began in Stage.`);
    expect(ended?.summary).toBe(`“${title}” finished in Stage.`);
    // Resolved to the space's Stage by the roomId in the payload, which is the
    // only reason these rows are world-gated at all rather than worldless.
    expect(started?.roomId).toBe(`${space.id}:stage`);
    expect(started?.worldId).toBe(space.id);
  });

  it("buckets as movement, filters as movement, and publishes only the window", async () => {
    const { owner, space } = await makeSpace("public_write");
    const title = `Filterable ${tag()}`;
    const event = await runAndEnd(owner, space.id, title);
    const started = await stageEventId("stage.started", event.id);

    const entry = await entryFor(ANON, started);
    expect(entry?.kind).toBe("movement");
    expect(entry?.moderation).toBe(false);
    // The allow-list: the title and the window, and nothing else the payload
    // happens to carry.
    expect(Object.keys(entry?.detail ?? {}).sort()).toEqual(["endsAt", "startsAt", "title"]);
    expect(entry?.detail.title).toBe(title);

    // A `kinds` filter is sugar over `types`; the type has to be in the
    // vocabulary or "movement" would silently narrow past it.
    expect(CHRONICLE_TYPES).toContain("stage.started");
    expect(CHRONICLE_TYPES).toContain("stage.ended");
    expect(await idsFor(ANON, { kinds: ["movement"] })).toContain(started);
    expect(await idsFor(ANON, { kinds: ["other"] })).not.toContain(started);
  });
});
