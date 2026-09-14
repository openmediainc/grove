/**
 * Stored cinematic sequences through the real routes (#39): saving is signed-in
 * only and validated with the protocol's own schema; reading is public by id,
 * immutable, never names who saved it; unknown or malformed ids are 404.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("sequences routes suite");

describe.skipIf(!hasDb)("sequences routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the sequences routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
  });

  const saved: string[] = [];

  afterAll(async () => {
    try {
      if (pg && saved.length) await pg.query(`DELETE FROM camera_sequences WHERE id = ANY($1::text[])`, [saved]);
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

  const sequence = {
    title: "Round the Plaza",
    shots: [
      { kind: "push", from: { tx: 20, ty: 20, zoom: 0.5 }, to: { tx: 22, ty: 21, zoom: 1.4 }, duration_ms: 4000 },
      { kind: "orbit", from: { tx: 22, ty: 17, zoom: 1.2 }, to: { tx: 22, ty: 21, zoom: 1.2 }, duration_ms: 9000, follow: "lantern" },
      { kind: "hold", from: { tx: 22, ty: 21, zoom: 1.2 }, duration_ms: 2000 },
    ],
  };

  it("saves for a signed-in person and reads back by id, anonymously", async () => {
    const me = await signIn("seqsave");

    const anon = await app.inject({ method: "POST", url: "/api/v1/sequences", payload: { sequence } });
    expect(anon.statusCode).toBe(401);

    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/sequences",
      headers: { cookie: me.cookie },
      payload: { sequence: { ...sequence, shots: Array(13).fill(sequence.shots[2]) } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/at most 12 shots/);

    const res = await app.inject({ method: "POST", url: "/api/v1/sequences", headers: { cookie: me.cookie }, payload: { sequence } });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    saved.push(id);
    expect(id).toMatch(/^seq_[0-9A-Z]{26}$/);

    const read = await app.inject({ method: "GET", url: `/api/v1/sequences/${id}` });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toMatch(/immutable/);
    const body = read.json() as { sequence: { title: string; shots: Array<{ kind: string; duration_ms: number; follow: string | null }> } };
    expect(body.sequence.title).toBe("Round the Plaza");
    expect(body.sequence.shots.map((s) => s.kind)).toEqual(["push", "orbit", "hold"]);
    expect(body.sequence.shots[1]!.follow).toBe("lantern");
    // Who saved it is never on the wire.
    expect(read.body).not.toContain(me.id);
    expect(read.body).not.toContain(me.handle);

    // Immutable: there is no update, and no list.
    expect((await app.inject({ method: "PUT", url: `/api/v1/sequences/${id}`, headers: { cookie: me.cookie }, payload: { sequence } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/sequences" })).statusCode).toBe(404);
  });

  it("answers 404 for unknown and malformed ids", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/sequences/seq_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/sequences/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/sequences/'%20OR%201=1" })).statusCode).toBe(404);
  });
});
