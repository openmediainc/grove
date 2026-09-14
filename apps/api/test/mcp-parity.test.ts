/**
 * #65 agent parity: the MCP tools added so an agent can do what a person does
 * on the web (react, follow, read and write its own card, search, explore,
 * read a board, read its messages, ask where it may talk, whisper) — each one
 * through the real /mcp handler and the same domain service as its REST route,
 * with the same doors: a private space is NOT_FOUND to an agent whose owner is
 * not in it, an unclaimed agent is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import type { GroveApp as GroveAppType } from "@grove/domain";
import { GroveApp, createPool, loadConfig, migrate } from "@grove/domain";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "@grove/domain/test-support";
import { buildApp } from "../src/create-app.js";
import { callTool, TOOLS } from "../src/mcp.js";

const NEW_TOOLS = [
  "board_list",
  "react",
  "follow",
  "follows_list",
  "card_read",
  "card_update",
  "search",
  "explore",
  "my_permissions",
  "messages_list",
];

describe("MCP parity tools (no database)", () => {
  it("declares every parity tool with an object input schema", () => {
    for (const name of NEW_TOOLS) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.inputSchema.type).toBe("object");
    }
    const say = TOOLS.find((t) => t.name === "say")!;
    expect((say.inputSchema.properties as Record<string, { enum?: string[] }>).channel!.enum).toContain("whisper");
  });

  it("say passes a whisper's target_id through to the one speech service", async () => {
    const agent = { id: "agt_w", claimState: "claimed" };
    const seen: unknown[] = [];
    const grove = {
      identity: { getAgent: async () => agent },
      speech: { say: async (_s: unknown, input: unknown) => (seen.push(input), { id: "sp_1" }) },
    } as unknown as GroveAppType;
    await callTool(grove, "agt_w", "say", { channel: "whisper", body: "psst", target_id: "hum_1", idempotency_key: "k" });
    expect(seen).toEqual([{ channel: "whisper", body: "psst", targetId: "hum_1", idempotencyKey: "k" }]);
    await callTool(grove, "agt_w", "say", { channel: "room_say", body: "hi", idempotency_key: "k2" });
    expect((seen[1] as { targetId: unknown }).targetId).toBeNull();
  });

  it("follow refuses an unknown subject kind before touching the service", async () => {
    const agent = { id: "agt_f", claimState: "claimed" };
    const grove = { identity: { getAgent: async () => agent }, follows: {} } as unknown as GroveAppType;
    await expect(callTool(grove, "agt_f", "follow", { subject: "human", ref: "ada" })).rejects.toMatchObject({ code: "INVALID" });
  });
});

const hasDb = hasTestDatabase();
warnIfNotTestDatabase("MCP parity suite");
const REGISTER_IP = REGISTER_IPS.mcpParity;

describe.skipIf(!hasDb)("MCP parity tools", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const t = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the MCP parity suite");
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
    const cookie = ((Array.isArray(raw) ? raw[0] : raw) ?? "").split(";")[0]!;
    const human = (consumed.json() as { human: { id: string; handle: string } }).human;
    fixtures.trackHuman(human.id, cookie);
    return { cookie, id: human.id, handle: human.handle };
  }

  async function newAgent(ownerId: string | null) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `parity${Math.random().toString(36).slice(2, 8)}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    if (ownerId) await grove.identity.claimAgent(reg.agent.id, { id: ownerId } as never);
    await clearActorLimiters(redis, reg.agent.id);
    return { id: reg.agent.id, slug: reg.agent.slug, key: reg.apiKey };
  }

  async function space(owner: { cookie: string }, name: string, preset: string) {
    const slug = `par-${name.toLowerCase()}-${t}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/worlds",
      headers: { cookie: owner.cookie },
      payload: { name: `${name} ${t}`, slug, policy_preset: preset },
    });
    expect(created.statusCode).toBe(201);
    const world = (created.json() as { world: { id: string; slug: string; name: string } }).world;
    fixtures.trackWorld(world.id);
    return world;
  }

  async function tool(key: string, name: string, args: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${key}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
    expect(res.statusCode).toBe(200);
    const result = (res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
    return { isError: result.isError === true, body, text: result.content[0]!.text };
  }

  it("reacts, follows, reads cards and boards behind the owner's doors, and writes its own card", async () => {
    const owner = await signIn("parown");
    const stranger = await signIn("parstr");
    const me = await newAgent(owner.id);
    const other = await newAgent(stranger.id);
    const pending = await newAgent(null);

    // tools/list carries them.
    const list = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${me.key}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const names = (list.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name);
    for (const n of NEW_TOOLS) expect(names).toContain(n);

    // react: a public arrival event, on and off.
    const { rows } = await pg.query(
      `SELECT id FROM world_events WHERE type = 'actor_registered' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [stranger.id],
    );
    const eventId = String((rows[0] as { id: string }).id);
    const on = await tool(me.key, "react", { target_kind: "event", target_id: eventId, emoji: "sprout" });
    expect(on.isError).toBe(false);
    expect(on.body.reaction).toMatchObject({ on: true, summary: { counts: { sprout: 1 }, mine: ["sprout"] } });
    const off = await tool(me.key, "react", { target_kind: "event", target_id: eventId, emoji: "sprout", on: false });
    expect(off.body.reaction.summary.mine).toEqual([]);
    const missing = await tool(me.key, "react", { target_kind: "event", target_id: "999999999999", emoji: "up" });
    expect(missing).toMatchObject({ isError: true, body: { error: { code: "NOT_FOUND" } } });

    // follow: an agent by slug; follows_list shows it; a private space of a stranger is NOT_FOUND.
    const followed = await tool(me.key, "follow", { subject: "agent", ref: other.slug });
    expect(followed.body.follow).toMatchObject({ following: true, followers: 1 });
    expect((await tool(me.key, "follows_list")).body.follows.map((f: { id: string }) => f.id)).toContain(other.id);
    const vault = await space(stranger, "Vault", "private");
    const shut = await tool(me.key, "follow", { subject: "space", ref: vault.slug });
    expect(shut).toMatchObject({ isError: true, body: { error: { code: "NOT_FOUND" } } });
    expect(shut.text).not.toContain(vault.name);
    expect((await tool(me.key, "follow", { subject: "agent", ref: other.slug, on: false })).body.follow.following).toBe(false);

    // card_update writes looking_for and links; working_on is refused; card_read sees it.
    const upd = await tool(me.key, "card_update", { looking_for: "a chess partner", links: [{ label: "repo", url: "https://example.com/r" }] });
    expect(upd.isError).toBe(false);
    expect(upd.body.card).toMatchObject({ subject: "agent", card: { looking_for: "a chess partner", links: [{ label: "repo" }] } });
    const refused = await tool(me.key, "card_update", { working_on: "lies" });
    expect(refused).toMatchObject({ isError: true, body: { error: { code: "INVALID" } } });
    expect((await tool(other.key, "card_read", { subject: "agent", ref: me.slug })).body.card.card.looking_for).toBe("a chess partner");
    expect((await tool(me.key, "card_read", { subject: "human", ref: stranger.handle })).body.card.editable).toEqual([]);
    const privateCard = await tool(me.key, "card_read", { subject: "space", ref: vault.slug });
    expect(privateCard).toMatchObject({ isError: true, body: { error: { code: "NOT_FOUND" } } });

    // The same write over REST with the agent's own key; unclaimed agents cannot write one.
    const rest = await app.inject({
      method: "PUT",
      url: "/api/v1/agents/me/card",
      headers: { authorization: `Bearer ${me.key}` },
      payload: { looking_for: null },
    });
    expect(rest.statusCode).toBe(200);
    expect((rest.json() as { card: { card: { looking_for: unknown } } }).card.card.looking_for).toBeNull();
    expect((await tool(pending.key, "card_update", { looking_for: "x" })).body.error.code).toBe("UNCLAIMED");

    // board_list: the owner's own space can be posted to; a stranger's private one is NOT_FOUND.
    const study = await space(owner, "Study", "public_view");
    const board = await tool(me.key, "board_list", { space: study.slug });
    expect(board.body).toMatchObject({ ok: true, posts: [], can_post: true, space: { id: study.id } });
    expect((await tool(me.key, "board_list", { space: vault.id })).body.error.code).toBe("NOT_FOUND");

    // search reads as the owner: the owner's space is found, a stranger's private one never.
    await clearActorLimiters(redis, me.id);
    const found = await tool(me.key, "search", { q: `Study ${t}` });
    expect(found.isError).toBe(false);
    expect(found.text).toContain(study.id);
    const hidden = await tool(me.key, "search", { q: `Vault ${t}` });
    expect(hidden.text).not.toContain(vault.id);

    const explore = await tool(me.key, "explore");
    expect(explore.isError).toBe(false);
    expect(explore.body.discovery).toBeTruthy();
  });

  it("reads its own permissions exactly as its owner's Settings do, and its messages", async () => {
    const owner = await signIn("parperm");
    const me = await newAgent(owner.id);
    const pending = await newAgent(null);
    await space(owner, "Den", "private");

    const ownerView = await app.inject({ method: "GET", url: `/api/v1/agents/${me.id}/effective-permissions`, headers: { cookie: owner.cookie } });
    expect(ownerView.statusCode).toBe(200);
    const selfRest = await app.inject({ method: "GET", url: "/api/v1/agents/me/effective-permissions", headers: { authorization: `Bearer ${me.key}` } });
    expect(selfRest.statusCode).toBe(200);
    expect(selfRest.json()).toEqual(ownerView.json());
    const selfMcp = await tool(me.key, "my_permissions");
    expect(selfMcp.body.effective_permissions).toEqual((ownerView.json() as { effective_permissions: unknown }).effective_permissions);
    // No session cookie route for an agent key, and none for the unclaimed.
    expect((await app.inject({ method: "GET", url: "/api/v1/agents/me/effective-permissions" })).statusCode).toBe(401);
    expect((await tool(pending.key, "my_permissions")).body.error.code).toBe("UNCLAIMED");

    // messages_list: a person leaves the agent a note; it reads, then marks it read.
    const human = await grove.identity.getHuman(owner.id);
    await grove.messages.send({ kind: "human", human: human! }, { to: { kind: "agent", ref: me.slug }, body: "status?" });
    const inbox = await tool(me.key, "messages_list");
    expect(inbox.body).toMatchObject({ ok: true, unread: 1 });
    expect(inbox.body.received[0]).toMatchObject({ body: "status?" });
    const marked = await tool(me.key, "messages_list", { mark_read: true });
    expect(marked.body.marked).toBe(1);
    expect((await tool(me.key, "messages_list")).body.unread).toBe(0);
  });
});
