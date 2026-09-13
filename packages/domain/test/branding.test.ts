/**
 * Space branding (035). The properties that matter:
 *  - only the owner writes it; everyone else gets a 404, and invalid values are
 *    refused with a plain reason;
 *  - a private space's branding is behind its door, and the public minimap
 *    never carries it — not the accent, not the emblem, not the sign text —
 *    while a public plot's branding rides along with its name.
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

describe.skipIf(!hasDb)("space branding", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the branding suite");
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

  it("lets only the owner write, refuses bad values, and clears on null", async () => {
    const owner = await newHuman("brand-owner");
    const stranger = await newHuman("brand-stranger");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Brand Yard ${t}`, slug: `brandyard-${t}`, preset: "public_write" });
    fixtures.trackWorld(space.id);

    expect(await grove.branding.spaceBranding(null, space.slug)).toBeNull();
    const set = await grove.branding.setSpaceBranding(owner, space.id, { accent: "sky", signText: " Open late ", emblem: "moon" });
    expect(set).toEqual({ accent: "#7dd3fc", signText: "Open late", emblem: "moon" });
    expect(await grove.branding.spaceBranding(null, space.slug)).toEqual(set);

    expect(await code(grove.branding.setSpaceBranding(stranger, space.id, { accent: "mint" }))).toBe("NOT_FOUND");
    expect(await code(grove.branding.setSpaceBranding(owner, space.id, { accent: "#111111" }))).toBe("INVALID");
    expect(await code(grove.branding.setSpaceBranding(owner, space.id, { signText: "x".repeat(25) }))).toBe("INVALID");
    expect(await code(grove.branding.setSpaceBranding(owner, space.id, { emblem: "logo.png" }))).toBe("INVALID");
    // A refused write changes nothing.
    expect(await grove.branding.ofWorld(space.id)).toEqual(set);

    const partial = await grove.branding.setSpaceBranding(owner, space.id, { signText: null });
    expect(partial).toEqual({ accent: "#7dd3fc", signText: null, emblem: "moon" });
    expect(await grove.branding.setSpaceBranding(owner, space.id, { accent: null, emblem: null })).toBeNull();
    const { rows } = await pg.query(`SELECT branding FROM worlds WHERE id = $1`, [space.id]);
    expect(rows[0].branding).toBeNull();
  });

  it("never publishes a private plot's branding on the minimap, and hides it behind the door", async () => {
    const owner = await newHuman("brand-private");
    const member = await newHuman("brand-member");
    const t = tag();
    const space = await grove.campus.createWorld(owner, { name: `Hidden ${t}`, slug: `hidden-${t}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);
    await grove.branding.setSpaceBranding(owner, space.id, { accent: "#a7f3d0", signText: `Secret ${t}`, emblem: "anchor" });

    const row = (await grove.world.minimap()).spaces.find((s) => s.id === space.id)!;
    expect(row.branding).toBeNull();
    expect(row.name).toBeNull();
    const wire = JSON.stringify(row);
    expect(wire).not.toContain("a7f3d0");
    expect(wire).not.toContain("anchor");
    expect(wire).not.toContain("Secret");

    expect(await code(grove.branding.spaceBranding(null, space.id))).toBe("NOT_FOUND");
    expect(await code(grove.branding.spaceBranding(null, space.slug))).toBe("NOT_FOUND");
    expect((await grove.branding.spaceBranding(member, space.slug))?.emblem).toBe("anchor");

    // Opened up, the same branding rides with the name.
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "public_view" });
    const open = (await grove.world.minimap()).spaces.find((s) => s.id === space.id)!;
    expect(open.branding).toEqual({ accent: "#a7f3d0", signText: `Secret ${t}`, emblem: "anchor" });
    // And closed again, it goes with the name.
    await grove.campus.updateWorld(owner, space.id, { policyPreset: "private" });
    expect((await grove.world.minimap()).spaces.find((s) => s.id === space.id)!.branding).toBeNull();
  });
});
