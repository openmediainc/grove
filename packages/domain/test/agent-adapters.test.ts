/**
 * The adapter registry: how Grove is told to REACH an agent.
 *
 * Two properties, and the suite is split along them:
 *
 *   1. The config is hostile input. It holds URLs and it is written by any
 *      invited inhabitant, so every shape that could aim Grove's own network
 *      position at something — loopback, a private range, a non-web port, a
 *      non-HTTP scheme, a credential smuggled into userinfo or a query string —
 *      has to be refused, by the validator, with a reason. Those tests need no
 *      database and run unconditionally.
 *
 *   2. Owner-only means owner-only, at every one of the three verbs, and a
 *      pinned identity may only ever be this agent's own live key. Those need
 *      real rows.
 *
 * Nothing here dispatches, because nothing dispatches: declaring how an agent
 * is reached is the entire scope.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  ADAPTER_KINDS,
  isAdapterKind,
  parsePaperclipAgentId,
  parseReachUrl,
  validateAdapterConfig,
} from "../src/services/identity.js";
import { bindMessage, generateAgentKeypair, newNonce, signEd25519 } from "../src/crypto.js";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.agentAdapters;

warnIfNotTestDatabase("agent-adapters");

const tag = () => Math.random().toString(36).slice(2, 10);
const GOOD_URL = "https://agent.example.com/grove-hook";
const PAPERCLIP_ID = "d7b11ce5-4ded-460f-beb6-42026d24c7a6";

/**
 * Every rejection is an INVALID that SAYS WHY. Asserting only "it threw" would
 * pass just as happily for a rule that fired for the wrong reason, so match the
 * explanation too — message and hint together, because GroveError splits the
 * refusal across both and the caller is shown both.
 */
function expectRejected(fn: () => unknown, matching: RegExp) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, "expected a rejection, got none").toBeDefined();
  const err = thrown as { code?: string; message?: string; hint?: string };
  expect(err.code).toBe("INVALID");
  expect(`${err.message ?? ""} ${err.hint ?? ""}`).toMatch(matching);
}

describe("adapter config validation refuses everything it should", () => {
  it("knows its own vocabulary and nothing else", () => {
    expect([...ADAPTER_KINDS]).toEqual(["mailbox", "webhook", "mcp", "paperclip"]);
    for (const kind of ADAPTER_KINDS) expect(isAdapterKind(kind)).toBe(true);
    // Paperclip's own kinds, copied over, would be exec primitives here.
    for (const foreign of ["process", "opencode_local", "grok_local", "hermes_local", "http", ""]) {
      expect(isAdapterKind(foreign)).toBe(false);
    }
    expect(isAdapterKind(null)).toBe(false);
  });

  it("accepts a public https endpoint and stores the CANONICAL form", () => {
    expect(validateAdapterConfig("webhook", { url: GOOD_URL })).toEqual({ url: GOOD_URL });
    // The same rules for mcp: one URL rule, two protocols on top of it.
    expect(validateAdapterConfig("mcp", { url: GOOD_URL })).toEqual({ url: GOOD_URL });
    // Explicit :443 is the same destination and normalises away.
    expect(parseReachUrl("https://agent.example.com:443/grove-hook")).toBe(GOOD_URL);
    // Dot segments are resolved before storage, so the validator and the
    // eventual HTTP client can never be parsing two different strings.
    expect(parseReachUrl("https://agent.example.com/a/../grove-hook")).toBe(GOOD_URL);
    // Case in the host is not a second destination.
    expect(parseReachUrl("https://AGENT.example.com/grove-hook")).toBe(GOOD_URL);
  });

  it("refuses every scheme that is not https", () => {
    // The local-file and socket primitives. `unix:` parses perfectly as a URL.
    expectRejected(() => parseReachUrl("file:///etc/passwd"), /must be https/);
    expectRejected(() => parseReachUrl("unix:/var/run/docker.sock"), /must be https/);
    expectRejected(() => parseReachUrl("ftp://agent.example.com/x"), /must be https/);
    expectRejected(() => parseReachUrl("gopher://agent.example.com/x"), /must be https/);
    expectRejected(() => parseReachUrl("ws://agent.example.com/x"), /must be https/);
    expectRejected(() => parseReachUrl("data:text/plain,hello"), /must be https/);
    expectRejected(() => parseReachUrl("javascript:alert(1)"), /must be https/);
    // Plain http, even to a name that would otherwise pass: cleartext to a
    // destination Grove cannot authenticate is not a channel.
    expectRejected(() => parseReachUrl("http://agent.example.com/x"), /must be https/);
    expectRejected(() => parseReachUrl("http://127.0.0.1:5432/x"), /must be https/);
  });

  it("refuses every encoding of an IP address, which is the whole SSRF surface", () => {
    expectRejected(() => parseReachUrl("https://127.0.0.1/x"), /not an IP address/);
    expectRejected(() => parseReachUrl("https://10.0.0.5/x"), /not an IP address/);
    expectRejected(() => parseReachUrl("https://169.254.169.254/latest/meta-data"), /not an IP address/);
    expectRejected(() => parseReachUrl("https://192.168.1.1/x"), /not an IP address/);
    // Decimal and hex spellings of 127.0.0.1, the classic filter bypass.
    expectRejected(() => parseReachUrl("https://2130706433/x"), /not an IP address/);
    expectRejected(() => parseReachUrl("https://0x7f000001/x"), /not an IP address/);
    // IPv6, including the v4-mapped form.
    expectRejected(() => parseReachUrl("https://[::1]/x"), /not an IPv6 literal/);
    expectRejected(() => parseReachUrl("https://[::ffff:127.0.0.1]/x"), /not an IPv6 literal/);
  });

  it("refuses names that only resolve inside somebody else's network", () => {
    expectRejected(() => parseReachUrl("https://localhost/x"), /at least two labels/);
    expectRejected(() => parseReachUrl("https://postgres/x"), /at least two labels/);
    expectRejected(() => parseReachUrl("https://api.localhost/x"), /reserved or internal/);
    expectRejected(() => parseReachUrl("https://grove.local/x"), /reserved or internal/);
    expectRejected(() => parseReachUrl("https://box.internal/x"), /reserved or internal/);
    expectRejected(() => parseReachUrl("https://nas.lan/x"), /reserved or internal/);
    expectRejected(() => parseReachUrl("https://router.home.arpa/x"), /reserved or internal/);
  });

  it("refuses any port but 443, so the registry is not a port scanner", () => {
    for (const port of [22, 25, 3100, 3511, 5432, 6379, 8080, 8443, 9200]) {
      expectRejected(() => parseReachUrl(`https://agent.example.com:${port}/x`), /must be on port 443/);
    }
  });

  it("refuses the places a credential gets smuggled into a URL", () => {
    // userinfo: a credential, AND the classic parser differential where the
    // validator reads one host and the HTTP client dials another.
    expectRejected(() => parseReachUrl("https://user:pw@agent.example.com/x"), /userinfo/);
    expectRejected(() => parseReachUrl("https://trusted.example.com@evil.example.net/x"), /userinfo/);
    expectRejected(() => parseReachUrl("https://agent.example.com/x?token=hunter2"), /query string/);
    expectRejected(() => parseReachUrl("https://agent.example.com/x#secret"), /fragment/);
  });

  it("refuses malformed and oversized URLs", () => {
    expectRejected(() => parseReachUrl("agent.example.com/x"), /absolute URL/);
    expectRejected(() => parseReachUrl("/api/v1/observe"), /absolute URL/);
    expectRejected(() => parseReachUrl(""), /required/);
    expectRejected(() => parseReachUrl(null), /required/);
    expectRejected(() => parseReachUrl(42), /required/);
    expectRejected(() => parseReachUrl(`https://agent.example.com/${"a".repeat(600)}`), /at most 512 characters/);
    expectRejected(() => parseReachUrl(`https://agent.example.com/${"a".repeat(300)}`), /path must be at most/);
    expectRejected(() => parseReachUrl("https://agent.example.com./x"), /empty label/);
    expectRejected(() => parseReachUrl("https://agent..example.com/x"), /empty label/);
    expectRejected(() => parseReachUrl("https://agent_1.example.com/x"), /not a valid DNS label/);
  });

  it("refuses a credential field by name, and any unknown field at all", () => {
    for (const key of [
      "apiKey", "api_key", "authToken", "auth_token", "token", "secret", "password",
      "headers", "authorization", "bearer", "devicePrivateKeyPem", "sessionKeyStrategy", "cookie",
    ]) {
      expectRejected(
        () => validateAdapterConfig("webhook", { url: GOOD_URL, [key]: "x" }),
        /never stores a credential/,
      );
    }
    // Paperclip's own local-runtime fields are exec and local-file primitives
    // here. They are not "unsupported yet"; there is no kind that has them.
    for (const key of ["cwd", "command", "args", "instructionsFilePath", "model", "timeoutSec"]) {
      expectRejected(
        () => validateAdapterConfig("webhook", { url: GOOD_URL, [key]: "x" }),
        /is not a field of the webhook adapter/,
      );
    }
    // JSON.parse makes __proto__ an own property; the sweep refuses it like any
    // other unknown key rather than letting it reach the object build.
    const polluted = JSON.parse('{"url":"https://agent.example.com/grove-hook","__proto__":{"x":1}}');
    expectRejected(() => validateAdapterConfig("webhook", polluted), /is not a field/);
  });

  it("refuses a config that is not an object, and a kind's own missing field", () => {
    expectRejected(() => validateAdapterConfig("webhook", []), /must be a JSON object/);
    expectRejected(() => validateAdapterConfig("webhook", "https://agent.example.com"), /must be a JSON object/);
    expectRejected(() => validateAdapterConfig("webhook", 7), /must be a JSON object/);
    expectRejected(() => validateAdapterConfig("webhook", {}), /url is required/);
    expectRejected(() => validateAdapterConfig("paperclip", {}), /agentId is required/);
  });

  it("gives mailbox no configuration at all", () => {
    expect(validateAdapterConfig("mailbox", {})).toEqual({});
    expect(validateAdapterConfig("mailbox", undefined)).toEqual({});
    expectRejected(() => validateAdapterConfig("mailbox", { url: GOOD_URL }), /takes no configuration at all/);
  });

  it("gives paperclip an id and refuses anything that looks like a destination", () => {
    expect(validateAdapterConfig("paperclip", { agentId: PAPERCLIP_ID })).toEqual({ agentId: PAPERCLIP_ID });
    expect(parsePaperclipAgentId(PAPERCLIP_ID.toUpperCase())).toBe(PAPERCLIP_ID);
    // The point of the kind: the origin is Grove's configuration, not the
    // owner's, so there is nowhere to put one.
    expectRejected(
      () => validateAdapterConfig("paperclip", { agentId: PAPERCLIP_ID, url: "http://127.0.0.1:3100" }),
      /is not a field of the paperclip adapter/,
    );
    expectRejected(() => parsePaperclipAgentId("http://127.0.0.1:3100"), /must be a Paperclip agent UUID/);
    expectRejected(() => parsePaperclipAgentId("../../etc/passwd"), /must be a Paperclip agent UUID/);
    expectRejected(() => parsePaperclipAgentId(""), /must be a Paperclip agent UUID/);
    expectRejected(() => parsePaperclipAgentId(null), /agentId is required/);
  });
});

describe.skipIf(!hasTestDatabase())("the adapter registry is owner-only and identity-aware", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : null));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the agent-adapters suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    try {
      await fixtures.cleanup();
    } finally {
      await redis.quit();
      await pg.end();
    }
  });

  async function newHuman(prefix: string) {
    const email = `${prefix}-${tag()}@example.com`;
    await redis.del(`ratelimit:email:${email.toLowerCase()}:magic:hour`);
    const { token } = await grove.identity.requestMagicLink({
      email,
      inviteCode: "grove-alpha",
      ageAttested: true,
    });
    const { human, sessionId } = await grove.identity.consumeMagicLink(token!);
    fixtures.trackHuman(human.id);
    fixtures.trackSession(sessionId);
    return human;
  }

  /** Register with a keypair bound at creation, so there is a real key id to pin. */
  async function newAgent(owner: Awaited<ReturnType<typeof newHuman>>, opts: { withKey?: boolean } = {}) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const keys = opts.withKey ? generateAgentKeypair() : null;
    const proof = keys
      ? (() => {
          const timestamp = Math.floor(Date.now() / 1000);
          const nonce = newNonce();
          return {
            publicKey: keys.publicKey,
            timestamp,
            nonce,
            signature: signEd25519(
              keys.privateKey,
              bindMessage({ agentId: "", publicKey: keys.publicKey, timestamp, nonce }),
            ),
          };
        })()
      : undefined;
    const reg = await grove.identity.registerAgent(
      { name: `adapter-${tag()}`, description: "fixture", ...(proof ? { publicKey: proof } : {}) },
      REGISTER_IP,
    );
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    return agent;
  }

  async function ed25519KeyId(agentId: string): Promise<string> {
    const keys = await grove.identity.listKeys(agentId);
    const row = keys.find((k) => k.kind === "ed25519");
    expect(row, "expected a bound ed25519 key").toBeDefined();
    return row!.id;
  }

  it("round-trips a declaration, and ships it DISABLED", async () => {
    const owner = await newHuman("owner");
    const agent = await newAgent(owner);
    expect(await grove.identity.getAdapter(agent.id, owner)).toBeNull();

    const saved = await grove.identity.setAdapter(agent.id, owner, {
      kind: "webhook",
      config: { url: GOOD_URL },
    });
    // Declaring where an agent lives is not the same act as arming it.
    expect(saved.enabled).toBe(false);
    expect(saved.kind).toBe("webhook");
    expect(saved.config).toEqual({ url: GOOD_URL });
    expect(saved.verifiedKeyId).toBeNull();
    expect(await grove.identity.getAdapter(agent.id, owner)).toMatchObject({ kind: "webhook", enabled: false });

    expect(await grove.identity.deleteAdapter(agent.id, owner)).toBe(true);
    expect(await grove.identity.getAdapter(agent.id, owner)).toBeNull();
    expect(await grove.identity.deleteAdapter(agent.id, owner)).toBe(false);
  });

  it("keeps exactly one answer to 'how is this agent reached'", async () => {
    const owner = await newHuman("owner");
    const agent = await newAgent(owner);
    await grove.identity.setAdapter(agent.id, owner, { kind: "webhook", config: { url: GOOD_URL }, enabled: true });
    const swapped = await grove.identity.setAdapter(agent.id, owner, {
      kind: "paperclip",
      config: { agentId: PAPERCLIP_ID },
    });
    expect(swapped.kind).toBe("paperclip");
    // The whole declaration is restated, so the previous kind's destination
    // cannot survive as a stale field in the row.
    expect(swapped.config).toEqual({ agentId: PAPERCLIP_ID });
    expect(swapped.enabled).toBe(false);
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM agent_adapters WHERE agent_id = $1`, [agent.id]);
    expect(rows[0].n).toBe(1);
  });

  it("hides an agent it does not own from all three verbs", async () => {
    const owner = await newHuman("owner");
    const stranger = await newHuman("stranger");
    const agent = await newAgent(owner);
    await grove.identity.setAdapter(agent.id, owner, { kind: "webhook", config: { url: GOOD_URL } });

    // 404, not 403: a stranger is not told the agent exists, matching the rest
    // of the ownership surface.
    await expect(grove.identity.getAdapter(agent.id, stranger)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    await expect(
      grove.identity.setAdapter(agent.id, stranger, { kind: "webhook", config: { url: "https://evil.example.net/x" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(grove.identity.deleteAdapter(agent.id, stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // And the stranger's attempt changed nothing.
    expect((await grove.identity.getAdapter(agent.id, owner))!.config).toEqual({ url: GOOD_URL });
  });

  it("refuses an unclaimed agent, which has no owner to be", async () => {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name: `orphan-${tag()}` }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    const anyone = await newHuman("anyone");
    await expect(
      grove.identity.setAdapter(reg.agent.id, anyone, { kind: "mailbox", config: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a kind outside the vocabulary before it can reach the CHECK constraint", async () => {
    const owner = await newHuman("owner");
    const agent = await newAgent(owner);
    for (const kind of ["process", "opencode_local", "http", "", null]) {
      await expect(
        grove.identity.setAdapter(agent.id, owner, { kind, config: {} }),
      ).rejects.toMatchObject({ code: "INVALID" });
    }
  });

  it("carries the config rejections through the service, not just the validator", async () => {
    const owner = await newHuman("owner");
    const agent = await newAgent(owner);
    for (const url of ["http://127.0.0.1:5432/x", "file:///etc/passwd", "https://[::1]/x", "https://10.0.0.5:6379/x"]) {
      await expect(
        grove.identity.setAdapter(agent.id, owner, { kind: "webhook", config: { url } }),
      ).rejects.toMatchObject({ code: "INVALID" });
    }
    await expect(
      grove.identity.setAdapter(agent.id, owner, {
        kind: "webhook",
        config: { url: GOOD_URL, authToken: "aeth_live_dontdothis" },
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    // Nothing partial was written by any of those.
    expect(await grove.identity.getAdapter(agent.id, owner)).toBeNull();
  });

  it("pins only a live Ed25519 key belonging to THIS agent", async () => {
    const owner = await newHuman("owner");
    const mine = await newAgent(owner, { withKey: true });
    const theirs = await newAgent(owner, { withKey: true });
    const myKeyId = await ed25519KeyId(mine.id);
    const theirKeyId = await ed25519KeyId(theirs.id);

    const pinned = await grove.identity.setAdapter(mine.id, owner, {
      kind: "webhook",
      config: { url: GOOD_URL },
      enabled: true,
      verifiedKeyId: myKeyId,
    });
    expect(pinned.verifiedKeyId).toBe(myKeyId);

    // Someone else's key, even one the same human owns. Pinning it would mean
    // asserting an identity claim the pinner has no right to make.
    await expect(
      grove.identity.setAdapter(mine.id, owner, {
        kind: "webhook",
        config: { url: GOOD_URL },
        verifiedKeyId: theirKeyId,
      }),
    ).rejects.toMatchObject({ code: "INVALID" });

    // A bearer token is a credential, but it is not an identity anyone can
    // verify from the outside, so it cannot be pinned either.
    const bearerKeyId = (await grove.identity.listKeys(mine.id)).find((k) => k.kind === "bearer")!.id;
    await expect(
      grove.identity.setAdapter(mine.id, owner, {
        kind: "webhook",
        config: { url: GOOD_URL },
        verifiedKeyId: bearerKeyId,
      }),
    ).rejects.toMatchObject({ code: "INVALID" });

    await expect(
      grove.identity.setAdapter(mine.id, owner, {
        kind: "webhook",
        config: { url: GOOD_URL },
        verifiedKeyId: "key_does_not_exist",
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("shows a dispatcher only armed, claimed adapters — and tells it when a pin went dead", async () => {
    const owner = await newHuman("owner");
    const armed = await newAgent(owner, { withKey: true });
    const idle = await newAgent(owner);
    const keyId = await ed25519KeyId(armed.id);
    await grove.identity.setAdapter(armed.id, owner, {
      kind: "webhook",
      config: { url: GOOD_URL },
      enabled: true,
      verifiedKeyId: keyId,
    });
    await grove.identity.setAdapter(idle.id, owner, { kind: "mailbox", config: {}, enabled: false });

    const list = await grove.identity.listDispatchableAdapters();
    const forArmed = list.find((a) => a.agentId === armed.id);
    expect(forArmed).toBeDefined();
    expect(forArmed!.verifiedPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(forArmed!.verifiedKeyRevoked).toBe(false);
    // A disabled adapter is not a destination.
    expect(list.some((a) => a.agentId === idle.id)).toBe(false);

    // Revocation happens long after the row was written, so the pin has to be
    // re-checked at read time. Reported, not filtered: a dispatcher that
    // silently skipped a dead pin would look exactly like one that was working.
    await grove.identity.revokeKey(armed.id, keyId, owner);
    const after = (await grove.identity.listDispatchableAdapters()).find((a) => a.agentId === armed.id);
    expect(after!.verifiedKeyRevoked).toBe(true);
    expect(after!.verifiedKeyId).toBe(keyId);

    // And a revoked key can no longer be pinned afresh.
    await expect(
      grove.identity.setAdapter(armed.id, owner, {
        kind: "webhook",
        config: { url: GOOD_URL },
        verifiedKeyId: keyId,
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("writes an audit line that does not repeat the destination", async () => {
    const owner = await newHuman("owner");
    const agent = await newAgent(owner);
    await grove.identity.setAdapter(agent.id, owner, {
      kind: "webhook",
      config: { url: GOOD_URL },
      enabled: true,
    });
    const { rows } = await pg.query(
      `SELECT payload FROM world_events WHERE actor_id = $1 AND type = 'agent_adapter_set'`,
      [agent.id],
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "webhook", enabled: true, by: owner.id });
    // The destination lives in exactly one row, and world_events is not it.
    expect(JSON.stringify(payload)).not.toContain("agent.example.com");
  });
});
