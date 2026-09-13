/**
 * Estates (#37) through the real minimap: one owner's or one org's adjacent
 * public plots come back as one estate with a shared name; a private plot never
 * joins, bridges or appears; names are owner- (or org-owner-) set and checked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { plotsAdjacent } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import { assertTestDatabase, createFixtures, hasTestDatabase } from "./support/fixtures.js";

const hasDb = hasTestDatabase();

/** Three plots in a straight run far out on the spiral, clear of anything allocated. */
function runOfThree(): [number, number, number] {
  let i = 60_000 + Math.floor(Math.random() * 20_000);
  while (!(plotsAdjacent(i, i + 1) && plotsAdjacent(i + 1, i + 2) && !plotsAdjacent(i, i + 2))) i += 1;
  return [i, i + 1, i + 2];
}

describe.skipIf(!hasDb)("estates", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the estates suite");
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

  async function spaceAt(owner: Awaited<ReturnType<typeof newHuman>>, plotIndex: number, preset: "public_write" | "private") {
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Estate Plot ${t}`, slug: `estate-${t}`, preset });
    fixtures.trackWorld(space.id);
    await pg.query(`UPDATE worlds SET plot_index = $2 WHERE id = $1`, [space.id, plotIndex]);
    return space;
  }

  async function code(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GroveError);
    return (err as GroveError).code;
  }

  it("joins an owner's adjacent public plots, never through or with a private one", async () => {
    const owner = await newHuman("estate-owner");
    const [a, b, c] = runOfThree();
    const first = await spaceAt(owner, a, "public_write");
    const middle = await spaceAt(owner, b, "private");
    await spaceAt(owner, c, "public_write");

    const mine = (m: Awaited<ReturnType<GroveApp["world"]["minimap"]>>) =>
      m.estates.filter((e) => e.plotIndices.some((i) => i === a || i === b || i === c));
    // The private middle plot neither joins nor bridges a and c.
    expect(mine(await grove.world.minimap())).toEqual([]);

    await grove.campus.updateWorld(owner, middle.id, { policyPreset: "public_write" });
    const joined = mine(await grove.world.minimap());
    expect(joined).toEqual([
      { id: `estate-owner-${a}`, kind: "owner", name: `@${owner.handle}`, accent: null, plotIndices: [a, b, c] },
    ]);
    expect(JSON.stringify(joined)).not.toContain(owner.id);

    await grove.estates.setName(owner, { name: "  North  Field " });
    expect(mine(await grove.world.minimap())[0]!.name).toBe("North Field");

    // Back to private: a two-plot run with a private partner is not an estate.
    await grove.campus.updateWorld(owner, first.id, { policyPreset: "private" });
    await grove.campus.updateWorld(owner, middle.id, { policyPreset: "private" });
    expect(mine(await grove.world.minimap())).toEqual([]);
  });

  it("names an org estate after the org; only the org's owner may rename it", async () => {
    const owner = await newHuman("estate-org");
    const stranger = await newHuman("estate-nosy");
    const t = tag();
    const org = await grove.campus.createOrg(owner, { name: `Keepers ${t}`, colour: "#a5b4fc" });
    const [a, b] = runOfThree();
    for (const i of [a, b]) {
      const s = await spaceAt(owner, i, "public_write");
      await grove.campus.bindOrg(owner, s.id, org.id);
    }
    const find = async () => (await grove.world.minimap()).estates.find((e) => e.plotIndices.includes(a));
    expect(await find()).toEqual({ id: `estate-org-${a}`, kind: "org", name: `Keepers ${t}`, accent: "#a5b4fc", plotIndices: [a, b] });

    expect(await code(grove.estates.setName(stranger, { orgId: org.id, name: "Mine now" }))).toBe("NOT_FOUND");
    expect(await code(grove.estates.setName(owner, { orgId: org.id, name: "x".repeat(25) }))).toBe("INVALID");
    const names = await grove.estates.setName(owner, { orgId: org.id, name: "The Keep" });
    expect(names.orgs.find((o) => o.id === org.id)?.estateName).toBe("The Keep");
    expect((await find())?.name).toBe("The Keep");
    await grove.estates.setName(owner, { orgId: org.id, name: "" });
    expect((await find())?.name).toBe(`Keepers ${t}`);
  });
});
