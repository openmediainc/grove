/**
 * MCP `send_message` through the real /mcp handler and the real MessageService:
 * the same route rules as POST /api/v1/messages, answered as MCP tool results.
 *
 *  - a claimed agent leaves a message for a person by handle; it lands in their inbox;
 *  - a retried idempotency_key is the same message;
 *  - nobody is NOT_FOUND; an unclaimed agent is refused by the kernel;
 *  - a refusal is the kernel's own words with its attribution, and a recipient
 *    standing in a private space is never named by it;
 *  - a block is unattributed; the write limiter refuses before anything is stored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
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

const REGISTER_IP = REGISTER_IPS.mcpMessages;
const hasDb = hasTestDatabase();
warnIfNotTestDatabase("MCP messages suite");

describe.skipIf(!hasDb)("MCP send_message", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the MCP messages suite");
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

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    return human;
  }

  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, claim = true) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `courier-${tag()}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    if (claim) await grove.identity.claimAgent(reg.agent.id, owner);
    await clearActorLimiters(redis, reg.agent.id);
    return { id: reg.agent.id, key: reg.apiKey };
  }

  async function sendMessage(key: string, args: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${key}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: args } },
    });
    expect(res.statusCode).toBe(200);
    const result = (res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    return { isError: result.isError === true, text: result.content[0]!.text, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }

  it("is listed, sends to a person's inbox, and a retry is the same message", async () => {
    const list = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${(await newAgent(await newHuman("mcpmsg-lister"))).key}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect((list.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toContain("send_message");

    const owner = await newHuman("mcpmsg-owner");
    const reader = await newHuman("mcpmsg-reader");
    const agent = await newAgent(owner);
    const idem = `mcp-${tag()}`;
    const first = await sendMessage(agent.key, { to: { kind: "human", ref: `@${reader.handle}` }, body: "hello from mcp", idempotency_key: idem });
    expect(first.isError).toBe(false);
    expect(first.body.ok).toBe(true);
    expect(first.body.message).toMatchObject({ body: "hello from mcp", to: { kind: "human", ref: reader.handle }, from: { kind: "agent" }, reply_to: null });
    const again = await sendMessage(agent.key, { to: { kind: "human", ref: reader.handle }, body: "hello from mcp", idempotency_key: idem });
    expect(again.body.message.id).toBe(first.body.message.id);
    const inbox = await grove.messages.inbox({ kind: "human", human: reader });
    expect(inbox.received.map((m) => m.id)).toEqual([first.body.message.id]);

    // Their reply comes back as a mailbox item; the agent answers it with reply_to.
    const reply = await grove.messages.send({ kind: "human", human: reader }, { to: { kind: "agent", ref: agent.id }, body: "hi agent" });
    const answer = await sendMessage(agent.key, { to_kind: "human", to_ref: reader.handle, body: "got it", reply_to: reply.id });
    expect(answer.isError).toBe(false);
    expect(answer.body.message.reply_to).toBe(reply.id);
  });

  it("refuses in the kernel's words: nobody, bad input, unclaimed", async () => {
    const owner = await newHuman("mcpmsg-refuse");
    const agent = await newAgent(owner);
    const nobody = await sendMessage(agent.key, { to: { kind: "human", ref: `nobody${Date.now()}` }, body: "hi" });
    expect(nobody.isError).toBe(true);
    expect(nobody.body.error).toEqual({ code: "NOT_FOUND", message: "Not found." });
    const bad = await sendMessage(agent.key, { to: { kind: "space", ref: "x" }, body: "hi" });
    expect(bad.body.error.code).toBe("INVALID");

    const pending = await newAgent(owner, false);
    const unclaimed = await sendMessage(pending.key, { to: { kind: "human", ref: owner.handle }, body: "hi" });
    expect(unclaimed.isError).toBe(true);
    expect(unclaimed.body.error).toMatchObject({ code: "UNCLAIMED", message: "Unclaimed agents cannot leave messages." });
  });

  it("never names the private space a recipient stands in, even when refusing", async () => {
    const owner = await newHuman("mcpmsg-priv-owner");
    const member = await newHuman("mcpmsg-priv-member");
    const name = `Hidden ${tag()}`;
    const space = await grove.campus.createWorld(owner, { name, slug: `hidden-${tag()}`, preset: "private" });
    fixtures.trackWorld(space.id);
    await grove.campus.addMember(space.id, member.id);
    await grove.presence.enter({ id: member.id, kind: "human" }, `${space.id}:plaza`, {
      connection: "async",
      mode: "active",
      activity: "idle",
      worldId: space.id,
    });

    const sender = await newHuman("mcpmsg-priv-sender");
    const agent = await newAgent(sender);
    const ok = await sendMessage(agent.key, { to: { kind: "human", ref: member.handle }, body: "where are you?" });
    expect(ok.isError).toBe(false);
    for (const leak of [space.id, space.slug, name]) expect(ok.text).not.toContain(leak);

    await grove.identity.patchPolicy(agent.id, sender, { speakToHumans: false });
    const denied = await sendMessage(agent.key, { to: { kind: "human", ref: member.handle }, body: "still?" });
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toMatchObject({
      code: "PERMISSION_DENIED",
      message: "Owner has not granted speakToHumans.",
      capability: "speak_to_humans",
      source: "actor",
      subject: "sender",
    });
    expect(denied.body.error.membership).toBeUndefined();
    for (const leak of [space.id, space.slug, name, "space", "room"]) expect(denied.text).not.toContain(leak);
  });

  it("a block is unattributed; the write limiter refuses before anything is stored", async () => {
    const owner = await newHuman("mcpmsg-block-owner");
    const blocker = await newHuman("mcpmsg-blocker");
    const agent = await newAgent(owner);
    await grove.moderation.block(blocker, agent.id);
    const blocked = await sendMessage(agent.key, { to: { kind: "human", ref: blocker.handle }, body: "hi" });
    expect(blocked.body.error).toEqual({ code: "BLOCKED", message: "Blocked." });

    const reader = await newHuman("mcpmsg-limit");
    await redis.set(`ratelimit:${agent.id}:write:min`, "30", "EX", 60);
    const limited = await sendMessage(agent.key, { to: { kind: "human", ref: reader.handle }, body: "flood" });
    expect(limited.isError).toBe(true);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    await clearActorLimiters(redis, agent.id);
    expect((await grove.messages.inbox({ kind: "human", human: reader })).received).toEqual([]);
  });
});
