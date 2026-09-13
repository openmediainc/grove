/**
 * Self-owned agent identity: an Ed25519 keypair the agent holds, alongside —
 * never instead of — the bearer token Grove mints.
 *
 * The two properties this suite exists to hold down:
 *   1. a signed request is a real credential, and every way of forging or
 *      reusing one is refused;
 *   2. NOTHING changed for an agent that has never heard of a keypair. The
 *      bearer assertions are not padding — they are the compatibility contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { GroveApp } from "../src/index.js";
import { createPool } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import {
  authMessage,
  bindMessage,
  generateAgentKeypair,
  newNonce,
  normalizePublicKey,
  publicKeyFingerprint,
  signEd25519,
  SIGNATURE_SKEW_SEC,
  verifyEd25519,
} from "../src/crypto.js";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.agentKeypair;

warnIfNotTestDatabase("agent-keypair");

const now = () => Math.floor(Date.now() / 1000);
const tag = () => Math.random().toString(36).slice(2, 10);

describe.skipIf(!hasTestDatabase())("self-owned agent identity", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : null));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the agent-keypair suite");
    await migrate(config.databaseUrl);
    pg = createPool(config.databaseUrl);
    redis = new Redis(config.redisUrl);
    grove = new GroveApp(pg, redis, config);
  });

  afterAll(async () => {
    await fixtures.cleanup();
    await redis.quit();
    await pg.end();
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

  /** A registration-time bind proof: the agent id is not known yet, so it is "". */
  function registrationProof(keys: { publicKey: string; privateKey: string }, label?: string) {
    const timestamp = now();
    const nonce = newNonce();
    return {
      publicKey: keys.publicKey,
      timestamp,
      nonce,
      label,
      signature: signEd25519(
        keys.privateKey,
        bindMessage({ agentId: "", publicKey: keys.publicKey, timestamp, nonce }),
      ),
    };
  }

  /** A rebind proof, which must name the agent it is for. */
  function bindProof(keys: { publicKey: string; privateKey: string }, agentId: string) {
    const timestamp = now();
    const nonce = newNonce();
    return {
      publicKey: keys.publicKey,
      timestamp,
      nonce,
      signature: signEd25519(
        keys.privateKey,
        bindMessage({ agentId, publicKey: keys.publicKey, timestamp, nonce }),
      ),
    };
  }

  /** Exactly what an agent author does: four headers, one signature. */
  function signRequest(
    keys: { publicKey: string; privateKey: string },
    method: string,
    path: string,
    overrides: { timestamp?: number; nonce?: string; signWith?: string } = {},
  ) {
    const timestamp = overrides.timestamp ?? now();
    const nonce = overrides.nonce ?? newNonce();
    const message = authMessage({ method, path, timestamp, nonce });
    return {
      publicKey: keys.publicKey,
      timestamp: String(timestamp),
      nonce,
      signature: signEd25519(overrides.signWith ?? keys.privateKey, message),
      method,
      path,
    };
  }

  async function registerWithKey(name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const keys = generateAgentKeypair();
    const reg = await grove.identity.registerAgent(
      { name, description: "fixture", publicKey: registrationProof(keys) },
      REGISTER_IP,
    );
    fixtures.trackAgent(reg.agent.id);
    return { keys, reg };
  }

  async function registerBearerOnly(name: string) {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent({ name, description: "fixture" }, REGISTER_IP);
    fixtures.trackAgent(reg.agent.id);
    return reg;
  }

  // ---- the happy path ----------------------------------------------------

  it("registers an agent holding its own key, and that key authenticates a request", async () => {
    const { keys, reg } = await registerWithKey(`keyed${tag()}`);
    expect(reg.publicKey).toBe(keys.publicKey);

    const auth = await grove.identity.authenticateSignature(
      signRequest(keys, "GET", "/api/v1/observe"),
    );
    expect(auth.agent.id).toBe(reg.agent.id);
    expect(auth.publicKey).toBe(keys.publicKey);

    // The key is a listed credential like any other, and it is the SAME list
    // the owner's revoke button reads from.
    const listed = await grove.identity.listKeys(reg.agent.id);
    expect(listed.map((k) => k.kind).sort()).toEqual(["bearer", "ed25519"]);
    expect(listed.find((k) => k.kind === "ed25519")?.publicKey).toBe(keys.publicKey);
  });

  it("binds a key to an agent that already exists, proving control of both", async () => {
    const owner = await newHuman("binder");
    const reg = await registerBearerOnly(`late${tag()}`);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    const keys = generateAgentKeypair();

    const bound = await grove.identity.bindPublicKey(agent, bindProof(keys, agent.id));
    expect(bound.publicKey).toBe(keys.publicKey);

    const auth = await grove.identity.authenticateSignature(
      signRequest(keys, "POST", "/api/v1/world/pulse"),
    );
    expect(auth.agent.id).toBe(agent.id);
  });

  // ---- the refusals ------------------------------------------------------

  it("refuses a replayed signature", async () => {
    const { keys } = await registerWithKey(`replay${tag()}`);
    const signed = signRequest(keys, "GET", "/api/v1/observe");

    await expect(grove.identity.authenticateSignature(signed)).resolves.toMatchObject({
      publicKey: keys.publicKey,
    });
    // Byte-identical second presentation. The timestamp is still fresh and the
    // signature still verifies: the nonce is the only thing standing here.
    await expect(grove.identity.authenticateSignature(signed)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      httpStatus: 401,
    });
  });

  it("refuses a signature made with the wrong key", async () => {
    const { keys } = await registerWithKey(`wrongkey${tag()}`);
    const impostor = generateAgentKeypair();

    // Right public key on the wire, wrong private key behind the signature.
    await expect(
      grove.identity.authenticateSignature(
        signRequest(keys, "GET", "/api/v1/observe", { signWith: impostor.privateKey }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // And a perfectly valid signature from a key nobody bound is nobody.
    await expect(
      grove.identity.authenticateSignature(signRequest(impostor, "GET", "/api/v1/observe")),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a timestamp outside the skew window, in either direction", async () => {
    const { keys } = await registerWithKey(`clock${tag()}`);

    await expect(
      grove.identity.authenticateSignature(
        signRequest(keys, "GET", "/api/v1/observe", { timestamp: now() - SIGNATURE_SKEW_SEC - 5 }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      grove.identity.authenticateSignature(
        signRequest(keys, "GET", "/api/v1/observe", { timestamp: now() + SIGNATURE_SKEW_SEC + 5 }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // An honest clock a minute out still works. A window that only accepted
    // perfect clocks would break real agents, which is the whole reason it is
    // a window and not an equality check.
    await expect(
      grove.identity.authenticateSignature(
        signRequest(keys, "GET", "/api/v1/observe", { timestamp: now() - 60 }),
      ),
    ).resolves.toMatchObject({ publicKey: keys.publicKey });
  });

  it("refuses a revoked key, through the owner's ordinary revoke", async () => {
    const owner = await newHuman("revoker");
    const { keys, reg } = await registerWithKey(`revoked${tag()}`);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);

    await expect(
      grove.identity.authenticateSignature(signRequest(keys, "GET", "/api/v1/observe")),
    ).resolves.toBeTruthy();

    const keyRow = (await grove.identity.listKeys(agent.id)).find((k) => k.kind === "ed25519")!;
    await grove.identity.revokeKey(agent.id, keyRow.id, owner);

    await expect(
      grove.identity.authenticateSignature(signRequest(keys, "GET", "/api/v1/observe")),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a signature aimed at a different method or path", async () => {
    const { keys } = await registerWithKey(`aimed${tag()}`);
    const signed = signRequest(keys, "GET", "/api/v1/observe");

    await expect(
      grove.identity.authenticateSignature({ ...signed, path: "/api/v1/say" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      grove.identity.authenticateSignature({ ...signed, method: "POST" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a bind proof that names a different agent", async () => {
    const owner = await newHuman("hijack");
    const mine = await grove.identity.claimAgent((await registerBearerOnly(`mine${tag()}`)).agent.id, owner);
    const theirs = await grove.identity.claimAgent(
      (await registerBearerOnly(`theirs${tag()}`)).agent.id,
      await newHuman("victim"),
    );
    const keys = generateAgentKeypair();

    // A proof minted for my own agent, aimed at somebody else's. This is the
    // exact move a captured bind proof would enable if the agent id were not
    // inside the signature.
    await expect(
      grove.identity.bindPublicKey(theirs, bindProof(keys, mine.id)),
    ).rejects.toMatchObject({ code: "INVALID" });

    // And a registration proof is not a rebind proof: the empty agent id it
    // covers is not this agent's id.
    const regProof = registrationProof(keys);
    await expect(grove.identity.bindPublicKey(theirs, regProof)).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("refuses to bind one public key to two agents", async () => {
    const owner = await newHuman("dupe");
    const { keys } = await registerWithKey(`first${tag()}`);
    const second = await grove.identity.claimAgent(
      (await registerBearerOnly(`second${tag()}`)).agent.id,
      owner,
    );
    await expect(
      grove.identity.bindPublicKey(second, bindProof(keys, second.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a key that is not a canonical 32-byte Ed25519 key", async () => {
    expect(normalizePublicKey("not-a-key")).toBeNull();
    expect(normalizePublicKey(Buffer.alloc(31).toString("base64url"))).toBeNull();
    const keys = generateAgentKeypair();
    expect(normalizePublicKey(keys.publicKey)).toBe(keys.publicKey);
    // A non-canonical SPELLING of a real key. 32 bytes is 256 bits but 43
    // base64url characters carry 258, so the last character has two unused
    // trailing bits that must be zero. Set one and the string still decodes to
    // the identical 32 bytes — a naive decode-and-compare-length check accepts
    // it, and then the same key sits in the table under two different strings
    // and the UNIQUE index that makes a key name ONE agent stops meaning
    // anything.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = ALPHABET.indexOf(keys.publicKey[42]!);
    const alias = keys.publicKey.slice(0, 42) + ALPHABET[lastIndex | 1];
    expect(alias).not.toBe(keys.publicKey);
    expect(Buffer.from(alias, "base64url").equals(Buffer.from(keys.publicKey, "base64url"))).toBe(true);
    expect(normalizePublicKey(alias)).toBeNull();
  });

  // ---- the compatibility contract ---------------------------------------

  it("leaves bearer auth exactly as it was", async () => {
    const reg = await registerBearerOnly(`bearer${tag()}`);
    const auth = await grove.identity.authenticateAgent(reg.apiKey);
    expect(auth?.agent.id).toBe(reg.agent.id);

    // No keypair anywhere near this agent, and its key list looks like it
    // always did.
    const listed = await grove.identity.listKeys(reg.agent.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.kind).toBe("bearer");
    expect(listed[0]!.publicKey).toBeNull();
    expect(listed[0]!.prefix).toBe(reg.apiKey.slice(0, 16));

    // Still the same refusals as before.
    expect(await grove.identity.authenticateAgent(undefined)).toBeNull();
    expect(await grove.identity.authenticateAgent("not-a-grove-key")).toBeNull();
    expect(await grove.identity.authenticateAgent(`aeth_live_${"x".repeat(40)}`)).toBeNull();
  });

  it("rotating a bearer token does not destroy the agent's own identity", async () => {
    const owner = await newHuman("rotator");
    const { keys, reg } = await registerWithKey(`rotate${tag()}`);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);

    const rotated = await grove.identity.rotateKey(agent);

    // The old token is dead and the new one works — unchanged behaviour.
    expect(await grove.identity.authenticateAgent(reg.apiKey)).toBeNull();
    expect((await grove.identity.authenticateAgent(rotated.apiKey))?.agent.id).toBe(agent.id);

    // The keypair is untouched. Grove issued the token and may retire it;
    // Grove did not issue the keypair and cannot reissue it, so a token
    // rotation must never take it with it.
    await expect(
      grove.identity.authenticateSignature(signRequest(keys, "GET", "/api/v1/observe")),
    ).resolves.toMatchObject({ agent: { id: agent.id } });
  });

  it("both credentials resolve to the same agent", async () => {
    const { keys, reg } = await registerWithKey(`both${tag()}`);
    const viaBearer = await grove.identity.authenticateAgent(reg.apiKey);
    const viaSignature = await grove.identity.authenticateSignature(
      signRequest(keys, "GET", "/api/v1/agents/me"),
    );
    expect(viaBearer?.agent.id).toBe(viaSignature.agent.id);
    expect(viaBearer?.keyId).not.toBe(viaSignature.keyId);
  });

  // ---- the primitive, with no database in the way -----------------------

  it("verifies a signature against nothing but the public key", () => {
    // What a third party does: rebuild the canonical string, check the
    // signature against the public key. No Grove, no database, no trust.
    const keys = generateAgentKeypair();
    const message = authMessage({
      method: "GET",
      path: "/api/v1/observe",
      timestamp: 1760000000,
      nonce: "Zm9vYmFyYmF6cXV4",
    });
    const signature = signEd25519(keys.privateKey, message);
    expect(verifyEd25519(keys.publicKey, message, signature)).toBe(true);
    expect(verifyEd25519(keys.publicKey, `${message}x`, signature)).toBe(false);
    expect(verifyEd25519(generateAgentKeypair().publicKey, message, signature)).toBe(false);
    expect(verifyEd25519(keys.publicKey, message, "not-base64url")).toBe(false);
    expect(publicKeyFingerprint(keys.publicKey)).toHaveLength(16);
  });

  it("keeps the two signature domains apart", () => {
    // A bind proof must not be usable as a request signature, or a key could
    // be bound once and that one proof replayed as authentication forever.
    const keys = generateAgentKeypair();
    const timestamp = 1760000000;
    const nonce = "Zm9vYmFyYmF6cXV4";
    const bind = bindMessage({ agentId: "agt_x", publicKey: keys.publicKey, timestamp, nonce });
    const auth = authMessage({ method: "GET", path: "/api/v1/observe", timestamp, nonce });
    expect(bind).not.toBe(auth);
    expect(verifyEd25519(keys.publicKey, auth, signEd25519(keys.privateKey, bind))).toBe(false);
  });
});
