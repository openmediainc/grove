/**
 * Preview before claiming (queue #48) through the real routes:
 *  - the preview is read-only: it creates nothing and holds nothing;
 *  - a private neighbour comes back as a held plot (no name, orgs or branding);
 *  - create re-validates what was previewed: bad branding creates nothing, good
 *    branding lands with the row, and a stale previewed plot is reported.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import { assertTestDatabase, createFixtures, hasTestDatabase, warnIfNotTestDatabase } from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("claim preview routes suite");

type Preview = {
  plot_index: number;
  ring: number;
  neighbours: Array<{ plot_index: number; policy_preset: string; name: string | null; orgs: unknown[]; branding: unknown }>;
};

describe.skipIf(!hasDb)("claim preview routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the claim preview routes suite");
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

  const slug = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

  async function create(cookie: string, payload: Record<string, unknown>) {
    const r = await app.inject({ method: "POST", url: "/api/v1/worlds", headers: { cookie }, payload });
    if (r.statusCode === 201) fixtures.trackWorld((r.json() as { world: { id: string } }).world.id);
    return r;
  }

  it("is signed-in only, and reads without creating or holding anything", async () => {
    const unsigned = await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview" });
    expect(unsigned.statusCode).toBe(401);

    const me = await signIn("cpread");
    const t0 = new Date();
    const r = await app.inject({ method: "GET", url: "/api/v1/spaces/claim-preview", headers: { cookie: me.cookie } });
    expect(r.statusCode).toBe(200);
    const p = (r.json() as { preview: Preview }).preview;
    expect(Number.isInteger(p.plot_index)).toBe(true);
    expect(p.ring).toBeGreaterThanOrEqual(2);

    // Nothing was written for this person, and the plot is still free (or was
    // taken by a claim that landed after the preview, from another suite).
    const mine = await pg.query(`SELECT 1 FROM worlds WHERE owner_human_id = $1`, [me.id]);
    expect(mine.rowCount).toBe(0);
    const holder = await pg.query<{ created_at: Date }>(`SELECT created_at FROM worlds WHERE plot_index = $1`, [p.plot_index]);
    if (holder.rowCount) expect(holder.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1000);
    // The same read as the allocator.
    expect(await grove.campus.nextPlotIndex()).toBeGreaterThanOrEqual(0);
  });

  it("shows a private neighbour as a held plot: no name, orgs or branding anywhere in the payload", async () => {
    const owner = await signIn("cppriv");
    const hidden = await create(owner.cookie, {
      name: "Sealed Vault Zq",
      slug: slug("cp-sealed"),
      policy_preset: "private",
      branding: { accent: "#7dd3fc", sign_text: "Secret sign Zq", emblem: "leaf" },
    });
    expect(hidden.statusCode).toBe(201);
    const hiddenPlot = (hidden.json() as { world: { plot_index: number } }).world.plot_index;
    const open = await create(owner.cookie, { name: "Open Porch Zq", slug: slug("cp-open"), policy_preset: "public_write" });
    expect(open.statusCode).toBe(201);
    const openPlot = (open.json() as { world: { plot_index: number } }).world.plot_index;

    const viewer = await signIn("cpview");
    const r = await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview", headers: { cookie: viewer.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("Sealed Vault Zq");
    expect(r.body).not.toContain("Secret sign Zq");
    const p = (r.json() as { preview: Preview }).preview;
    const held = p.neighbours.find((n) => n.plot_index === hiddenPlot);
    if (held) expect(held).toEqual({ plot_index: hiddenPlot, policy_preset: "private", name: null, orgs: [], branding: null });
    const pub = p.neighbours.find((n) => n.plot_index === openPlot);
    if (pub) expect(pub.name).toBe("Open Porch Zq");
    // Even the owner of the private plot gets it held here: this is the public map.
    const own = await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview", headers: { cookie: owner.cookie } });
    expect(own.body).not.toContain("Sealed Vault Zq");
  });

  it("create re-validates branding before writing anything, and keeps what was previewed", async () => {
    const me = await signIn("cpmake");
    const badSlug = slug("cp-bad");
    const bad = await create(me.cookie, { name: "Bad Brand", slug: badSlug, policy_preset: "public_view", branding: { emblem: "not-an-emblem" } });
    expect(bad.statusCode).toBe(400);
    const none = await pg.query(`SELECT 1 FROM worlds WHERE slug = $1`, [badSlug]);
    expect(none.rowCount).toBe(0);
    const notObject = await create(me.cookie, { name: "Bad Brand", slug: badSlug, branding: "sky" });
    expect(notObject.statusCode).toBe(400);

    const goodSlug = slug("cp-good");
    const good = await create(me.cookie, {
      name: "Good Brand",
      slug: goodSlug,
      policy_preset: "public_view",
      branding: { accent: "#7dd3fc", sign_text: "Open late", emblem: "leaf" },
    });
    expect(good.statusCode).toBe(201);
    const world = (good.json() as { world: { id: string; policy_preset: string } }).world;
    expect(world.policy_preset).toBe("public_view");
    const stored = await app.inject({ method: "GET", url: `/api/v1/worlds/${world.id}/branding`, headers: { cookie: me.cookie } });
    expect((stored.json() as { branding: unknown }).branding).toEqual({ accent: "#7dd3fc", sign_text: "Open late", emblem: "leaf" });
    // No expected index sent: no plot verdict either.
    expect(good.json()).not.toHaveProperty("plot_changed");
  });

  it("reports when the previewed plot was claimed first", async () => {
    const first = await signIn("cpfirst");
    const second = await signIn("cpsecond");
    const seen = (
      (await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview", headers: { cookie: second.cookie } })).json() as {
        preview: Preview;
      }
    ).preview.plot_index;
    // Someone else claims first.
    const theirs = await create(first.cookie, { name: "First Come", slug: slug("cp-first") });
    expect(theirs.statusCode).toBe(201);
    const takenPlot = (theirs.json() as { world: { plot_index: number } }).world.plot_index;

    const mine = await create(second.cookie, { name: "Second Come", slug: slug("cp-second"), expected_plot_index: takenPlot });
    expect(mine.statusCode).toBe(201);
    const j = mine.json() as { world: { plot_index: number }; expected_plot_index: number; plot_changed: boolean };
    expect(j.expected_plot_index).toBe(takenPlot);
    expect(j.plot_changed).toBe(true);
    expect(j.world.plot_index).not.toBe(takenPlot);
    expect(seen).toBeGreaterThanOrEqual(0);
  });

  it("allows 60 previews an hour per person", async () => {
    const me = await signIn("cplimit");
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview", headers: { cookie: me.cookie } });
      expect(r.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: "GET", url: "/api/v1/worlds/claim-preview", headers: { cookie: me.cookie } });
    expect(limited.statusCode).toBe(429);
  });

  it("suggests branding before a space exists: signed in, and private addresses refused", async () => {
    const unsigned = await app.inject({ method: "POST", url: "/api/v1/spaces/branding/suggest", payload: { url: "https://example.com" } });
    expect(unsigned.statusCode).toBe(401);
    const me = await signIn("cpsugg");
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/spaces/branding/suggest",
      headers: { cookie: me.cookie },
      payload: { url: "http://127.0.0.1/" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/not a public website/);
  });
});
