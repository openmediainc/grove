/**
 * Whisper history through the real routes: signed out is a 401, the two parties
 * read the whisper back in wire spelling after a "reload", a third person in the
 * same room reads nothing, and an unknown room is a 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("whisper history routes suite");

describe.skipIf(!hasDb)("whisper history routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the whisper history routes suite");
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

  it("serves each party their own whispers and nobody else", async () => {
    const ada = await signIn("whrada");
    const bo = await signIn("whrbo");
    const cy = await signIn("whrcy");
    for (const who of [ada, bo, cy]) {
      const entered = await app.inject({ method: "POST", url: "/api/v1/rooms/library/enter", headers: { cookie: who.cookie }, payload: {} });
      expect(entered.statusCode).toBe(200);
    }

    expect((await app.inject({ method: "GET", url: "/api/v1/rooms/library/whispers" })).statusCode).toBe(401);

    const said = await app.inject({
      method: "POST",
      url: "/api/v1/say",
      headers: { cookie: ada.cookie, "idempotency-key": `wh-${ada.id}` },
      payload: { channel: "whisper", target_id: bo.id, body: "only you" },
    });
    expect(said.statusCode).toBeLessThan(300);
    const speechId = (said.json() as { speech: { id: string } }).speech.id;

    type Wire = { whispers: Array<Record<string, unknown>> };
    const read = async (cookie: string, room = "library") =>
      app.inject({ method: "GET", url: `/api/v1/rooms/${room}/whispers`, headers: { cookie } });

    const adaView = (await read(ada.cookie)).json() as Wire;
    expect(adaView.whispers).toEqual([
      expect.objectContaining({ id: speechId, body: "only you", direction: "out", other_id: bo.id, other_kind: "human", undelivered: null }),
    ]);
    const boView = (await read(bo.cookie)).json() as Wire;
    expect(boView.whispers).toEqual([expect.objectContaining({ id: speechId, direction: "in", other_id: ada.id })]);
    expect(((await read(cy.cookie)).json() as Wire).whispers).toEqual([]);
    expect((await read(ada.cookie, `nowhere${Date.now()}`)).statusCode).toBe(404);
  });
});
