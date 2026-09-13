/**
 * Transfer & relocate through the real routes (#35): signed out is 401; anyone
 * who does not hold the space (a member, a stranger, an operator) gets 404;
 * only the recipient answers an offer; the typed slug is required.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("space moves routes suite");

describe.skipIf(!hasDb)("space moves routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the space moves routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await app?.close();
      await redis.quit();
      await pg.end();
    }
  });

  async function signIn(tag: string) {
    const local = `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const magic = await app.inject({
      method: "POST",
      url: "/api/v1/humans/session",
      payload: { email: `${local}@example.com`, invite_code: "grove-alpha", age_attested: true },
    });
    const token = new URL((magic.json() as { dev_login_url?: string }).dev_login_url ?? "http://x?token=").searchParams.get("token");
    const consumed = await app.inject({ method: "POST", url: "/api/v1/humans/session/consume", payload: { token } });
    const raw = consumed.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id, handle: human.handle };
  }

  it("gates every transfer and relocate route on the holder, and offers on the recipient", async () => {
    const owner = await signIn("mvown");
    const heir = await signIn("mvheir");
    const stranger = await signIn("mvnosy");
    const op = await signIn("mvop");
    await pg.query(`UPDATE humans SET role = 'operator' WHERE id = $1`, [op.id]);
    const slug = `mv-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Move Harbour", slug, policy_preset: "private" },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; plot_index: number } }).world;
    fixtures.trackWorld(world.id);
    await grove.campus.addMember(world.id, heir.id);

    const as = (who: { cookie: string } | null, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
      app.inject({ method, url, ...(who ? { headers: { cookie: who.cookie } } : {}), ...(payload ? { payload } : {}) });

    // Signed out.
    for (const [m, u] of [
      ["GET", `/api/v1/worlds/${world.id}/transfer`],
      ["POST", `/api/v1/worlds/${world.id}/transfer`],
      ["GET", `/api/v1/worlds/${world.id}/relocate`],
      ["POST", `/api/v1/worlds/${world.id}/relocate`],
      ["GET", "/api/v1/transfers/incoming"],
    ] as const) {
      expect((await as(null, m, u, m === "POST" ? {} : undefined)).statusCode).toBe(401);
    }

    // A member, a stranger and an operator: not the holder, so 404 everywhere.
    for (const who of [heir, stranger, op]) {
      expect((await as(who, "GET", `/api/v1/worlds/${world.id}/transfer`)).statusCode).toBe(404);
      expect((await as(who, "GET", `/api/v1/worlds/${world.id}/relocate`)).statusCode).toBe(404);
      expect((await as(who, "DELETE", `/api/v1/worlds/${world.id}/transfer`)).statusCode).toBe(404);
      const move = await as(who, "POST", `/api/v1/worlds/${world.id}/relocate`, { plot_index: 99, confirm: slug });
      expect(move.statusCode).toBe(404);
      expect(move.body).not.toContain("Move Harbour");
    }

    const state = await as(owner, "GET", `/api/v1/worlds/${world.id}/transfer`);
    expect(state.statusCode).toBe(200);
    const members = (state.json() as { candidates: { members: Array<{ human_id: string }> } }).candidates.members;
    expect(members.map((m) => m.human_id)).toEqual([heir.id]);

    const unconfirmed = await as(owner, "POST", `/api/v1/worlds/${world.id}/transfer`, { to_human_id: heir.id });
    expect(unconfirmed.statusCode).toBe(400);
    const offered = await as(owner, "POST", `/api/v1/worlds/${world.id}/transfer`, { to_human_id: heir.id, confirm: slug });
    expect(offered.statusCode).toBe(201);
    const offerId = (offered.json() as { transfer: { id: string } }).transfer.id;

    const incoming = await as(heir, "GET", "/api/v1/transfers/incoming");
    expect((incoming.json() as { offers: Array<{ id: string; world_slug: string }> }).offers.map((o) => o.id)).toContain(offerId);
    expect((await as(stranger, "GET", "/api/v1/transfers/incoming")).body).not.toContain(offerId);

    expect((await as(stranger, "POST", `/api/v1/transfers/${offerId}/accept`)).statusCode).toBe(404);
    expect((await as(op, "POST", `/api/v1/transfers/${offerId}/accept`)).statusCode).toBe(404);
    expect((await as(owner, "POST", `/api/v1/transfers/${offerId}/accept`)).statusCode).toBe(404);
    const accepted = await as(heir, "POST", `/api/v1/transfers/${offerId}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { transfer: { status: string } }).transfer.status).toBe("accepted");

    const detail = await as(heir, "GET", `/api/v1/worlds/${world.id}`);
    expect((detail.json() as { is_holder: boolean; world: { owner_human_id: string } }).is_holder).toBe(true);
    expect((await as(owner, "GET", `/api/v1/worlds/${world.id}`)).json()).toMatchObject({ is_holder: false, is_member: true });

    // The new holder moves it; the old one no longer can.
    expect((await as(owner, "GET", `/api/v1/worlds/${world.id}/relocate`)).statusCode).toBe(404);
    const plan = await as(heir, "GET", `/api/v1/worlds/${world.id}/relocate`);
    expect(plan.statusCode).toBe(200);
    const options = (plan.json() as { options: Array<{ plot_index: number }> }).options.map((o) => o.plot_index);
    const target = Math.max(...options);
    const noConfirm = await as(heir, "POST", `/api/v1/worlds/${world.id}/relocate`, { plot_index: target, confirm: "x" });
    expect(noConfirm.statusCode).toBe(400);
    const moved = await as(heir, "POST", `/api/v1/worlds/${world.id}/relocate`, { plot_index: target, confirm: slug });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { world: { plot_index: number } }).world.plot_index).toBe(target);
    const again = await as(heir, "POST", `/api/v1/worlds/${world.id}/relocate`, { plot_index: Math.min(...options), confirm: slug });
    expect(again.statusCode).toBe(429);

    // The commons: neither.
    const core = await as(op, "POST", "/api/v1/worlds/aetheria-prime/relocate", { plot_index: 3, confirm: "aetheria-prime" });
    expect(core.statusCode).toBe(400);
  });
});
