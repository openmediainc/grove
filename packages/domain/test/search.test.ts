/**
 * `/` search. The properties that matter:
 *  - a private space, its rooms, and where its members stand are never results
 *    for anyone outside it (absent, not redacted); its members find them;
 *  - a public space's room with its own `private` door is not a result for a
 *    non-member;
 *  - "online now" and a body's location come only from the public commons map;
 *  - pending agents and suspended people are not results;
 *  - the query is matched literally (no LIKE wildcards).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { likePattern, normaliseSearchQuery, SEARCH_QUERY_MAX } from "../src/services/search.js";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.search;
const hasDb = hasTestDatabase();

describe("search query helpers", () => {
  it("normalises and caps the query", () => {
    expect(normaliseSearchQuery("  lan   tern ")).toBe("lan tern");
    expect(normaliseSearchQuery(undefined)).toBe("");
    expect(normaliseSearchQuery(["x"])).toBe("");
    expect(normaliseSearchQuery("x".repeat(200))).toHaveLength(SEARCH_QUERY_MAX);
  });
  it("escapes LIKE wildcards", () => {
    expect(likePattern("a%b_c\\")).toBe("%a\\%b\\_c\\\\%");
    expect(likePattern("lan", true)).toBe("lan%");
  });
});

describe.skipIf(!hasDb)("search across bodies, spaces and rooms", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the search suite");
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

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return grove.identity.claimAgent(reg.agent.id, owner);
  }

  it("never returns a private space, its rooms, or where its members stand to outsiders", async () => {
    const owner = await newHuman("srch-owner");
    const member = await newHuman("srch-member");
    const stranger = await newHuman("srch-stranger");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Aardvark Vault ${t}`, slug: `aardvault-${t}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);
    const agent = await newAgent(owner, `vaultbot${t}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${space.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: space.id,
    });

    for (const viewer of [null, stranger.id]) {
      const bySpace = await grove.search.search(viewer, `aardvault-${t}`);
      expect(bySpace.spaces).toEqual([]);
      const byName = await grove.search.search(viewer, `Aardvark Vault ${t}`);
      expect(byName.spaces).toEqual([]);
      const rooms = await grove.search.search(viewer, "plaza");
      expect(rooms.rooms.some((r) => r.spaceSlug === space.slug)).toBe(false);
      // The agent is as public as /a, but not where it stands.
      const bot = await grove.search.search(viewer, `vaultbot${t}`);
      expect(bot.agents).toHaveLength(1);
      expect(bot.agents[0]).toMatchObject({ online: false, roomSlug: null, roomName: null });
      expect(bot.online.some((b) => b.slug === agent.slug)).toBe(false);
      expect(JSON.stringify(bot)).not.toContain("aardvault");
    }

    for (const viewer of [owner.id, member.id]) {
      const mine = await grove.search.search(viewer, `aardvault-${t}`);
      expect(mine.spaces).toHaveLength(1);
      expect(mine.spaces[0]).toMatchObject({ slug: space.slug, isMember: true, policyPreset: "private" });
      const rooms = await grove.search.search(viewer, "plaza");
      expect(rooms.rooms.some((r) => r.spaceSlug === space.slug && r.slug === "plaza")).toBe(true);
    }
  });

  it("hides a public space's private-door room from non-members", async () => {
    const owner = await newHuman("srch-pub-owner");
    const stranger = await newHuman("srch-pub-stranger");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Aardwolf Yard ${t}`, slug: `aardyard-${t}`, preset: "public_view" });
    fixtures.trackWorld(space.id);
    await grove.campus.updateRoomAccess(owner, space.id, "library", { roomPreset: "private" });

    const found = await grove.search.search(stranger.id, `aardyard-${t}`);
    expect(found.spaces.map((s) => s.slug)).toEqual([space.slug]);
    expect(found.spaces[0]!.isMember).toBe(false);
    // Its district (#38): the ring of the plot the space was given.
    expect(found.spaces[0]!.ring).toBeGreaterThanOrEqual(2);

    const libraries = await grove.search.search(stranger.id, "library");
    expect(libraries.rooms.some((r) => r.spaceSlug === space.slug)).toBe(false);
    const anon = await grove.search.search(null, "library");
    expect(anon.rooms.some((r) => r.spaceSlug === space.slug)).toBe(false);
    const own = await grove.search.search(owner.id, "library");
    expect(own.rooms.some((r) => r.spaceSlug === space.slug)).toBe(true);
    // The commons room is always a result.
    expect(anon.rooms.some((r) => r.slug === "library" && r.spaceSlug === null)).toBe(true);
  });

  it("lists bodies on the commons map as online, and skips pending agents and suspended people", async () => {
    const owner = await newHuman("srch-online");
    const t = tag();
    const agent = await newAgent(owner, `plazabot${t}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "workshop", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });
    const res = await grove.search.search(null, `plazabot${t}`);
    expect(res.agents[0]).toMatchObject({ slug: agent.slug, online: true, roomSlug: "workshop", ownerHandle: owner.handle });
    expect(res.online.find((b) => b.slug === agent.slug)).toMatchObject({ kind: "agent", roomSlug: "workshop" });
    // No query: only the online list.
    const idle = await grove.search.search(null, "   ");
    expect(idle).toMatchObject({ query: "", agents: [], humans: [], spaces: [], rooms: [] });
    expect(idle.online.some((b) => b.slug === agent.slug)).toBe(true);

    await clearRegisterLimiter(redis, REGISTER_IP);
    const pending = await grove.identity.registerAgent({ name: `pendingbot${t}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(pending.agent.id);
    expect((await grove.search.search(null, `pendingbot${t}`)).agents).toEqual([]);

    expect((await grove.search.search(null, owner.handle)).humans.map((h) => h.handle)).toContain(owner.handle);
    await pg.query(`UPDATE humans SET suspended_at = now() WHERE id = $1`, [owner.id]);
    expect((await grove.search.search(null, owner.handle)).humans.map((h) => h.handle)).not.toContain(owner.handle);

    // Wildcards are literal: "%" is not "everything".
    expect((await grove.search.search(null, "%")).humans).toEqual([]);
  });
});
