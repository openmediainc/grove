/**
 * Two pieces of wiring, tested where they actually live: on the routes.
 *
 *  1. KEYPAIR AUTH THROUGH THE REAL ROUTES. The verifier, the binder and the
 *     docs all existed and were tested; no route exposed any of it, so nobody
 *     could register or bind a key. These tests go through `app.inject()` on
 *     purpose — a domain-level test of `identity.bindPublicKey()` already
 *     passes today and says nothing about whether the door is open.
 *
 *     The property that matters is the one KEYPAIR.md names: a bind takes TWO
 *     independent proofs — control of the AGENT (an authenticated call) and
 *     control of the KEY (a signature over this agent's id) — and neither
 *     substitutes for the other.
 *
 *  2. PAPERCLIP MUST NOT STALL THE FRONT DOOR. `GET /world/minimap` is
 *     unauthenticated and polled every 8 seconds by every viewer of the public
 *     landing page. With Paperclip's socket hung it used to cost its full 1.5 s
 *     timeout on EVERY poll. The breaker means a dead Paperclip is asked once
 *     per window, not once per poll per viewer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import crypto from "node:crypto";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.routesWiring;

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("routes wiring suite");

const now = () => Math.floor(Date.now() / 1000);
const tag = () => Math.random().toString(36).slice(2, 10);

/**
 * An agent author's whole signing implementation, written out rather than
 * imported from the SDK: if this drifts from what Grove verifies, an agent in
 * any language drifts with it.
 */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: (publicKey.export({ format: "jwk" }) as { x: string }).x,
    privateKey,
  };
}

function sign(privateKey: crypto.KeyObject, message: string): string {
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

function nonce(): string {
  return crypto.randomBytes(12).toString("base64url");
}

type Keys = ReturnType<typeof generateKeypair>;

/** The `grove-bind-v1` proof, in the wire shape the SDKs post. */
function bindProof(keys: Keys, agentId: string) {
  const timestamp = now();
  const n = nonce();
  return {
    public_key: keys.publicKey,
    timestamp,
    nonce: n,
    signature: sign(keys.privateKey, ["grove-bind-v1", agentId, keys.publicKey, String(timestamp), n].join("\n")),
  };
}

/** The four `X-Grove-*` headers that authenticate one request. */
function signedHeaders(keys: Keys, method: string, path: string): Record<string, string> {
  const timestamp = now();
  const n = nonce();
  return {
    "x-grove-key": keys.publicKey,
    "x-grove-timestamp": String(timestamp),
    "x-grove-nonce": n,
    "x-grove-signature": sign(
      keys.privateKey,
      ["grove-auth-v1", method.toUpperCase(), path, String(timestamp), n].join("\n"),
    ),
  };
}

describe.skipIf(!hasDb)("the routes that were built and never wired up", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the routes wiring suite");
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

  async function register(body: Record<string, unknown>) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { "x-forwarded-for": REGISTER_IP },
      payload: { description: "fixture", ...body },
    });
    const payload = res.json() as Record<string, unknown>;
    if (typeof payload.agent_id === "string") fixtures.trackAgent(payload.agent_id);
    return { res, payload };
  }

  // -- registration binds a key -------------------------------------------

  it("binds a key at registration and lets it authenticate a request", async () => {
    const keys = generateKeypair();
    const { res, payload } = await register({
      name: `keyed${tag()}`,
      // The registration proof covers the EMPTY agent id: there is no agent yet,
      // so nobody can have a competing claim on it.
      public_key: bindProof(keys, ""),
    });
    expect(res.statusCode).toBe(200);
    // Both SDKs hard-fail when this is missing, because a deployment that
    // ignored the proof would hand back a working bearer token and then 401
    // every signed request with "Unknown public key" and nothing to say why.
    expect(payload.public_key).toBe(keys.publicKey);

    // The key is a real credential: no bearer token anywhere in this request.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/agents/me",
      headers: signedHeaders(keys, "GET", "/api/v1/agents/me"),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { agent: { id: string } }).agent.id).toBe(payload.agent_id);
  });

  it("leaves a registration with no key exactly as it was", async () => {
    const { res, payload } = await register({ name: `plain${tag()}` });
    expect(res.statusCode).toBe(200);
    expect(payload.api_key).toMatch(/^aeth_/);
    // Absent, not null: a client that tests for the field must not see one.
    expect("public_key" in payload).toBe(false);
  });

  it("refuses a half-built proof rather than silently ignoring it", async () => {
    const keys = generateKeypair();
    const proof = bindProof(keys, "") as Record<string, unknown>;
    delete proof.signature;
    const { res, payload } = await register({ name: `half${tag()}`, public_key: proof });
    expect(res.statusCode).toBe(400);
    expect((payload.error as { code: string }).code).toBe("INVALID");
  });

  // -- binding a key to an agent that already exists -----------------------

  it("binds a key to an existing agent, given both proofs", async () => {
    const { payload } = await register({ name: `late${tag()}` });
    const agentId = String(payload.agent_id);
    const apiKey = String(payload.api_key);
    const keys = generateKeypair();

    const bound = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { public_key: bindProof(keys, agentId) },
    });
    expect(bound.statusCode).toBe(200);
    const boundBody = bound.json() as { public_key: string; key_id: string };
    expect(boundBody.public_key).toBe(keys.publicKey);
    expect(boundBody.key_id).toBeTruthy();

    // It authenticates, and it is the same agent.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/agents/me",
      headers: signedHeaders(keys, "GET", "/api/v1/agents/me"),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { agent: { id: string } }).agent.id).toBe(agentId);
  });

  it("refuses a bind with no agent credential, however good the key proof is", async () => {
    const { payload } = await register({ name: `nocred${tag()}` });
    const agentId = String(payload.agent_id);
    const keys = generateKeypair();

    // A perfect proof of the key, and no proof of the agent. This is the whole
    // reason the route is authenticated: without it anyone could staple their
    // own key onto any agent id they can name, and then sign as that agent.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      payload: { public_key: bindProof(keys, agentId) },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    // Nothing was written: the key is still nobody's.
    const { rowCount } = await pg.query("SELECT 1 FROM agent_keys WHERE public_key = $1", [keys.publicKey]);
    expect(rowCount).toBe(0);
  });

  it("refuses a bind whose proof names a different agent", async () => {
    const mine = await register({ name: `mine${tag()}` });
    const theirs = await register({ name: `theirs${tag()}` });
    const keys = generateKeypair();

    // Authenticated as my own agent, presenting a proof minted for somebody
    // else's. The agent id INSIDE the signature is what stops this.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(mine.payload.api_key)}` },
      payload: { public_key: bindProof(keys, String(theirs.payload.agent_id)) },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("INVALID");
  });

  it("refuses a registration proof replayed as a rebind", async () => {
    const { payload } = await register({ name: `replay${tag()}` });
    const keys = generateKeypair();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(payload.api_key)}` },
      // Covers the empty agent id, which is nobody's id.
      payload: { public_key: bindProof(keys, "") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to bind one key to two agents", async () => {
    const first = await register({ name: `first${tag()}` });
    const second = await register({ name: `second${tag()}` });
    const keys = generateKeypair();

    const one = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(first.payload.api_key)}` },
      payload: { public_key: bindProof(keys, String(first.payload.agent_id)) },
    });
    expect(one.statusCode).toBe(200);

    const two = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(second.payload.api_key)}` },
      payload: { public_key: bindProof(keys, String(second.payload.agent_id)) },
    });
    expect((two.json() as { error: { code: string } }).error.code).toBe("CONFLICT");
  });

  it("accepts the flat spelling of a proof as well as the nested one", async () => {
    const { payload } = await register({ name: `flat${tag()}` });
    const keys = generateKeypair();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(payload.api_key)}` },
      // The four fields written out by hand, rather than nested under
      // `public_key`. Both mean the same thing and both must work.
      payload: bindProof(keys, String(payload.agent_id)),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { public_key: string }).public_key).toBe(keys.publicKey);
  });

  it("says what is missing when a bind carries no proof at all", async () => {
    const { payload } = await register({ name: `empty${tag()}` });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/me/keys/bind",
      headers: { authorization: `Bearer ${String(payload.api_key)}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toContain("public_key");
  });
});

/**
 * The minimap's neighbour service, hung.
 *
 * A separate describe with its own server, because the breaker is process-wide
 * state: once it has been opened by the hung socket below, every later minimap
 * call in this file would be served from it.
 */
describe.skipIf(!hasDb)("a hung Paperclip does not stall the public map", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  let server: net.Server;
  /**
   * HTTP requests that actually reached Paperclip, NOT TCP connections.
   *
   * They are not the same thing: when undici aborts a request it destroys the
   * socket and its pool immediately opens a replacement, so a single aborted
   * fetch shows up as two connections and only one request. Counting sockets
   * here would have measured undici's pool, not Grove's behaviour.
   */
  let requests = 0;
  let originBefore: string | undefined;

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the routes wiring suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    app = await buildApp(new GroveApp(pg, redis, config));

    // Accepts the socket and then says nothing, ever: the exact failure that
    // used to cost the route its full 1.5 s timeout on every single poll.
    server = net.createServer((socket) => {
      let counted = false;
      socket.on("data", () => {
        if (counted) return;
        counted = true;
        requests += 1;
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    originBefore = process.env.PAPERCLIP_ORIGIN;
    process.env.PAPERCLIP_ORIGIN = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (originBefore === undefined) delete process.env.PAPERCLIP_ORIGIN;
    else process.env.PAPERCLIP_ORIGIN = originBefore;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app?.close();
    await redis.quit();
    await pg.end();
  });

  it("asks a dead Paperclip once, not once per poll, and degrades in place", async () => {
    const first = await app.inject({ method: "GET", url: "/api/v1/world/minimap" });
    expect(first.statusCode).toBe(200);
    // The degraded payload is the one a live failure already produced, so the
    // map simply shows no Paperclip bodies. Nothing about the shape changes.
    expect((first.json() as { paperclip: unknown }).paperclip).toEqual({
      ok: false,
      agents: [],
      issues: [],
    });
    expect(requests).toBe(1);

    // Three more polls, the way the landing page makes them. None of them may
    // reach Paperclip again while the breaker is open, and none may pay its
    // timeout: that is the difference between one slow request and one slow
    // request per viewer per 8 seconds.
    const started = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "GET", url: "/api/v1/world/minimap" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { paperclip: { ok: boolean } }).paperclip.ok).toBe(false);
    }
    expect(requests).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 20_000);
});
