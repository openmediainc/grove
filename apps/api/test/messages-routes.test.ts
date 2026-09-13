/**
 * Leave a message through the real routes: a send answers 201 with the message,
 * nobody is a 404, a refusal carries the kernel's attribution for RefusalNotice,
 * a retried Idempotency-Key is one message, and the inbox is the reader's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("messages routes suite");

describe.skipIf(!hasDb)("message routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the messages routes suite");
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

  it("sends, refuses in the kernel's words, and serves the reader their own inbox", async () => {
    const ada = await signIn("msgada");
    const bo = await signIn("msgbo");

    const unsigned = await app.inject({ method: "POST", url: "/api/v1/messages", payload: { to: { kind: "human", ref: bo.handle }, body: "hi" } });
    expect(unsigned.statusCode).toBe(401);

    const nobody = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: { cookie: ada.cookie },
      payload: { to: { kind: "human", ref: `nobody${Date.now()}` }, body: "hi" },
    });
    expect(nobody.statusCode).toBe(404);
    const bad = await app.inject({ method: "POST", url: "/api/v1/messages", headers: { cookie: ada.cookie }, payload: { to: "x", body: "hi" } });
    expect(bad.statusCode).toBe(400);

    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers: { cookie: ada.cookie, "idempotency-key": `idem-${ada.id}` },
        payload: { to_kind: "human", to_ref: `@${bo.handle}`, body: "hello bo" },
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    const message = (first.json() as { message: { id: string; from: { ref: string }; reply_to: string | null } }).message;
    expect(message.from.ref).toBe(ada.handle);
    expect(message.reply_to).toBeNull();
    expect(((await send()).json() as { message: { id: string } }).message.id).toBe(message.id);

    const inbox = await app.inject({ method: "GET", url: "/api/v1/messages", headers: { cookie: bo.cookie } });
    const read = inbox.json() as { received: Array<{ id: string; body: string }>; unread: number };
    expect(read.unread).toBe(1);
    expect(read.received.map((m) => m.body)).toEqual(["hello bo"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/messages", headers: { cookie: ada.cookie } })).json()).toMatchObject({ received: [], unread: 0 });

    const reply = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: { cookie: bo.cookie },
      payload: { to: { kind: "human", ref: ada.handle }, body: "hello ada", reply_to: message.id },
    });
    expect(reply.statusCode).toBe(201);
    const seen = await app.inject({ method: "POST", url: "/api/v1/messages/seen", headers: { cookie: bo.cookie }, payload: {} });
    expect((seen.json() as { marked: number }).marked).toBe(1);

    // A block is refused as a block, with nothing that names whose it was.
    await pg.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [bo.id, ada.id]);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: { cookie: ada.cookie },
      payload: { to: { kind: "human", ref: bo.handle }, body: "still there?" },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "BLOCKED" });
    expect((blocked.json() as { error: Record<string, unknown> }).error.source).toBeUndefined();

    // The write limiter, with its own retry-after.
    await redis.set(`ratelimit:${bo.id}:write:min`, "30", "EX", 60);
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: { cookie: bo.cookie },
      payload: { to: { kind: "human", ref: ada.handle }, body: "flood" },
    });
    expect(limited.statusCode).toBe(429);
    await redis.del(`ratelimit:${bo.id}:write:min`);
  });
});
