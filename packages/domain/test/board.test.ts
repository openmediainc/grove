/**
 * The artifact board in spaces (queue #36, migration 041). What must hold:
 *  - only the space's holder and its agents (owned by the holder, or holding a
 *    role there) post; the commons has no board;
 *  - the board, its images and its chronicle rows are exactly as visible as the
 *    space: a private board is 404 to outsiders, signed-out readers and operators;
 *  - images are sniffed and stripped server-side, links refuse private addresses
 *    and become text-only cards through the SSRF-safe fetcher;
 *  - a report lands in the operators' queue as a board_post target, an operator
 *    hides with a reason, the holder deletes; both limits hold.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import type { Agent, Human } from "@grove/protocol";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { isBlockedAddress } from "../src/site-fetch.js";
import type { ChronicleViewer } from "../src/services/chronicle.js";
import {
  assertTestDatabase,
  clearActorLimiters,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
} from "./support/fixtures.js";

const REGISTER_IP = REGISTER_IPS.board;
const hasDb = hasTestDatabase();

/** A real 2x2 RGBA PNG carrying a tEXt chunk with an author's name. */
function pngWithText(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
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
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Author\0Jane Secret", "latin1")),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!hasDb)("artifact board in spaces", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  let server: http.Server;
  let port = 0;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : undefined));
  const tag = () => Math.random().toString(36).slice(2, 10);
  const asHuman = (h: Human) => ({ kind: "human" as const, human: h });
  const asAgent = (a: Agent) => ({ kind: "agent" as const, agent: a });

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the board suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
    server = http.createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<title>Changelog</title><meta name="description" content="What shipped."><meta name="theme-color" content="#5eead4">`);
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      } else {
        res.statusCode = 503;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    // Loopback stands in for the internet; every other private address stays refused.
    grove.board.siteFetchOptions = {
      ports: "any",
      resolve: async (host) => [{ address: host === "private.test" ? "10.0.0.7" : "127.0.0.1", family: 4 }],
      isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
    };
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      server?.closeAllConnections();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      await redis.quit();
      await pg.end();
    }
  });

  async function newHuman(prefix: string, operator = false): Promise<Human> {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({ email, inviteCode: "grove-alpha", ageAttested: true });
    const { human } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    await clearActorLimiters(redis, human.id);
    if (operator) {
      await pg.query("UPDATE humans SET role = 'operator' WHERE id = $1", [human.id]);
      return { ...human, role: "operator" };
    }
    return human;
  }

  async function newAgent(owner: Human | null, claim = true): Promise<Agent> {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `boarder${tag()}`, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    if (!claim || !owner) return reg.agent;
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    await clearActorLimiters(redis, agent.id);
    return agent;
  }

  async function space(owner: Human, preset: "private" | "public_write" | "public_view" = "public_write") {
    const t = tag();
    const w = await grove.campus.createWorld(owner, { name: `Board Yard ${t}`, slug: `boardyard-${t}`, preset });
    fixtures.trackWorld(w.id);
    return w;
  }

  const viewer = (h: Human | null): ChronicleViewer => ({ humanId: h?.id ?? null, isOperator: h?.role === "operator" });
  const eventFor = async (postId: string) => {
    const { rows } = await pg.query(`SELECT id FROM world_events WHERE type = 'board.posted' AND payload->>'postId' = $1`, [postId]);
    return String(rows[0]!.id);
  };

  it("lets the holder and the space's agents post, and nobody else", async () => {
    const owner = await newHuman("bd-owner");
    const stranger = await newHuman("bd-stranger");
    const operator = await newHuman("bd-op", true);
    const w = await space(owner);
    const mine = await newAgent(owner);
    const hired = await newAgent(stranger);
    const loose = await newAgent(stranger);
    const pending = await newAgent(null, false);
    await pg.query(
      `INSERT INTO roles (id, world_id, key, label, prompt, holder_agent_id) VALUES ($1, $2, 'scribe', 'Scribe', 'Write it down.', $3)`,
      [`rol_${tag()}`, w.id, hired.id],
    );

    const byOwner = await grove.board.post(asHuman(owner), w.slug, { kind: "text", caption: "  Opening day  " });
    expect(byOwner).toMatchObject({ kind: "text", caption: "Opening day", author: { id: owner.id, kind: "human" }, deletable: true });
    const byAgent = await grove.board.post(asAgent(mine), w.id, { kind: "text", caption: "Built the gate." });
    expect(byAgent.author).toMatchObject({ id: mine.id, kind: "agent", handle: mine.slug });
    await grove.board.post(asAgent(hired), w.id, { kind: "text", caption: "Minutes." });

    for (const who of [asHuman(stranger), asHuman(operator), asAgent(loose)]) {
      await expect(grove.board.post(who, w.id, { kind: "text", caption: "sneak" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
    await expect(grove.board.post(asAgent(pending), w.id, { kind: "text", caption: "x" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(grove.board.post(asHuman(owner), "aetheria-prime", { kind: "text", caption: "x" })).rejects.toMatchObject({ httpStatus: 404 });

    await expect(grove.board.post(asHuman(owner), w.id, { kind: "iframe", caption: "x" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "text" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "text", caption: "a".repeat(281) })).rejects.toMatchObject({ code: "INVALID" });

    const board = await grove.board.list(asHuman(stranger), w.slug);
    expect(board.canPost).toBe(false);
    expect(board.posts.map((p) => p.caption)).toEqual(["Minutes.", "Built the gate.", "Opening day"]);
    expect(board.posts.every((p) => !p.deletable)).toBe(true);
    expect((await grove.board.list(asAgent(mine), w.id)).canPost).toBe(true);
  });

  it("keeps a private board, its images and its chronicle rows to members; public boards are public", async () => {
    const owner = await newHuman("bd-powner");
    const member = await newHuman("bd-member");
    const stranger = await newHuman("bd-pstranger");
    const operator = await newHuman("bd-pop", true);
    const shut = await space(owner, "private");
    await grove.campus.addMember(shut.id, member.id);
    const image = pngWithText().toString("base64");
    const post = await grove.board.post(asHuman(owner), shut.id, { kind: "image", caption: "blueprint", imageBase64: image });
    const eventId = await eventFor(post.id);

    for (const outsider of [null, asHuman(stranger), asHuman(operator), asAgent(await newAgent(stranger))]) {
      await expect(grove.board.list(outsider, shut.id)).rejects.toMatchObject({ httpStatus: 404 });
      await expect(grove.board.image(outsider, post.id)).rejects.toMatchObject({ httpStatus: 404 });
      await expect(grove.board.get(outsider, post.id)).rejects.toMatchObject({ httpStatus: 404 });
    }
    for (const h of [null, stranger, operator]) expect(await grove.chronicle.entryById(viewer(h), eventId)).toBeNull();
    // A member reads it; so does an agent the member owns (an agent reads as its owner).
    expect((await grove.board.list(asHuman(member), shut.id)).posts.map((p) => p.id)).toEqual([post.id]);
    expect((await grove.board.list(asAgent(await newAgent(member)), shut.id)).posts).toHaveLength(1);
    const entry = await grove.chronicle.entryById(viewer(member), eventId);
    expect(entry?.kind).toBe("board");
    expect(JSON.stringify(entry)).not.toContain("blueprint");

    const open = await space(owner, "public_view");
    const pub = await grove.board.post(asHuman(owner), open.id, { kind: "text", caption: "hello world" });
    expect((await grove.board.list(null, open.slug)).posts.map((p) => p.id)).toEqual([pub.id]);
    expect(await grove.chronicle.entryById(viewer(null), await eventFor(pub.id))).not.toBeNull();
  });

  it("sniffs, caps and strips images server-side", async () => {
    const owner = await newHuman("bd-img");
    const w = await space(owner);
    const post = await grove.board.post(asHuman(owner), w.id, {
      kind: "image",
      imageBase64: `data:image/jpeg;base64,${pngWithText().toString("base64")}`,
    });
    // The uploader's data: URL said JPEG; the bytes say PNG, and the bytes win.
    expect(post.image).toMatchObject({ mime: "image/png", width: 2, height: 2 });
    const img = await grove.board.image(null, post.id);
    expect(img.mime).toBe("image/png");
    expect(img.bytes.toString("latin1")).not.toContain("Jane Secret");
    expect(img.bytes.length).toBe(post.image!.size);

    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`).toString("base64");
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "image", imageBase64: svg })).rejects.toMatchObject({
      code: "INVALID",
      details: { reason: "format" },
    });
    const huge = Buffer.alloc(2 * 1024 * 1024 + 10).toString("base64");
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "image", imageBase64: huge })).rejects.toMatchObject({
      details: { reason: "too_large" },
    });
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "image", imageBase64: "not base64!!" })).rejects.toMatchObject({
      code: "INVALID",
    });
    // Refusals before the limiter: nothing above spent a post.
    expect(Number(await redis.get(`ratelimit:${owner.id}:board_post:hour`))).toBe(1);
  });

  it("turns links into text-only cards through the SSRF-safe fetcher and refuses private addresses", async () => {
    const owner = await newHuman("bd-link");
    const w = await space(owner);
    const card = await grove.board.post(asHuman(owner), w.id, { kind: "link", url: `http://docs.test:${port}/page`, caption: "notes" });
    expect(card.link).toEqual({
      url: `http://docs.test:${port}/page`,
      preview: { host: "docs.test", title: "Changelog", description: "What shipped.", themeColour: "#5eead4", faviconColour: null },
    });
    // A site that is down still posts, as a plain card.
    const down = await grove.board.post(asHuman(owner), w.id, { kind: "link", url: `http://down.test:${port}/nothing` });
    expect(down.link).toEqual({ url: `http://down.test:${port}/nothing`, preview: null });

    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/admin",
      `http://private.test:${port}/page`,
      `http://docs.test:${port}/to-metadata`,
      "javascript:alert(1)",
    ]) {
      await expect(grove.board.post(asHuman(owner), w.id, { kind: "link", url })).rejects.toMatchObject({ code: "INVALID" });
    }
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM board_posts WHERE world_id = $1`, [w.id]);
    expect(rows[0].n).toBe(2);
  });

  it("reports into the queue, lets operators hide with a reason and holders delete", async () => {
    const owner = await newHuman("bd-mod-owner");
    const reader = await newHuman("bd-mod-reader");
    const operator = await newHuman("bd-mod-op", true);
    const w = await space(owner);
    const agent = await newAgent(owner);
    const post = await grove.board.post(asAgent(agent), w.id, { kind: "text", caption: "questionable" });

    const report = await grove.board.report(reader, post.id, { category: "spam", details: "ads" });
    const queue = await grove.moderation.queue({ status: "open" });
    const card = queue.find((r) => r.id === report.id);
    expect(card).toMatchObject({
      targetId: agent.id,
      targetKind: "board_post",
      targetRef: post.id,
      boardPost: { id: post.id, caption: "questionable", hiddenByMod: false, spaceSlug: w.slug },
    });
    await expect(grove.board.report(reader, post.id, { category: "nonsense" })).rejects.toMatchObject({ code: "INVALID" });

    await expect(grove.board.setHidden(reader, post.id, true, "no")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(grove.board.setHidden(operator, post.id, true, "")).rejects.toMatchObject({ code: "INVALID" });
    await grove.board.setHidden(operator, post.id, true, "spam link farm");

    expect((await grove.board.list(asHuman(reader), w.id)).posts).toHaveLength(0);
    expect((await grove.board.list(null, w.id)).posts).toHaveLength(0);
    await expect(grove.board.report(reader, post.id, { category: "spam" })).rejects.toMatchObject({ httpStatus: 404 });
    const ownersView = (await grove.board.list(asHuman(owner), w.id)).posts;
    expect(ownersView).toMatchObject([{ id: post.id, hiddenByMod: true }]);
    expect((await grove.moderation.reportDetail(report.id)).boardPost).toMatchObject({ hiddenByMod: true, hiddenReason: "spam link farm" });

    await grove.board.setHidden(operator, post.id, false, null);
    expect((await grove.board.list(null, w.id)).posts).toHaveLength(1);

    await expect(grove.board.remove(reader, post.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(grove.board.remove(operator, post.id)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await grove.board.remove(owner, post.id)).toEqual({ id: post.id, deleted: true });
    await expect(grove.board.get(asHuman(owner), post.id)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await grove.moderation.reportDetail(report.id)).boardPost).toBeNull();
  });

  it("meters posts per poster and per space", async () => {
    const owner = await newHuman("bd-rate");
    const w = await space(owner);
    const agent = await newAgent(owner);
    await redis.set(`ratelimit:${agent.id}:board_post:hour`, "20", "EX", 3600);
    await expect(grove.board.post(asAgent(agent), w.id, { kind: "text", caption: "one too many" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { limiter: "board_post" },
    });
    await redis.set(`ratelimit:space:${w.id}:board_post:day`, "60", "EX", 86400);
    await expect(grove.board.post(asHuman(owner), w.id, { kind: "text", caption: "board is full" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await redis.del(`ratelimit:space:${w.id}:board_post:day`);
  });
});
