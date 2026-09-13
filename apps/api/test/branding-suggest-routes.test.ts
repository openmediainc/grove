/**
 * Branding suggestions from a website (queue #34) through the real routes:
 * owner only (404 otherwise, 401 signed out), private addresses refused before
 * any network, 10 an hour per person, and a suggestion saves nothing.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, isBlockedAddress, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("branding suggest routes suite");

describe.skipIf(!hasDb)("branding suggest routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  let site: http.Server;
  let sitePort = 0;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the branding suggest routes suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    app = await buildApp(grove);
    site = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<title>Harbour Lights | Home</title><meta name="theme-color" content="#1e3a8a">`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    sitePort = (site.address() as AddressInfo).port;
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      site?.closeAllConnections();
      await new Promise<void>((r) => (site ? site.close(() => r()) : r()));
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

  async function space(owner: { cookie: string }, preset = "public_view") {
    const slug = `sugg-${Math.random().toString(36).slice(2, 8)}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: "Suggest Harbour", slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const worldId = (created.json() as { world: { id: string } }).world.id;
    fixtures.trackWorld(worldId);
    return { worldId, slug };
  }

  it("owner only; private and malformed addresses refused with a reason, before any fetch", async () => {
    const owner = await signIn("suggown");
    const stranger = await signIn("suggnosy");
    const { worldId } = await space(owner, "private");
    const url = `/api/v1/spaces/${worldId}/branding/suggest`;

    const unsigned = await app.inject({ method: "POST", url, payload: { url: "https://example.com" } });
    expect(unsigned.statusCode).toBe(401);
    const nosy = await app.inject({ method: "POST", url, headers: { cookie: stranger.cookie }, payload: { url: "https://example.com" } });
    expect(nosy.statusCode).toBe(404);

    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/", "http://[::1]/", "http://10.0.0.1/"]) {
      const r = await app.inject({ method: "POST", url, headers: { cookie: owner.cookie }, payload: { url: target } });
      expect(r.statusCode, target).toBe(400);
      expect(r.body).toMatch(/not a public website/);
    }
    const junk = await app.inject({ method: "POST", url, headers: { cookie: owner.cookie }, payload: { url: "not a url" } });
    expect(junk.statusCode).toBe(400);
    expect(junk.body).toMatch(/Enter a website address/);
  });

  it("suggests from a site without saving, and the /worlds alias answers the same", async () => {
    const owner = await signIn("suggok");
    const { worldId, slug } = await space(owner);
    const prev = grove.branding.siteFetchOptions;
    grove.branding.siteFetchOptions = {
      ports: "any",
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
    };
    try {
      const r = await app.inject({
        method: "POST",
        url: `/api/v1/worlds/${slug}/branding/suggest`,
        headers: { cookie: owner.cookie },
        payload: { url: `http://harbour.test:${sitePort}/` },
      });
      expect(r.statusCode).toBe(200);
      const j = r.json() as { name: string; accent: { accent: string; substituted: boolean; note: string }; source: { theme_color: string; accent_from: string } };
      expect(j.name).toBe("Harbour Lights");
      expect(j.accent).toMatchObject({ accent: "#a5b4fc", substituted: true });
      expect(j.accent.note).toMatch(/Periwinkle/);
      expect(j.source).toMatchObject({ theme_color: "#1e3a8a", accent_from: "theme_color" });
    } finally {
      grove.branding.siteFetchOptions = prev;
    }
    const stored = await app.inject({ method: "GET", url: `/api/v1/worlds/${worldId}/branding`, headers: { cookie: owner.cookie } });
    expect((stored.json() as { branding: unknown }).branding).toBeNull();
  });

  it("allows 10 reads an hour per person, then 429 with Retry-After", async () => {
    const owner = await signIn("sugglimit");
    const { worldId } = await space(owner);
    const url = `/api/v1/spaces/${worldId}/branding/suggest`;
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: "POST", url, headers: { cookie: owner.cookie }, payload: { url: "http://127.0.0.1/" } });
      expect(r.statusCode).toBe(400);
    }
    const limited = await app.inject({ method: "POST", url, headers: { cookie: owner.cookie }, payload: { url: "http://127.0.0.1/" } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(60);
    // Someone else is not limited by it.
    const other = await signIn("suggother");
    const theirs = await space(other);
    const ok = await app.inject({
      method: "POST",
      url: `/api/v1/spaces/${theirs.worldId}/branding/suggest`,
      headers: { cookie: other.cookie },
      payload: { url: "http://127.0.0.1/" },
    });
    expect(ok.statusCode).toBe(400);
  });
});
