/**
 * Cards: working on / looking for / latest / links.
 *
 * The properties that matter:
 *  - a private space's card is behind its door: a non-member (or nobody) gets
 *    the same 404 as a space that does not exist, by id or by slug;
 *  - only the owner writes a space's card;
 *  - an agent's working on and latest fill themselves from spans and pulses,
 *    an owner cannot type them, and they never read out of a room the viewer
 *    could not watch (a private space, an owner lounge);
 *  - a person writes their own card and nobody else's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { GroveError } from "../src/errors.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.cards;
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("cards for spaces and bodies", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the cards suite");
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

  async function notFound(p: Promise<unknown>) {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GroveError);
    expect((err as GroveError).code).toBe("NOT_FOUND");
  }

  it("keeps a private space's card behind its door, and lets only the owner write it", async () => {
    const owner = await newHuman("card-owner");
    const member = await newHuman("card-member");
    const stranger = await newHuman("card-stranger");
    const space = await grove.campus.createWorld(owner, { name: `Harbour ${tag()}`, slug: `harbour-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);

    const written = await grove.cards.setSpaceCard(owner, space.id, {
      workingOn: "a lighthouse",
      lookingFor: "a cartographer",
      links: [{ label: "Plans", url: "https://example.com/plans" }],
    });
    expect(written.card).toMatchObject({ workingOn: "a lighthouse", lookingFor: "a cartographer", latest: null });
    expect(written.editable).toContain("workingOn");

    const seen = await grove.cards.spaceCard(member, space.slug);
    expect(seen.card.lookingFor).toBe("a cartographer");
    expect(seen.editable).toEqual([]);

    await notFound(grove.cards.spaceCard(stranger, space.id));
    await notFound(grove.cards.spaceCard(stranger, space.slug));
    await notFound(grove.cards.spaceCard(null, space.id));
    await notFound(grove.cards.spaceCard(null, `no-such-space-${tag()}`));
    await notFound(grove.cards.setSpaceCard(member, space.id, { lookingFor: "me" }));
    await notFound(grove.cards.setSpaceCard(stranger, space.id, { lookingFor: "me" }));

    // Public spaces show their card to anyone.
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "public_view" });
    expect((await grove.cards.spaceCard(null, space.slug)).card.workingOn).toBe("a lighthouse");
  });

  it("fills an agent's working on and latest from its spans, and refuses an owner typing them", async () => {
    const owner = await newHuman("card-agent-owner");
    const agent = await newAgent(owner, `carder${tag()}`);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, "workshop", {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
    });

    const blank = await grove.cards.agentCard(null, agent.slug);
    expect(blank.card).toMatchObject({ workingOn: null, latest: null, lookingFor: null, links: [] });

    await expect(grove.cards.setAgentCard(owner, agent.id, { workingOn: "very busy" })).rejects.toMatchObject({ code: "INVALID" });
    const set = await grove.cards.setAgentCard(owner, agent.id, { lookingFor: "reviewers", links: [{ url: "https://example.com" }] });
    expect(set.card.lookingFor).toBe("reviewers");
    expect(set.editable).toEqual(["lookingFor", "links"]);
    const stranger = await newHuman("card-agent-stranger");
    await notFound(grove.cards.setAgentCard(stranger, agent.id, { lookingFor: "x" }));

    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "read", "the brief");
    const pulsed = await grove.cards.agentCard(null, agent.slug);
    expect(pulsed.card.workingOn).toBe("the brief");
    expect(pulsed.sources.workingOn).toBe("pulse");

    await clearActorLimiters(redis, agent.id);
    const done = `d${tag()}`;
    await grove.toolCalls.start(agent.id, { callId: done, name: "Bash", args: "pnpm test" });
    await grove.toolCalls.finish(agent.id, done, { outcome: "ok", result: "green" });
    await clearActorLimiters(redis, agent.id);
    await grove.toolCalls.start(agent.id, { callId: `o${tag()}`, name: "Edit", args: "WorldMap.tsx" });

    const live = await grove.cards.agentCard(null, agent.slug);
    expect(live.card.workingOn).toMatch(/^Edit · WorldMap\.tsx/);
    expect(live.sources.workingOn).toBe("span");
    expect(live.card.latest).toMatch(/^Bash · pnpm test · .* · done$/);
    expect(live.sources.latest).toBe("span");
    expect(live.latestAt).not.toBeNull();
    // A result is never on the card: one line of what ran, not what it said.
    expect(JSON.stringify(live)).not.toContain("green");
    expect(live.card.lookingFor).toBe("reviewers");
    expect(live.editable).toEqual([]);
  });

  it("never reads an agent's work out of a private space the viewer is not in", async () => {
    const owner = await newHuman("card-private-owner");
    const stranger = await newHuman("card-private-stranger");
    const agent = await newAgent(owner, `hidden${tag()}`);
    const space = await grove.campus.createWorld(owner, { name: `Vault ${tag()}`, slug: `vault-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.presence.enter({ id: agent.id, kind: "agent", ownerHumanId: owner.id }, `${space.id}:plaza`, {
      connection: "async",
      mode: "autonomous",
      activity: "idle",
      worldId: space.id,
    });
    await clearActorLimiters(redis, agent.id);
    const secret = `s${tag()}`;
    await grove.toolCalls.start(agent.id, { callId: secret, name: "Read", args: "vault-plans" });
    await grove.toolCalls.finish(agent.id, secret, { outcome: "ok" });
    await clearActorLimiters(redis, agent.id);
    await grove.presence.pulse(agent.id, "think", "vault-scheming");
    await clearActorLimiters(redis, agent.id);
    for (const viewer of [null, stranger.id]) {
      expect((await grove.cards.agentCard(viewer, agent.slug)).card.workingOn).toBeNull();
    }
    await grove.toolCalls.start(agent.id, { callId: `o${tag()}`, name: "Write", args: "vault-open" });

    for (const viewer of [null, stranger.id]) {
      const card = await grove.cards.agentCard(viewer, agent.slug);
      expect(card.card.workingOn).toBeNull();
      expect(card.card.latest).toBeNull();
      expect(JSON.stringify(card)).not.toContain("vault");
    }
    const mine = await grove.cards.agentCard(owner.id, agent.slug);
    expect(mine.card.workingOn).toMatch(/^Write · vault-open/);
    expect(mine.card.latest).toMatch(/^Read · vault-plans/);
  });

  it("lets a person write their own card, and nobody else's", async () => {
    const me = await newHuman("card-me");
    const other = await newHuman("card-other");
    const card = await grove.cards.setHumanCard(me, { workingOn: "a map", latest: "shipped cards", links: [] });
    expect(card.card).toMatchObject({ workingOn: "a map", latest: "shipped cards" });
    expect((await grove.cards.humanCard(other, me.handle)).editable).toEqual([]);
    expect((await grove.cards.humanCard(me, me.handle)).editable).toContain("latest");
    await expect(grove.cards.setHumanCard(me, { links: [{ url: "javascript:alert(1)" }] })).rejects.toMatchObject({ code: "INVALID" });
    await notFound(grove.cards.humanCard(null, `nobody-${tag()}`));
  });
});
