/**
 * The artifact board through the real routes (#36): who may post (401 signed
 * out, 403 a visitor, an owned agent by bearer and over MCP), who may read (a
 * private board is 404 to strangers, guests and signed-out readers), the image
 * route's headers, the report and hide routes, and the operator gate.
 */
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("board routes suite");

function tinyPng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 94, 234, 212, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!hasDb)("board routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the board routes suite");
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
    return { cookie, id: human.id };
  }

  let ipOctet = 0;
  async function agentFor(owner: { cookie: string }) {
    ipOctet += 1;
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": `198.51.100.${((Date.now() + ipOctet * 41) % 200) + 20}` },
      payload: { name: `boardr${Math.random().toString(36).slice(2, 7)}`, description: "board routes" },
    });
    expect(reg.statusCode).toBe(200);
    const { agent_id, api_key } = reg.json() as { agent_id: string; api_key: string };
    fixtures.trackAgent(agent_id);
    const claim = await app.inject({ method: "POST", url: `/api/v1/agents/${agent_id}/claim`, headers: { cookie: owner.cookie } });
    expect(claim.statusCode).toBe(200);
    return { id: agent_id, auth: { authorization: `Bearer ${api_key}` } };
  }

  async function createSpace(owner: { cookie: string }, preset: string) {
    const slug = `bd-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Board Harbour", slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  it("posts as the owner and an owned agent (REST and MCP), and refuses everyone else", async () => {
    const owner = await signIn("bdown");
    const visitor = await signIn("bdvis");
    const world = await createSpace(owner, "public_write");
    const agent = await agentFor(owner);

    const signedOut = await app.inject({ method: "POST", url: `/api/v1/spaces/${world.slug}/board`, payload: { kind: "text", caption: "hi" } });
    expect(signedOut.statusCode).toBe(401);
    const byVisitor = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${world.slug}/board`,
      headers: { cookie: visitor.cookie },
      payload: { kind: "text", caption: "hi" },
    });
    expect(byVisitor.statusCode).toBe(403);

    const text = await app.inject({
      method: "POST",
      url: `/api/v1/worlds/${world.id}/board`,
      headers: { cookie: owner.cookie },
      payload: { kind: "text", caption: "Open for visitors" },
    });
    expect(text.statusCode).toBe(201);
    expect(text.headers["ratelimit-policy"] ?? "").toContain("board_post");

    const image = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${world.slug}/board`,
      headers: agent.auth,
      payload: { kind: "image", caption: "the build", image_base64: tinyPng().toString("base64") },
    });
    expect(image.statusCode).toBe(201);
    const post = (image.json() as { post: { id: string; author: { kind: string }; image: { url: string; mime: string } } }).post;
    expect(post.author.kind).toBe("agent");
    expect(post.image.url).toBe(`/api/v1/board/posts/${post.id}/image`);

    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: agent.auth,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "board_post", arguments: { space: world.slug, kind: "text", caption: "posted over MCP" } },
      },
    });
    expect(mcp.statusCode).toBe(200);
    expect(JSON.stringify(mcp.json())).toContain("posted over MCP");

    const list = await app.inject({ method: "GET", url: `/api/v1/spaces/${world.slug}/board` });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { posts: Array<{ caption: string }>; can_post: boolean };
    expect(body.can_post).toBe(false);
    expect(body.posts.map((p) => p.caption)).toEqual(["posted over MCP", "the build", "Open for visitors"]);

    const img = await app.inject({ method: "GET", url: post.image.url });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(img.headers["cache-control"])).toMatch(/^private/);
    expect(String(img.headers["content-security-policy"])).toContain("sandbox");
    expect(img.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
    const again = await app.inject({ method: "GET", url: post.image.url, headers: { "if-none-match": String(img.headers.etag) } });
    expect(again.statusCode).toBe(304);

    const tooBig = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${world.slug}/board`,
      headers: { cookie: owner.cookie },
      payload: { kind: "image", image_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it("keeps a private board 404 to strangers, guests and signed-out readers", async () => {
    const owner = await signIn("bdpown");
    const stranger = await signIn("bdpnosy");
    const world = await createSpace(owner, "private");
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${world.id}/board`,
      headers: { cookie: owner.cookie },
      payload: { kind: "image", image_base64: tinyPng().toString("base64") },
    });
    expect(posted.statusCode).toBe(201);
    const id = (posted.json() as { post: { id: string } }).post.id;

    // A guest pass is never an identity for reads (auth.ts ignores the cookie), so a
    // guest reads exactly as a signed-out visitor does.
    const guestCookie = "grove_guest=not-a-member-token; grove_guest_hint=1";
    for (const headers of [{}, { cookie: stranger.cookie }, { cookie: guestCookie }]) {
      expect((await app.inject({ method: "GET", url: `/api/v1/spaces/${world.id}/board`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/v1/board/posts/${id}/image`, headers })).statusCode).toBe(404);
    }
    const report = await app.inject({
      method: "POST",
      url: `/api/v1/board/posts/${id}/report`,
      headers: { cookie: stranger.cookie },
      payload: { category: "spam" },
    });
    expect(report.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/spaces/${world.id}/board`, headers: { cookie: owner.cookie } })).statusCode).toBe(200);
  });

  it("reports, hides through /mod (operators only) and deletes as the owner", async () => {
    const owner = await signIn("bdmown");
    const reader = await signIn("bdmread");
    const op = await signIn("bdmop");
    await pg.query(`UPDATE humans SET role = 'operator' WHERE id = $1`, [op.id]);
    const world = await createSpace(owner, "public_view");
    const posted = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${world.id}/board`,
      headers: { cookie: owner.cookie },
      payload: { kind: "image", caption: "flag me", image_base64: tinyPng().toString("base64") },
    });
    const id = (posted.json() as { post: { id: string } }).post.id;

    const report = await app.inject({
      method: "POST",
      url: `/api/v1/board/posts/${id}/report`,
      headers: { cookie: reader.cookie },
      payload: { category: "harassment", details: "not ok" },
    });
    expect(report.statusCode).toBe(201);
    const queue = await app.inject({ method: "GET", url: "/api/v1/mod/queue?status=open", headers: { cookie: op.cookie } });
    const card = (queue.json() as { reports: Array<Record<string, any>> }).reports.find((r) => r.target_ref === id);
    expect(card).toMatchObject({ target_kind: "board_post", board_post: { id, caption: "flag me", image_url: `/api/v1/mod/board/posts/${id}/image` } });

    const hideAsReader = await app.inject({
      method: "POST",
      url: `/api/v1/mod/board/posts/${id}/hide`,
      headers: { cookie: reader.cookie },
      payload: { hidden: true, reason: "x" },
    });
    expect(hideAsReader.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/mod/board/posts/${id}/image`, headers: { cookie: reader.cookie } })).statusCode).toBe(404);
    const opImage = await app.inject({ method: "GET", url: `/api/v1/mod/board/posts/${id}/image`, headers: { cookie: op.cookie } });
    expect(opImage.statusCode).toBe(200);
    expect(opImage.headers["cache-control"]).toBe("no-store");

    const hide = await app.inject({
      method: "POST",
      url: `/api/v1/mod/board/posts/${id}/hide`,
      headers: { cookie: op.cookie },
      payload: { hidden: true, reason: "harassment" },
    });
    expect(hide.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/board/posts/${id}/image` })).statusCode).toBe(404);
    const publicList = await app.inject({ method: "GET", url: `/api/v1/spaces/${world.id}/board` });
    expect((publicList.json() as { posts: unknown[] }).posts).toHaveLength(0);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/board/posts/${id}`, headers: { cookie: reader.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/board/posts/${id}` })).statusCode).toBe(401);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/board/posts/${id}`, headers: { cookie: owner.cookie } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/mod/board/posts/${id}/image`, headers: { cookie: op.cookie } })).statusCode).toBe(404);
  });
});
