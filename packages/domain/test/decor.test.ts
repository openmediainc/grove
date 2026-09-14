/**
 * Plot decor (#45) through the real service and minimap: owner-only reads and
 * writes (anyone else 404), writes checked against the plot's unlocks and slot
 * geometry, marks unlock more, and a private plot publishes none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("plot decor", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the decor suite");
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

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function code(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GroveError);
    return (err as GroveError).code;
  }

  it("places unlocked decor on a plot, refuses strangers, locked presets and bad slots, redacts private plots", async () => {
    const owner = await newHuman("decor-owner");
    const stranger = await newHuman("decor-nosy");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Decor Plot ${t}`, slug: `decor-${t}`, preset: "public_write" });
    fixtures.trackWorld(space.id);
    const plotIndex = 90_000 + Math.floor(Math.random() * 20_000);
    await pg.query(`UPDATE worlds SET plot_index = $2 WHERE id = $1`, [space.id, plotIndex]);

    const view = await grove.decor.get(owner, space.id);
    expect(view.items).toEqual([]);
    expect(view.catalogue.filter((e) => e.unlocked).map((e) => e.preset)).toEqual(["bench", "planter", "lamps"]);
    expect(view.catalogue.find((e) => e.preset === "desk")).toMatchObject({ unlocked: false, hint: "earned by 1,000 tool calls" });
    // Supporters are off in tests: supporter presets are not listed at all.
    expect(view.catalogue.some((e) => e.unlock === "supporter")).toBe(false);

    expect(await code(grove.decor.get(stranger, space.id))).toBe("NOT_FOUND");
    expect(await code(grove.decor.set(stranger, space.id, [{ preset: "bench", slot: 0 }]))).toBe("NOT_FOUND");
    expect(await code(grove.decor.set(owner, space.id, [{ preset: "desk", slot: 0 }]))).toBe("INVALID");
    expect(await code(grove.decor.set(owner, space.id, [{ preset: "bench", slot: 42 }]))).toBe("INVALID");

    // A mark unlocks two more.
    await pg.query(`INSERT INTO space_marks (world_id, mark) VALUES ($1, 'thousand_calls') ON CONFLICT DO NOTHING`, [space.id]);
    const saved = await grove.decor.set(owner, space.id, [
      { preset: "desk", slot: 3 },
      { preset: "bench", slot: 0 },
    ]);
    expect(saved.items).toEqual([
      { preset: "bench", slot: 0 },
      { preset: "desk", slot: 3 },
    ]);

    const plot = async () => (await grove.world.minimap()).spaces.find((s) => s.id === space.id)!;
    expect((await plot()).decor).toEqual(saved.items);

    // Private: held land shows nothing, but the owner's placement is kept.
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "private" });
    expect((await plot()).decor).toEqual([]);
    const held = await grove.decor.get(owner, space.id);
    expect(held.hiddenWhilePrivate).toBe(true);
    expect(held.items).toHaveLength(2);

    await grove.campus.updateWorld(owner, space.id, { policyPreset: "public_view" });
    expect((await plot()).decor).toHaveLength(2);
    // Clearing stores NULL.
    await grove.decor.set(owner, space.id, []);
    const { rows } = await pg.query(`SELECT decor FROM worlds WHERE id = $1`, [space.id]);
    expect(rows[0].decor).toBeNull();
  });
});
