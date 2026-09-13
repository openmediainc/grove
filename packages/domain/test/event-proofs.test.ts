/**
 * The signature, kept.
 *
 * Migration 012 let an agent hold its own Ed25519 key and authenticate by
 * signing. The signature was then verified and THROWN AWAY, so every row in
 * `world_events` remained true only on Grove's say-so — docs/KEYPAIR.md names
 * that gap in its own "Limits" section. Migration 018 records the canonical
 * message and the signature, and this suite holds down what that is and is not
 * worth:
 *
 *   1. a keypair-authenticated action leaves a proof a stranger can verify
 *      with nothing but the public key;
 *   2. a bearer-authenticated one leaves NONE, and is never reported as
 *      signed — "unsigned" is the honest default, not an anomaly;
 *   3. tampering is caught, including tampering by Grove itself: editing the
 *      stored row cannot produce a proof that verifies, because Grove has
 *      never held the private half;
 *   4. a revoked key still verifies historically. Revocation ends
 *      authentication, not arithmetic.
 *
 * Every value asserted here is produced by the same code the docs quote; the
 * worked example in docs/EVENT-PROOFS.md was lifted out of this suite with
 * GROVE_PRINT_PROOF=1 and cross-checked against OpenSSL.
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
  publicKeyFingerprint,
  signEd25519,
  verifyEd25519,
  verifyProofBundle,
  type ProofBundle,
} from "../src/crypto.js";
import type { Human } from "@grove/protocol";
import {
  assertTestDatabase,
  clearRegisterLimiter,
  createFixtures,
  hasTestDatabase,
  REGISTER_IPS,
  warnIfNotTestDatabase,
} from "./support/fixtures.js";

/** Own register bucket: the limiter is 3/IP/hour and vitest runs files in parallel. */
const REGISTER_IP = REGISTER_IPS.eventProofs;

warnIfNotTestDatabase("event-proofs");

const now = () => Math.floor(Date.now() / 1000);
const tag = () => Math.random().toString(36).slice(2, 10);

type Keys = { publicKey: string; privateKey: string };

describe.skipIf(!hasTestDatabase())("signature proofs outlive the request", () => {
  let grove: GroveApp;
  let pg: ReturnType<typeof createPool>;
  let redis: Redis;
  const fixtures = createFixtures(() => (pg ? { pg, redis } : null));

  beforeAll(async () => {
    const config = loadConfig();
    assertTestDatabase(config.databaseUrl, "run the event-proofs suite");
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

  async function newHuman(prefix: string): Promise<Human> {
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

  /** A registration-time bind proof: the agent id does not exist yet, so it is "". */
  function registrationProof(keys: Keys, label?: string) {
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

  /** Exactly what an agent author sends: four headers, one signature. */
  function signRequest(keys: Keys, method: string, path: string) {
    const timestamp = now();
    const nonce = newNonce();
    return {
      publicKey: keys.publicKey,
      timestamp: String(timestamp),
      nonce,
      method,
      path,
      signature: signEd25519(keys.privateKey, authMessage({ method, path, timestamp, nonce })),
    };
  }

  /** An agent holding its own key, claimed by a human so a viewer exists. */
  async function signingAgent(owner: Human, name = "prover") {
    const keys = generateAgentKeypair();
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent(
      { name: `${name}-${tag()}`, description: "fixture", publicKey: registrationProof(keys) },
      REGISTER_IP,
    );
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    return { keys, agent, apiKey: reg.apiKey };
  }

  /** A bearer-only agent: the default, and the compatibility contract. */
  async function bearerAgent(owner: Human, name = "bearer") {
    await clearRegisterLimiter(redis, REGISTER_IP);
    const reg = await grove.identity.registerAgent(
      { name: `${name}-${tag()}`, description: "fixture" },
      REGISTER_IP,
    );
    fixtures.trackAgent(reg.agent.id);
    const agent = await grove.identity.claimAgent(reg.agent.id, owner);
    return { agent, apiKey: reg.apiKey };
  }

  async function eventIdOf(type: string, actorId: string): Promise<string> {
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM world_events WHERE type = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 1`,
      [type, actorId],
    );
    expect(rows[0], `no ${type} event for ${actorId}`).toBeTruthy();
    return String(rows[0]!.id);
  }

  const asOwner = (owner: Human) => ({ humanId: owner.id, isOperator: false });

  // -------------------------------------------------------------------------

  it("records a bind as a proof a stranger can verify with nothing but the public key", async () => {
    const owner = await newHuman("owner");
    const { keys, agent } = await signingAgent(owner);

    const eventId = await eventIdOf("key_bound", agent.id);
    const bundle = await grove.identity.eventProof(eventId, asOwner(owner));
    expect(bundle).not.toBeNull();
    const proof = bundle as ProofBundle;

    // The bundle is self-contained: key, bytes, signature, algorithm.
    expect(proof.version).toBe("grove-proof-v1");
    expect(proof.algorithm).toBe("ed25519");
    expect(proof.publicKey).toBe(keys.publicKey);
    expect(proof.fingerprint).toBe(publicKeyFingerprint(keys.publicKey));
    expect(proof.eventId).toBe(eventId);
    expect(proof.agentId).toBe(agent.id);
    expect(proof.keyRevokedAt).toBeNull();

    // A bind proof covers the ACT, not merely the request: the agent id and
    // the key are inside the signed bytes. At registration the agent id is the
    // empty string, and that emptiness is itself signed.
    expect(proof.domain).toBe("grove-bind-v1");
    if (proof.domain !== "grove-bind-v1") throw new Error("unreachable");
    expect(proof.covers.agentId).toBe("");
    expect(proof.covers.publicKey).toBe(keys.publicKey);
    expect(proof.message).toBe(
      bindMessage({
        agentId: "",
        publicKey: keys.publicKey,
        timestamp: proof.covers.timestamp,
        nonce: proof.covers.nonce,
      }),
    );

    // Verified two ways: the bundle checker, and raw Ed25519 over the stored
    // bytes — which is all a third party with OpenSSL would ever do.
    expect(verifyProofBundle(proof)).toEqual({ ok: true, reason: null });
    expect(verifyEd25519(proof.publicKey, proof.message, proof.signature)).toBe(true);

    if (process.env.GROVE_PRINT_PROOF === "1") {
      console.log(`GROVE_PROOF_EXAMPLE ${JSON.stringify(proof)}`);
    }
  });

  it("records a signed request and attaches it, on request, to the event it produced", async () => {
    const owner = await newHuman("owner");
    const { keys, agent } = await signingAgent(owner);

    const signed = signRequest(keys, "POST", "/api/v1/move");
    const auth = await grove.identity.authenticateSignature(signed);
    expect(auth.agent.id).toBe(agent.id);
    expect(auth.proofId).toBeTruthy();

    // What a route does next: write the ledger row, then say which proof
    // authorised it. Never inferred from timing.
    const eventId = await grove.identity.audit("actor_joined_room", agent.id, {
      room: "plaza",
      seat: 3,
    });
    expect(await grove.identity.attestEvent(auth.proofId!, eventId)).toBe(true);

    const proof = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(proof).not.toBeNull();
    expect(proof.domain).toBe("grove-auth-v1");
    if (proof.domain !== "grove-auth-v1") throw new Error("unreachable");
    expect(proof.covers.method).toBe("POST");
    expect(proof.covers.path).toBe("/api/v1/move");
    expect(proof.covers.nonce).toBe(signed.nonce);
    expect(proof.signature).toBe(signed.signature);
    expect(proof.message).toBe(
      authMessage({
        method: "POST",
        path: "/api/v1/move",
        timestamp: signed.timestamp,
        nonce: signed.nonce,
      }),
    );
    expect(verifyProofBundle(proof)).toEqual({ ok: true, reason: null });

    if (process.env.GROVE_PRINT_PROOF === "1") {
      console.log(`GROVE_AUTH_PROOF_EXAMPLE ${JSON.stringify(proof)}`);
    }

    // Second claim on the same event changes nothing: one event, one answer.
    const other = signRequest(keys, "POST", "/api/v1/say");
    const otherAuth = await grove.identity.authenticateSignature(other);
    expect(await grove.identity.attestEvent(otherAuth.proofId!, eventId)).toBe(false);
    const again = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(again.signature).toBe(signed.signature);
  });

  it("keeps no proof of a signed read: a GET writes nothing to attest", async () => {
    const owner = await newHuman("owner");
    const { keys, agent } = await signingAgent(owner);

    const auth = await grove.identity.authenticateSignature(signRequest(keys, "GET", "/api/v1/observe"));
    // Fully authenticated — this is not a downgrade, only a decision about
    // what is written down afterwards.
    expect(auth.agent.id).toBe(agent.id);
    expect(auth.proofId).toBeNull();

    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_request_proofs WHERE agent_id = $1 AND domain = 'grove-auth-v1'`,
      [agent.id],
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses to staple one agent's proof onto another agent's event", async () => {
    const owner = await newHuman("owner");
    const { keys } = await signingAgent(owner, "signer");
    const { agent: victim } = await bearerAgent(owner, "victim");

    const auth = await grove.identity.authenticateSignature(signRequest(keys, "POST", "/api/v1/move"));
    const victimEvent = await grove.identity.audit("actor_joined_room", victim.id, { room: "plaza" });

    expect(await grove.identity.attestEvent(auth.proofId!, victimEvent)).toBe(false);
    expect(await grove.identity.eventProof(victimEvent, asOwner(owner))).toBeNull();
  });

  it("leaves a bearer-authenticated action unsigned, and never reports it as signed", async () => {
    const owner = await newHuman("owner");
    const { agent, apiKey } = await bearerAgent(owner);

    const auth = await grove.identity.authenticateAgent(apiKey);
    expect(auth?.agent.id).toBe(agent.id);

    const eventId = await grove.identity.audit("actor_joined_room", agent.id, { room: "plaza", seat: 1 });

    // The honest default: no proof, no claim, nothing to explain away.
    expect(await grove.identity.eventProof(eventId, asOwner(owner))).toBeNull();
    expect(await grove.identity.agentProofs(agent.id, asOwner(owner))).toEqual([]);
    const { rows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_request_proofs WHERE agent_id = $1`,
      [agent.id],
    );
    expect(rows[0]!.n).toBe("0");
    const { rows: links } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM world_event_proofs WHERE event_id = $1::bigint`,
      [eventId],
    );
    expect(links[0]!.n).toBe("0");
  });

  it("refuses a tampered message, a tampered covered field and a tampered signature", async () => {
    const owner = await newHuman("owner");
    const { keys } = await signingAgent(owner);
    const auth = await grove.identity.authenticateSignature(signRequest(keys, "POST", "/api/v1/move"));
    const eventId = await grove.identity.audit("actor_joined_room", auth.agent.id, { room: "plaza" });
    await grove.identity.attestEvent(auth.proofId!, eventId);
    const good = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(verifyProofBundle(good).ok).toBe(true);
    if (good.domain !== "grove-auth-v1") throw new Error("unreachable");

    // Every mutation below is asserted to BE a mutation before its refusal is
    // asserted. A security test that silently checks an unmodified input is
    // worse than no test: it reads as coverage. (This block once flipped the
    // final base64url character of the signature, which carries four PADDING
    // bits and only two real ones — so one run in four it changed the string,
    // decoded to the identical 64 bytes, and demanded that a perfectly valid
    // proof be called invalid.)

    // 1. The readable bytes edited. Caught before the signature is even looked
    //    at, because they no longer match the fields the bundle says it covers.
    const movedMessage = good.message.replace("/move", "/say");
    expect(movedMessage).not.toBe(good.message);
    expect(verifyProofBundle({ ...good, message: movedMessage })).toEqual({
      ok: false,
      reason: "message does not match the fields it claims to cover",
    });

    // 2. The structured half edited instead. Same failure from the other side,
    //    which is the entire reason the bundle carries both.
    expect(good.covers.path).not.toBe("/api/v1/say");
    expect(
      verifyProofBundle({ ...good, covers: { ...good.covers, path: "/api/v1/say" } }),
    ).toEqual({ ok: false, reason: "message does not match the fields it claims to cover" });

    // 3. The signature edited, IN THE BYTES. Flip the low bit of the first
    //    byte of R: deterministic, and the assertion below proves the 64 bytes
    //    really differ rather than trusting that they do.
    const bytes = Buffer.from(good.signature, "base64url");
    expect(bytes.length).toBe(64);
    const tamperedBytes = Buffer.from(bytes);
    tamperedBytes.writeUInt8(tamperedBytes.readUInt8(0) ^ 0x01, 0);
    expect(Buffer.compare(bytes, tamperedBytes)).not.toBe(0);
    const tamperedSignature = tamperedBytes.toString("base64url");
    expect(tamperedSignature).not.toBe(good.signature);
    expect(verifyProofBundle({ ...good, signature: tamperedSignature })).toEqual({
      ok: false,
      reason: "signature does not verify against this public key",
    });

    // 4. The signature RESPELLED but not changed: junk in the four padding
    //    bits of the last character. A canonical 86-character signature always
    //    ends in A, Q, g or w (values 0, 16, 32, 48); adding one lands on the
    //    same two significant bits, so the decoded bytes are identical and the
    //    string is not. Nothing about the proof is weakened — but the row is
    //    no longer the row that was written, and the verifier says so by name
    //    rather than shrugging and returning ok.
    const respellLast: Record<string, string> = { A: "B", Q: "R", g: "h", w: "x" };
    const bumped = respellLast[good.signature.slice(-1)];
    expect(bumped, `unexpected final base64url character in ${good.signature.slice(-1)}`).toBeTruthy();
    const respelled = good.signature.slice(0, -1) + String(bumped);
    expect(respelled).not.toBe(good.signature);
    expect(Buffer.compare(Buffer.from(respelled, "base64url"), bytes)).toBe(0);
    expect(verifyProofBundle({ ...good, signature: respelled })).toEqual({
      ok: false,
      reason: "signature is not a canonical base64url Ed25519 signature",
    });
  });

  it("cannot be rewritten by Grove: a consistently edited row still fails to verify", async () => {
    const owner = await newHuman("owner");
    const { keys } = await signingAgent(owner);
    const auth = await grove.identity.authenticateSignature(signRequest(keys, "POST", "/api/v1/move"));
    const eventId = await grove.identity.audit("actor_joined_room", auth.agent.id, { room: "plaza" });
    await grove.identity.attestEvent(auth.proofId!, eventId);

    // Grove rewrites history as carefully as it can: BOTH halves changed, so
    // they still agree with each other. It cannot touch the signature, because
    // it has never held the private key — and that is the whole property.
    await pg.query(
      `UPDATE agent_request_proofs
          SET path = '/api/v1/rooms/plaza/say',
              message = replace(message, '/api/v1/move', '/api/v1/rooms/plaza/say')
        WHERE id = $1`,
      [auth.proofId],
    );

    const doctored = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(doctored).not.toBeNull();
    if (doctored.domain !== "grove-auth-v1") throw new Error("unreachable");
    expect(doctored.covers.path).toBe("/api/v1/rooms/plaza/say");
    expect(verifyProofBundle(doctored)).toEqual({
      ok: false,
      reason: "signature does not verify against this public key",
    });
  });

  it("still verifies a proof made with a key that has since been revoked", async () => {
    const owner = await newHuman("owner");
    const { keys, agent } = await signingAgent(owner);
    const eventId = await eventIdOf("key_bound", agent.id);

    const before = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(before.keyRevokedAt).toBeNull();
    expect(verifyProofBundle(before).ok).toBe(true);

    const keyRow = (await grove.identity.listKeys(agent.id)).find((k) => k.kind === "ed25519");
    expect(keyRow).toBeTruthy();
    await grove.identity.revokeKey(agent.id, keyRow!.id, owner);

    // Revocation ends AUTHENTICATION...
    await expect(
      grove.identity.authenticateSignature(signRequest(keys, "POST", "/api/v1/move")),
    ).rejects.toThrow(/revoked/i);

    // ...and does not touch ARITHMETIC. The signature was valid when it was
    // made; suppressing it now would be rewriting the past, which is the thing
    // this record exists to make impossible. The bundle says the key is dead
    // and when, so a verifier can judge for themselves.
    const after = (await grove.identity.eventProof(eventId, asOwner(owner))) as ProofBundle;
    expect(after.keyRevokedAt).not.toBeNull();
    expect(Date.parse(after.keyRevokedAt!)).toBeGreaterThan(0);
    expect(after.signature).toBe(before.signature);
    expect(verifyProofBundle(after)).toEqual({ ok: true, reason: null });
  });

  it("shows a proof to the agent's owner and to an operator, and to nobody else", async () => {
    const owner = await newHuman("owner");
    const stranger = await newHuman("stranger");
    const { agent } = await signingAgent(owner);
    const eventId = await eventIdOf("key_bound", agent.id);

    expect(await grove.identity.eventProof(eventId, asOwner(owner))).not.toBeNull();
    expect(
      await grove.identity.eventProof(eventId, { humanId: stranger.id, isOperator: true }),
    ).not.toBeNull();

    // A stranger, and a signed-out reader, get the same answer an unsigned
    // event gets: null. Asking cannot be used to learn that something exists.
    expect(await grove.identity.eventProof(eventId, { humanId: stranger.id, isOperator: false })).toBeNull();
    expect(await grove.identity.eventProof(eventId, { humanId: null, isOperator: false })).toBeNull();
    expect(await grove.identity.agentProofs(agent.id, { humanId: stranger.id, isOperator: false })).toEqual([]);
    expect(await grove.identity.agentProofs(agent.id, { humanId: null, isOperator: false })).toEqual([]);
  });

  it("lists an agent's proofs, including a signed request that produced no event", async () => {
    const owner = await newHuman("owner");
    const { keys, agent } = await signingAgent(owner);
    await grove.identity.authenticateSignature(signRequest(keys, "POST", "/api/v1/say"));

    const proofs = await grove.identity.agentProofs(agent.id, asOwner(owner));
    // The bind proof from registration, plus the unlinked request proof.
    expect(proofs.length).toBe(2);
    expect(proofs.map((p) => p.domain).sort()).toEqual(["grove-auth-v1", "grove-bind-v1"]);
    expect(proofs.every((p) => verifyProofBundle(p).ok)).toBe(true);
    // An unlinked proof is still a true record of a request that happened.
    expect(proofs.some((p) => p.domain === "grove-auth-v1" && p.eventId === null)).toBe(true);
  });

  it("answers null for an event that does not exist or is not an event id at all", async () => {
    const owner = await newHuman("owner");
    expect(await grove.identity.eventProof("9223372036854775807", asOwner(owner))).toBeNull();
    expect(await grove.identity.eventProof("not-an-id", asOwner(owner))).toBeNull();
    expect(await grove.identity.attestEvent("prf_nope", "not-an-id")).toBe(false);
  });
});
