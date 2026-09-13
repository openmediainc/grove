/**
 * Resting at plot. The properties that matter:
 *  - a claimed agent with no presence whose home room is on a public plot is
 *    listed in the minimap's `resting`, and never in `bodies` (so nothing that
 *    counts or watches live bodies ever sees it);
 *  - the moment it has presence it is a live body and no longer resting;
 *  - a private plot, or a private-door room on a public plot, never reveals who
 *    rests there: absent, not redacted;
 *  - pending agents and agents of suspended owners do not rest on the map;
 *  - the payload carries nothing to draw work from.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.resting;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("agents resting at their home plot", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the resting suite");
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

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string, homeRoomId: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    return grove.identity.patchAgent(agent.id, owner, { homeRoomId });
  }

  const restingIds = async () => (await grove.world.minimap()).resting.map((r) => r.id);

  it("rests an offline agent at its public home plot, and wakes it into bodies on presence", async () => {
    const owner = await newHuman("rest-owner");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Dozing Yard ${t}`, slug: `dozeyard-${t}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    const agent = await newAgent(owner, `dozebot${t}`, `${space.id}:plaza`);

    const map = await grove.world.minimap();
    const row = map.resting.find((r) => r.id === agent.id);
    expect(row).toEqual({ id: agent.id, slug: agent.slug, displayName: agent.displayName, plotIndex: space.plotIndex });
    // Nothing to draw work from, and not a live body.
    expect(Object.keys(row!).sort()).toEqual(["displayName", "id", "plotIndex", "slug"]);
    expect(map.bodies.some((b) => b.id === agent.id)).toBe(false);

    // Search's Online now reads the live map only.
    const found = await grove.search.search(null, `dozebot${t}`);
    expect(found.agents[0]).toMatchObject({ online: false });
    expect(found.online.some((b) => b.slug === agent.slug)).toBe(false);

    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "plaza", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    expect(await restingIds()).not.toContain(agent.id);

    await grove.presence.leave(agent.id);
    expect(await restingIds()).toContain(agent.id);
  });

  it("never reveals who rests on a private plot or behind a private room door", async () => {
    const owner = await newHuman("rest-private");
    const t = tag();
    const closed = await grove.campus.createWorld(owner, { name: `Shut Vault ${t}`, slug: `shutvault-${t}`, preset: "private" });
    fixtures.trackWorld(closed.id);
    const open = await grove.campus.createWorld(owner, { name: `Open Yard ${t}`, slug: `openyard-${t}`, preset: "public_write" });
    fixtures.trackWorld(open.id);
    await grove.campus.updateRoomAccess(owner, open.id, "library", { roomPreset: "private" });

    const hidden = await newAgent(owner, `vaultnap${t}`, `${closed.id}:plaza`);
    const behindDoor = await newAgent(owner, `doornap${t}`, `${open.id}:library`);
    const civic = await newAgent(owner, `civicnap${t}`, "plaza");

    const map = await grove.world.minimap();
    const ids = map.resting.map((r) => r.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(behindDoor.id);
    // A commons home is not a plot: it rests nowhere.
    expect(ids).not.toContain(civic.id);
    expect(map.resting.some((r) => r.plotIndex === closed.plotIndex)).toBe(false);
    expect(JSON.stringify(map.resting)).not.toContain(`vaultnap${t}`);
  });

  it("leaves out pending agents and agents of a suspended owner", async () => {
    const owner = await newHuman("rest-susp");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Quiet Lot ${t}`, slug: `quietlot-${t}`, preset: "public_write" });
    fixtures.trackWorld(space.id);
    const agent = await newAgent(owner, `suspnap${t}`, `${space.id}:plaza`);
    expect(await restingIds()).toContain(agent.id);
    await pg.query(`UPDATE humans SET suspended_at = now() WHERE id = $1`, [owner.id]);
    expect(await restingIds()).not.toContain(agent.id);
    await pg.query(`UPDATE humans SET suspended_at = NULL WHERE id = $1`, [owner.id]);
    await pg.query(`UPDATE agents SET claim_state = 'pending' WHERE id = $1`, [agent.id]);
    expect(await restingIds()).not.toContain(agent.id);
  });
});
