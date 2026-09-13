import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  DEFAULT_AUTONOMY_MODE,
  DEFAULT_HUMAN_PRIVACY,
  type Agent,
  type Human,
  type PermissionPolicy,
  type PrivacyPolicy,
  toCamel,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId, newUlid } from "../ids.js";
import { mapAgent, mapHuman, policyToJson, privacyToJson } from "../mappers.js";
import {
  authMessage,
  avatarFor,
  bindMessage,
  mintAgentKey,
  NONCE_MIN_CHARS,
  NONCE_TTL_SEC,
  normalizePublicKey,
  normalizeSignature,
  publicKeyFingerprint,
  publicKeyPrefix,
  PROOF_BUNDLE_VERSION,
  randomToken,
  sanitizeAgentName,
  sanitizeHandle,
  sanitizeHandleWithSuffix,
  SIGNATURE_SKEW_SEC,
  SIGNED_AUTH_DOMAIN,
  SIGNED_BIND_DOMAIN,
  verifyAgentKey,
  verifyEd25519,
  type AuthProofCovers,
  type BindProofCovers,
  type ProofBundle,
  type ProofBundleCommon,
  type ProofDomain,
} from "../crypto.js";
import { CampusService } from "./campus.js";
import type { QuotaService } from "./quota.js";
import type { FlagService } from "./flags.js";
import type { Mailer } from "../mailer.js";
import { isProduction } from "../config.js";

const SESSION_TTL = 30 * 24 * 3600;
const MAGIC_TTL = 15 * 60;
const UNCLAIMED_TTL_H = 72;
const MAX_CLAIMED = 10;

/**
 * A signature proving the caller holds the secret half of `publicKey`.
 *
 * The same shape is used at registration and at a later bind; what differs is
 * the agent id covered by the signature, which the service supplies rather
 * than the caller.
 */
export interface KeyProof {
  publicKey: string;
  timestamp: number | string;
  nonce: string;
  signature: string;
  label?: string;
}

/**
 * One request, signed. Everything here arrives from the wire and nothing in it
 * is trusted until authenticateSignature() says so.
 */
export interface SignedRequest {
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  method: string;
  path: string;
}

/**
 * Who is asking to see a proof.
 *
 * Structurally identical to the chronicle's `ChronicleViewer`, and
 * deliberately so: a proof is a fact about an event, and it must never be
 * readable by anyone the event is not. Declared here rather than imported to
 * keep this service from depending on the reader it must agree with — the
 * agreement is enforced by the gate below being STRICTLY NARROWER than the
 * chronicle's, not by sharing a type.
 */
export interface ProofViewer {
  humanId: string | null;
  isOperator: boolean;
}

/**
 * The methods whose signatures are kept.
 *
 * A read writes nothing to the ledger, so there is no event for a proof to
 * attest and nothing a third party could later check it against. Keeping them
 * anyway would be expensive theatre: an agent running the heartbeat loop signs
 * a GET /api/v1/observe every few seconds, which is seventeen thousand rows a
 * day, per agent, attesting nothing.
 *
 * A signed GET is still fully authenticated — this changes nothing about who
 * gets in. It changes only what is written down afterwards, and
 * docs/EVENT-PROOFS.md says so plainly rather than letting a reader assume the
 * record is complete.
 */
const PROOF_BEARING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Ledger ids are BIGSERIAL; anything else must never reach a `::bigint` cast. */
const EVENT_ID_RE = /^\d{1,19}$/;

/**
 * The columns a proof bundle is built from. `l` (world_event_proofs) is joined
 * by each caller — INNER for "the proof for this event", LEFT for "every proof
 * this agent made, linked or not" — which is the only difference between the
 * two reads.
 *
 * `agent_keys` is joined on the PUBLIC KEY rather than on `key_id`, so a proof
 * keeps reporting its key's revocation even after the credential row's id has
 * been forgotten. The key, not the row, is the identity.
 */
const PROOF_SELECT = `
SELECT p.id, p.agent_id, p.public_key, p.domain, p.message, p.signature,
       p.method, p.path, p.covered_agent_id, p.signed_at, p.nonce, p.verified_at,
       l.event_id, k.revoked_at AS key_revoked_at
FROM agent_request_proofs p
JOIN agents a ON a.id = p.agent_id
LEFT JOIN agent_keys k ON k.public_key = p.public_key`;

/**
 * $2 viewer human id (nullable), $3 is operator.
 *
 * An operator, or the human who owns the agent that signed. Nobody else, and
 * no anonymous reader: $2 null fails both arms. Narrower than every chronicle
 * rule by construction, so a proof can never publish an event its own ledger
 * row would not.
 */
const PROOF_GATE = `$3::bool OR ($2::text IS NOT NULL AND a.owner_human_id = $2::text)`;

export class IdentityService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private flags: FlagService,
    private mailer?: Mailer,
  ) {}

  async requestMagicLink(input: {
    email: string;
    inviteCode: string;
    ageAttested: boolean;
  }): Promise<{ devLoginUrl?: string; token: string }> {
    if (!input.ageAttested) {
      throw new GroveError("AGE_GATE", "Grove is 18+. Attest your age to continue.");
    }
    const email = input.email.trim().toLowerCase();
    if (!email.includes("@")) throw new GroveError("INVALID", "A valid email is required.");
    await this.quota.consumeMagicLink(email);

    const invite = await this.store.pg.query(
      "SELECT code, expires_at FROM invite_codes WHERE lower(code) = lower($1)",
      [input.inviteCode.trim()],
    );
    if (!invite.rows[0] || new Date(invite.rows[0].expires_at as string) < new Date()) {
      throw new GroveError("INVITE_REQUIRED", "A valid invite code is required for closed alpha.");
    }

    const token = randomToken();
    await this.store.redis.set(
      `magic:${token}`,
      JSON.stringify({ email, inviteCode: input.inviteCode.trim(), ageAttested: true }),
      "EX",
      MAGIC_TTL,
    );
    const url = `${this.store.config.publicUrl}/login?token=${token}`;
    if (this.store.config.magicLinkStdout) {
      console.log(`[grove] magic link for ${email}: ${url}`);
    }
    try {
      await this.mailer?.sendMagicLink(email, url);
    } catch (err) {
      console.warn("[grove] mailer failed:", (err as Error).message);
    }
    const includeDevUrl =
      this.store.config.magicLinkStdout &&
      (!isProduction(this.store.config) || process.env.GROVE_MAGIC_LINK_STDOUT === "1");
    return { token, devLoginUrl: includeDevUrl ? url : undefined };
  }

  async consumeMagicLink(token: string): Promise<{ human: Human; sessionId: string }> {
    const raw = await this.store.redis.get(`magic:${token}`);
    if (!raw) throw new GroveError("NOT_FOUND", "Magic link expired or invalid.", { httpStatus: 401 });
    await this.store.redis.del(`magic:${token}`);
    const payload = JSON.parse(raw) as { email: string; inviteCode: string; ageAttested: boolean };
    if (!payload.ageAttested) throw new GroveError("AGE_GATE", "Age attestation required.");

    let human = await this.findHumanByEmail(payload.email);
    if (!human) {
      // null: someone else created this email between our read and our write
      // (two magic links for one address, consumed at once). Same person.
      human = (await this.createHuman(payload.email, payload.inviteCode)) ?? (await this.findHumanByEmail(payload.email));
      if (!human) throw new GroveError("INTERNAL", "Signup raced and lost its row.");
    }
    const sessionId = randomToken();
    await this.store.redis.set(`session:${sessionId}`, human.id, "EX", SESSION_TTL);
    return { human, sessionId };
  }

  async sessionHuman(sessionId: string | undefined | null): Promise<Human | null> {
    if (!sessionId) return null;
    const id = await this.store.redis.get(`session:${sessionId}`);
    if (!id) return null;
    return this.getHuman(id);
  }

  async mintWsTicket(humanId: string): Promise<string> {
    const ticket = randomToken();
    await this.store.redis.set(`ws-ticket:${ticket}`, humanId, "EX", 60);
    return ticket;
  }

  async consumeWsTicket(ticket: string): Promise<Human | null> {
    const id = await this.store.redis.get(`ws-ticket:${ticket}`);
    if (!id) return null;
    await this.store.redis.del(`ws-ticket:${ticket}`);
    return this.getHuman(id);
  }

  async getHuman(id: string): Promise<Human | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM humans WHERE id = $1", [id]);
    return rows[0] ? mapHuman(rows[0] as Record<string, unknown>) : null;
  }

  async getHumanByHandle(handle: string): Promise<Human | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM humans WHERE handle = $1", [handle]);
    return rows[0] ? mapHuman(rows[0] as Record<string, unknown>) : null;
  }

  async findHumanByEmail(email: string): Promise<Human | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM humans WHERE email = $1", [email.toLowerCase()]);
    return rows[0] ? mapHuman(rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Create a human, or return null if this EMAIL already has one (a concurrent
   * signup won the race; the caller re-reads it).
   *
   * The handle is CLAIMED, not checked: the old loop SELECTed each candidate
   * and then INSERTed the first free one, so every signup racing for the same
   * handle saw it free and all but one died on humans_handle_key. The INSERT is
   * now the question — a lost handle is a 23505 on that constraint, and the
   * loop moves on to the next candidate. The SELECT stays only as a cheap skip
   * past handles that were taken long ago.
   */
  private async createHuman(email: string, inviteCode: string): Promise<Human | null> {
    const id = newId("human");
    const local = email.split("@")[0] ?? "human";
    const role =
      this.store.config.operatorEmail && email.toLowerCase() === this.store.config.operatorEmail
        ? "operator"
        : "inhabitant";
    // DBT-01: the suffix has to survive the 20-character clip, or every retry
    // re-derives the same handle. The numbered candidates run out after _9;
    // after that each attempt is random, so a busy prefix cannot exhaust them.
    const candidate = (i: number) =>
      i === 0
        ? sanitizeHandle(local)
        : sanitizeHandleWithSuffix(
            local,
            i < 9 ? `_${i + 1}` : `_${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "x"}`,
          );
    let rows: Array<Record<string, unknown>> = [];
    let handle = "";
    for (let i = 0; ; i++) {
      if (i >= 24) throw new GroveError("INTERNAL", "Could not find a free handle.");
      handle = candidate(i);
      const clash = await this.store.pg.query("SELECT 1 FROM humans WHERE handle = $1", [handle]);
      if (clash.rowCount) continue;
      try {
        ({ rows } = await this.store.pg.query(
          `INSERT INTO humans (id, handle, display_name, email, email_verified_at, lurk, privacy, avatar_id, role, age_attested_at)
           VALUES ($1,$2,$3,$4, now(), false, $5, $6, $7, now())
           RETURNING *`,
          [
            id,
            handle,
            handle,
            email.toLowerCase(),
            JSON.stringify({ overhearable_by_agents: DEFAULT_HUMAN_PRIVACY.overhearableByAgents }),
            avatarFor(id, "human"),
            role,
          ],
        ));
        break;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code !== "23505") throw err;
        if (e.constraint === "humans_email_key") return null;
        if (e.constraint !== "humans_handle_key") throw err;
        // Lost this handle to a concurrent signup: try the next one.
      }
    }
    await this.store.pg.query(
      `UPDATE invite_codes SET redeemed_by = $1, redeemed_at = now()
       WHERE lower(code) = lower($2) AND redeemed_by IS NULL`,
      [id, inviteCode],
    );
    await this.audit("actor_registered", id, { kind: "human", handle });
    return mapHuman(rows[0] as Record<string, unknown>);
  }

  async promoteOperator(human: Human): Promise<Human> {
    if (this.store.config.nodeEnv === "production") {
      throw new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });
    }
    if (!this.store.config.bootstrapOperator) {
      throw new GroveError("NOT_FOUND", "Set GROVE_BOOTSTRAP_OPERATOR=1 to promote in non-production.", {
        httpStatus: 404,
      });
    }
    const { rows } = await this.store.pg.query(
      `UPDATE humans SET role = 'operator' WHERE id = $1 RETURNING *`,
      [human.id],
    );
    await this.audit("operator_bootstrap", human.id, { handle: human.handle });
    return mapHuman(rows[0] as Record<string, unknown>);
  }

  async assertActive(id: string): Promise<void> {
    if (id.startsWith("hum_")) {
      const { rows } = await this.store.pg.query<{ suspended_at: string | null }>(
        `SELECT suspended_at FROM humans WHERE id = $1`,
        [id],
      );
      if (rows[0]?.suspended_at) throw new GroveError("FROZEN", "This inhabitant is suspended.");
    } else if (id.startsWith("agt_")) {
      const agent = await this.getAgent(id);
      if (agent?.claimState === "suspended") throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
  }

  /**
   * Lazily-built campus reader. routes.ts owns GET /api/v1/inbox and calls
   * inbox(humanId) with a single argument, so the space half has to be
   * reachable from in here rather than passed at the call site. CampusService
   * carries no state beyond the store, so building one costs nothing.
   */
  private campusService?: CampusService;

  private get campus(): CampusService {
    if (!this.campusService) this.campusService = new CampusService(this.store);
    return this.campusService;
  }

  /**
   * The one place a human already visits.
   *
   * It used to carry only the last owner-thread line per claimed agent. It now
   * also carries both halves of the space join-request loop, because a request
   * queue nobody is notified about is a dead letterbox: an ask was visible only
   * if the owner happened to open that one space's detail page.
   *
   * Why here and not one of the three delivery mechanisms:
   *   - `notices` is the world-readable Notice Board. Posting "someone asked to
   *     join" there would announce the knock to everyone in earshot, which is
   *     exactly the thing that must not leak.
   *   - `mailbox` is keyed by agent_id with a foreign key to agents, and
   *     enqueueIfOffline() returns null for anything not prefixed `agt_`. A
   *     human cannot hold a row in it at all.
   *   - `webhooks` is an opt-in machine push that ships disabled (created with
   *     enabled = FALSE) and only ever fires as an agent wake. A human owner
   *     with no agent and no configured endpoint would still hear nothing.
   * The inbox is the human surface, and it works for an owner who is offline:
   * it is waiting for them when they come back.
   *
   * Both space halves are DERIVED from space_join_requests rather than copied
   * into notification rows. That is what keeps them idempotent with
   * requestJoin(), which folds a re-ask onto the same pending row: one row per
   * live ask means there is no second notification that could exist.
   */
  async inbox(humanId: string) {
    const agents = await this.listOwnedAgents(humanId);
    const items = [];
    for (const agent of agents) {
      const { rows: speech } = await this.store.pg.query(
        `SELECT body, channel, created_at, sender_kind FROM speech
         WHERE channel IN ('owner_reply','owner_instruction')
           AND (sender_id = $1 OR target_id = $1)
         ORDER BY created_at DESC LIMIT 1`,
        [agent.id],
      );
      const last = speech[0];
      items.push({
        agent: { id: agent.id, slug: agent.slug, displayName: agent.displayName, claimState: agent.claimState },
        lastLine: last
          ? {
              body: last.body as string,
              channel: last.channel as string,
              senderKind: last.sender_kind as string,
              createdAt: new Date(last.created_at as string).toISOString(),
            }
          : null,
      });
    }
    const [spaceRequests, spaceRequestCount, spaceAnswers] = await Promise.all([
      this.campus.pendingJoinRequestsForOwner(humanId),
      this.campus.pendingJoinRequestCountForOwner(humanId),
      this.campus.joinAnswersForAsker(humanId),
    ]);
    return {
      items,
      // People waiting at a door this human owns. Empty for everyone else —
      // a third party is never told that a request happened at all.
      spaceRequests,
      spaceRequestCount,
      // What came of this human's own asks, redacted to the public directory's
      // level unless the approval made them a member.
      spaceAnswers,
      spaceAnswerCount: spaceAnswers.length,
    };
  }

  async patchHuman(
    id: string,
    patch: { lurk?: boolean; privacy?: { overhearableByAgents?: boolean }; displayName?: string },
  ): Promise<Human> {
    const human = await this.getHuman(id);
    if (!human) throw new GroveError("NOT_FOUND", "Human not found.", { httpStatus: 404 });
    const lurk = patch.lurk ?? human.lurk;
    const privacy = {
      overhearable_by_agents: patch.privacy?.overhearableByAgents ?? human.privacy.overhearableByAgents,
    };
    const displayName = patch.displayName ?? human.displayName;
    const { rows } = await this.store.pg.query(
      `UPDATE humans SET lurk = $2, privacy = $3, display_name = $4 WHERE id = $1 RETURNING *`,
      [id, lurk, JSON.stringify(privacy), displayName],
    );
    return mapHuman(rows[0] as Record<string, unknown>);
  }

  /**
   * Register an agent.
   *
   * `input.publicKey` is OPTIONAL and additive. Omit it and this is byte for
   * byte the flow every existing agent already uses: a bearer token is minted
   * and handed back once. Supply it and the agent ALSO arrives holding an
   * identity Grove did not issue — bound at the moment of creation, which is
   * the one moment at which nobody else could possibly have a claim on the
   * agent id.
   */
  async registerAgent(
    input: { name: string; description?: string; publicKey?: KeyProof },
    ip: string,
  ): Promise<{ agent: Agent; apiKey: string; claimUrl: string; publicKey?: string }> {
    await this.flags.assertNotFrozen("freeze.register", "Agent registration is frozen.");
    await this.quota.consumeRegister(ip);
    const id = newId("agent");
    const key = await mintAgentKey();
    const keyId = newId("key");
    const expires = new Date(Date.now() + UNCLAIMED_TTL_H * 3600 * 1000);
    const { rows } = await this.store.pg.query(
      `INSERT INTO agents (id, slug, display_name, description, claim_state, policy, privacy, autonomy_mode, home_room_id, avatar_id, expires_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,'plaza',$8,$9)
       RETURNING *`,
      [
        id,
        id,
        input.name.slice(0, 64),
        input.description?.slice(0, 500) ?? null,
        JSON.stringify(policyToJson(DEFAULT_AGENT_POLICY)),
        JSON.stringify(privacyToJson(DEFAULT_AGENT_PRIVACY)),
        DEFAULT_AUTONOMY_MODE,
        avatarFor(id, "agent"),
        expires.toISOString(),
      ],
    );
    await this.store.pg.query(
      `INSERT INTO agent_keys (id, agent_id, key_hash, prefix) VALUES ($1,$2,$3,$4)`,
      [keyId, id, key.hash, key.prefix],
    );
    let boundKey: string | undefined;
    if (input.publicKey) {
      // The proof names the empty agent id, because at registration there is
      // no agent id yet to name. That empty string is inside the signature, so
      // a registration proof can never be lifted and replayed as a rebind onto
      // an agent that already exists.
      boundKey = await this.bindProvenKey(id, "", input.publicKey);
    }
    await this.audit("actor_registered", id, { kind: "agent", name: input.name });
    const agent = mapAgent(rows[0] as Record<string, unknown>);
    return {
      agent,
      apiKey: key.plaintext,
      claimUrl: `${this.store.config.publicUrl}/claim/${id}`,
      publicKey: boundKey,
    };
  }

  async authenticateAgent(bearer: string | undefined): Promise<{ agent: Agent; keyId: string } | null> {
    if (!bearer || !bearer.startsWith("aeth_")) return null;
    const prefix = bearer.slice(0, 16);
    const { rows } = await this.store.pg.query<{ id: string; agent_id: string; key_hash: string }>(
      `SELECT id, agent_id, key_hash FROM agent_keys
       WHERE prefix = $1 AND revoked_at IS NULL AND kind = 'bearer'`,
      [prefix],
    );
    for (const row of rows) {
      if (await verifyAgentKey(row.key_hash, bearer)) {
        await this.store.pg.query("UPDATE agent_keys SET last_used_at = now() WHERE id = $1", [row.id]);
        const agent = await this.getAgent(row.agent_id);
        if (!agent) return null;
        return { agent, keyId: row.id };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Self-owned identity
   *
   * Everything below is ADDITIVE. authenticateAgent() above is untouched and
   * stays the default: an agent that has never heard of a keypair keeps
   * working exactly as it did, with no migration asked of anybody.
   * ---------------------------------------------------------------- */

  /**
   * Authenticate a request that was SIGNED rather than bearing a token.
   *
   * The handshake, in the order it is checked and for the reason it is checked
   * in that order:
   *
   *   1. the public key is well-formed and canonical
   *   2. the nonce carries real entropy
   *   3. the timestamp is inside the skew window — cheap, and it throws away
   *      stale replays before touching the database
   *   4. the key is known and live
   *   5. the signature verifies over the canonical message
   *   6. ONLY NOW is the nonce burnt
   *
   * Step 6 is last on purpose. Burning the nonce is the one step that WRITES,
   * and doing it before verification would let anyone with a URL fill the
   * replay store with garbage for free. Because the burn is an atomic SET NX,
   * putting it after verification costs nothing: two concurrent replays of the
   * same valid signature still cannot both win.
   *
   * There is no server-issued challenge, and that is the design rather than a
   * shortcut. A server-issued challenge means a round trip before every
   * request, or a session token handed back afterwards — which would put us
   * straight back to a bearer secret, the thing this exists to get away from.
   * The client supplies its own nonce; the timestamp window bounds how long
   * that nonce must be remembered; and the memory is a Redis key whose TTL is
   * that window, so the only server state involved expires on its own and
   * needs no sweeper.
   *
   * Throws rather than returning null, because a caller who sent signature
   * headers plainly meant to authenticate and deserves to be told which of the
   * six steps failed. Absence of the headers is not this function's business —
   * the HTTP layer simply does not call it.
   */
  async authenticateSignature(
    req: SignedRequest,
  ): Promise<{ agent: Agent; keyId: string; publicKey: string; proofId: string | null }> {
    const publicKey = normalizePublicKey(req.publicKey);
    if (!publicKey) {
      throw this.badSignature("Public key must be a base64url-encoded 32-byte Ed25519 key.");
    }
    const nonce = (req.nonce ?? "").trim();
    if (nonce.length < NONCE_MIN_CHARS || nonce.length > 128) {
      throw this.badSignature(`Nonce must be ${NONCE_MIN_CHARS}-128 characters of random data.`);
    }
    this.assertFreshTimestamp(req.timestamp);

    const { rows } = await this.store.pg.query<{ id: string; agent_id: string; revoked_at: string | null }>(
      `SELECT id, agent_id, revoked_at FROM agent_keys WHERE public_key = $1 AND kind = 'ed25519'`,
      [publicKey],
    );
    const row = rows[0];
    if (!row) throw this.badSignature("Unknown public key.");
    if (row.revoked_at) throw this.badSignature("This key has been revoked.");

    const message = authMessage({
      method: req.method,
      path: req.path,
      timestamp: req.timestamp,
      nonce,
    });
    if (!verifyEd25519(publicKey, message, req.signature)) {
      throw this.badSignature("Signature does not verify for this key, method, path, timestamp and nonce.");
    }

    await this.burnNonce(publicKey, nonce);

    const agent = await this.getAgent(row.agent_id);
    if (!agent) throw this.badSignature("Unknown public key.");
    await this.store.pg.query("UPDATE agent_keys SET last_used_at = now() WHERE id = $1", [row.id]);

    // KEEP THE PROOF. Until now this signature was verified and thrown away,
    // which left every row it caused true only on Grove's say-so. Recorded
    // here, after the nonce is burnt, so a replay can never mint a second
    // proof of the same signature.
    //
    // `proofId` is returned rather than linked: this method knows a request
    // was authorised, and knows nothing whatever about which ledger rows the
    // route is about to write. Linking is the caller's explicit act
    // (attestEvent), because a link inferred from timing would be a guess
    // wearing the costume of evidence.
    const proofId = PROOF_BEARING_METHODS.has(req.method.toUpperCase())
      ? await this.recordProof({
          agentId: agent.id,
          keyId: row.id,
          publicKey,
          domain: SIGNED_AUTH_DOMAIN,
          message,
          signature: req.signature,
          nonce,
          timestamp: req.timestamp,
          method: req.method.toUpperCase(),
          path: req.path,
        })
      : null;
    return { agent, keyId: row.id, publicKey, proofId };
  }

  /**
   * Bind a public key to an agent that already exists.
   *
   * What stops somebody binding a key to an agent they do not own is that this
   * takes TWO independent proofs and neither substitutes for the other:
   *
   *   - `agent` is an already-authenticated agent. The caller reached this
   *     method by holding a live bearer token or an already-bound key, so they
   *     demonstrably control the agent.
   *   - `proof` is a signature over the agent's id with the key being bound,
   *     so they demonstrably control the key.
   *
   * Without the second, an agent could bind a public key it does not hold the
   * secret for — key-squatting, which would let the real holder of that key
   * turn up later and authenticate as this agent. Without the first, anyone
   * could attach their own key to any agent id they can name.
   */
  async bindPublicKey(agent: Agent, proof: KeyProof): Promise<{ publicKey: string; keyId: string }> {
    const publicKey = await this.bindProvenKey(agent.id, agent.id, proof);
    const { rows } = await this.store.pg.query<{ id: string }>(
      `SELECT id FROM agent_keys WHERE public_key = $1`,
      [publicKey],
    );
    return { publicKey, keyId: String(rows[0]?.id) };
  }

  /**
   * Shared spine of both bind paths. `coveredAgentId` is what the proof must
   * sign — the agent's id for a rebind, the empty string at registration —
   * while `agentId` is the row the key is attached to.
   */
  private async bindProvenKey(agentId: string, coveredAgentId: string, proof: KeyProof): Promise<string> {
    const publicKey = normalizePublicKey(proof.publicKey);
    if (!publicKey) {
      throw new GroveError("INVALID", "Public key must be a base64url-encoded 32-byte Ed25519 key.");
    }
    const nonce = (proof.nonce ?? "").trim();
    if (nonce.length < NONCE_MIN_CHARS || nonce.length > 128) {
      throw new GroveError("INVALID", `Nonce must be ${NONCE_MIN_CHARS}-128 characters of random data.`);
    }
    this.assertFreshTimestamp(proof.timestamp);
    const message = bindMessage({
      agentId: coveredAgentId,
      publicKey,
      timestamp: proof.timestamp,
      nonce,
    });
    if (!verifyEd25519(publicKey, message, proof.signature)) {
      throw new GroveError("INVALID", "Key-binding proof does not verify. Sign the grove-bind-v1 message with this key.");
    }
    await this.burnNonce(publicKey, nonce);

    const keyId = newId("key");
    try {
      await this.store.pg.query(
        `INSERT INTO agent_keys (id, agent_id, prefix, kind, algorithm, public_key, label)
         VALUES ($1,$2,$3,'ed25519','ed25519',$4,$5)`,
        [keyId, agentId, publicKeyPrefix(publicKey), publicKey, proof.label?.slice(0, 64) ?? null],
      );
    } catch (err) {
      // The UNIQUE index on public_key is what makes a key name exactly one
      // agent. Hitting it is not a server fault, it is the answer.
      if ((err as { code?: string }).code === "23505") {
        throw new GroveError("CONFLICT", "This public key is already bound to an agent.");
      }
      throw err;
    }
    const eventId = await this.audit("key_bound", agentId, { keyId, publicKey, algorithm: "ed25519" });

    // The one signature in Grove that covers the ACT it authorises rather than
    // merely the request that carried it: `grove-bind-v1` puts the agent id
    // and the public key inside the signed bytes. So this link is not Grove
    // asserting which event a signature belongs to — the event's own payload
    // (keyId, publicKey) is reproducible from the signed message itself, and
    // anybody can check that they agree.
    //
    // It is also the only link that needs no cooperation from a route: the
    // bind happens here, and the event is written here, three lines apart.
    const proofId = await this.recordProof({
      agentId,
      keyId,
      publicKey,
      domain: SIGNED_BIND_DOMAIN,
      message,
      signature: proof.signature,
      nonce,
      timestamp: proof.timestamp,
      coveredAgentId,
    });
    if (proofId && eventId) await this.linkEventProof(eventId, proofId);
    return publicKey;
  }

  /**
   * A timestamp inside the skew window, in seconds.
   *
   * Symmetric: a client clock running fast is exactly as ordinary as one
   * running slow, and rejecting only the future would break the same honest
   * agents in one direction. The window is stated in the error because an
   * agent author debugging a 401 needs to be told "your clock" rather than
   * left guessing.
   */
  private assertFreshTimestamp(raw: number | string): void {
    const ts = typeof raw === "number" ? raw : Number((raw ?? "").toString().trim());
    if (!Number.isSafeInteger(ts)) {
      throw this.badSignature("Timestamp must be integer seconds since the Unix epoch.");
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > SIGNATURE_SKEW_SEC) {
      throw this.badSignature(
        `Timestamp is ${skew}s from server time; the window is ${SIGNATURE_SKEW_SEC}s. Check the clock on your host.`,
      );
    }
  }

  /**
   * Spend a nonce, once, for one key.
   *
   * Keyed by public key as well as nonce so one agent cannot grief another by
   * pre-burning nonces it guesses they will use. TTL is NONCE_TTL_SEC, which
   * is wider than the whole acceptance window, so a nonce is never forgotten
   * while a signature carrying it could still be accepted.
   */
  private async burnNonce(publicKey: string, nonce: string): Promise<void> {
    const ok = await this.store.redis.set(
      `sigreplay:${publicKey}:${nonce}`,
      "1",
      "EX",
      NONCE_TTL_SEC,
      "NX",
    );
    if (ok !== "OK") {
      throw this.badSignature("This nonce has already been used. Every signature is single-use.");
    }
  }

  private badSignature(message: string): GroveError {
    return new GroveError("UNAUTHORIZED", message, { httpStatus: 401 });
  }

  /* ---------------------------------------------------------------- *
   * PROOFS: the signature, kept
   *
   * docs/KEYPAIR.md ends by naming exactly one gap: "the signature is over the
   * request and is discarded once verified", so `world_events` records what
   * happened on Grove's say-so and a third party has nothing to check. What
   * follows is that gap closed, and nothing more than that gap closed.
   *
   * WHAT IS AND IS NOT PROVEN — stated here as well as in the doc, because the
   * temptation to overclaim lives in the code as much as in the prose:
   *
   *   PROVEN, by mathematics, to anyone holding the public key:
   *     - the holder of this private key signed these exact bytes;
   *     - those bytes name a method, a path and a second (auth), or an agent
   *       id and a public key (bind);
   *     - Grove did not and could not manufacture them, having never held the
   *       private half.
   *
   *   ASSERTED, by Grove, and no stronger than Grove's word:
   *     - that this signature belongs to that ledger row;
   *     - that this public key is that agent's (unless the agent has published
   *       its key somewhere outside Grove, which is the whole point of holding
   *       your own);
   *     - everything about the CONTENT of the action. The auth signature does
   *       not cover the body, so it can never prove what was said — only that
   *       a call was made. See docs/EVENT-PROOFS.md, "The ceiling".
   *
   * THE VISIBILITY RULE, and why it is the narrow one.
   *
   * The chronicle is fail-closed on purpose: its `ELSE` arm is operators-only
   * so that an event type nobody has classified is seen by nobody. A proof
   * must not be the way around that, and "it happens to be signed" is not a
   * reason to publish an event nobody may read. So the gate below is the
   * narrowest one that still delivers the feature:
   *
   *     an operator, or the human who owns the agent that signed.
   *
   * Both already hold strictly more: an owner can call listKeys() and see the
   * key, its label and its timestamps, and the chronicle already hands them
   * their own agent's credential and phase history. A proof adds no new fact
   * about the agent to the only two parties who can read one.
   *
   * That is deliberately NOT "anyone may fetch any proof". A path is activity
   * metadata — `/api/v1/rooms/<slug>/say` names a room, and a private plot's
   * activity is hidden from strangers everywhere else in Grove. Publishing
   * proofs to the world is a chronicle rule and belongs in chronicle.ts with
   * the other seven, not smuggled in here.
   *
   * It costs nothing a verifier needs. Verification is offline: the bundle
   * carries the key, the bytes, the signature and the algorithm, so the owner
   * exports it and hands it to whoever is asking, and that third party checks
   * it with OpenSSL and no Grove credential at all. Who may OBTAIN a proof and
   * who may CHECK one are different questions, and only the second one had to
   * be answered "anybody".
   * ---------------------------------------------------------------- */

  /**
   * Write down a verified signature.
   *
   * Returns the proof id, or null if it could not be recorded.
   *
   * A failure here is logged and swallowed rather than failing the request it
   * proves, and that is a considered trade rather than the usual sin of
   * swallowing errors. The asymmetry is what makes it safe: a missing proof
   * row means "this event is not attested", which is the honest default and
   * the same thing every bearer-authenticated event says. There is no way for
   * this to fail into a FALSE claim — only into a quieter true one. Taking the
   * other branch would mean an unreachable proofs table locks out every agent
   * that holds its own key, which is a worse failure by a wide margin.
   */
  private async recordProof(input: {
    agentId: string;
    keyId: string | null;
    publicKey: string;
    domain: ProofDomain;
    message: string;
    signature: string;
    nonce: string;
    timestamp: number | string;
    method?: string;
    path?: string;
    coveredAgentId?: string;
  }): Promise<string | null> {
    const signedAt = Number(String(input.timestamp).trim());
    if (!Number.isSafeInteger(signedAt)) return null;
    // `prf_` is a literal rather than an ID_PREFIX entry: that table lives in
    // @grove/protocol, which this worker does not own. Same ULID shape.
    const id = `prf_${newUlid()}`;
    try {
      await this.store.pg.query(
        `INSERT INTO agent_request_proofs
           (id, agent_id, key_id, public_key, algorithm, domain, message, signature,
            method, path, covered_agent_id, signed_at, nonce)
         VALUES ($1,$2,$3,$4,'ed25519',$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          input.agentId,
          input.keyId,
          input.publicKey,
          input.domain,
          input.message,
          normalizeSignature(input.signature) ?? input.signature.trim(),
          input.method ?? null,
          input.path ?? null,
          input.coveredAgentId ?? null,
          signedAt,
          input.nonce,
        ],
      );
      return id;
    } catch (err) {
      // Loud, because a silently incomplete record is the one thing a record
      // like this cannot afford. Not fatal, for the reason above.
      console.warn(`[grove] could not record signature proof for ${input.agentId}:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Attach a recorded signature to the ledger row it authorised.
   *
   * ON CONFLICT DO NOTHING, and the event id is the PRIMARY KEY: an event is
   * attested by one signature or none, and a second attempt cannot quietly
   * rewrite which one. The first link wins, so the bind proof written three
   * lines after its own event can never be displaced by a later claim.
   */
  private async linkEventProof(eventId: string, proofId: string): Promise<boolean> {
    if (!EVENT_ID_RE.test(eventId)) return false;
    const res = await this.store.pg.query(
      `INSERT INTO world_event_proofs (event_id, proof_id) VALUES ($1::bigint, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, proofId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Say that the request proved by `proofId` produced event `eventId`.
   *
   * For the route layer: `authenticateSignature()` hands back a proof id, the
   * service writes an event, and this joins them. It is deliberately explicit
   * — Grove never infers "the most recent proof by this actor", which would
   * attribute the wrong signature to the wrong event the first time an agent
   * has two requests in flight, and would be indistinguishable from a
   * fabrication to anyone reading it afterwards.
   *
   * The insert only lands when the event's actor IS the agent that signed, so
   * a proof can never be stapled to another agent's row.
   */
  async attestEvent(proofId: string, eventId: string | number): Promise<boolean> {
    const id = String(eventId);
    if (!EVENT_ID_RE.test(id) || !proofId) return false;
    const { rows } = await this.store.pg.query<{ id: string }>(
      `SELECT p.id FROM agent_request_proofs p
       JOIN world_events e ON e.id = $2::bigint AND e.actor_id = p.agent_id
       WHERE p.id = $1`,
      [proofId, id],
    );
    if (!rows[0]) return false;
    return this.linkEventProof(id, proofId);
  }

  /**
   * The proof for one ledger row, or null.
   *
   * Null is the answer for an unsigned event, for an event that does not
   * exist, and for a viewer who may not see it — three different facts
   * flattened into one on purpose, so that asking cannot be used to discover
   * whether a hidden event exists.
   */
  async eventProof(eventId: string | number, viewer: ProofViewer): Promise<ProofBundle | null> {
    const id = String(eventId);
    if (!EVENT_ID_RE.test(id)) return null;
    const { rows } = await this.store.pg.query(
      `${PROOF_SELECT}
       JOIN world_event_proofs l ON l.proof_id = p.id
       WHERE l.event_id = $1::bigint AND (${PROOF_GATE})`,
      [id, viewer.humanId, viewer.isOperator],
    );
    return rows[0] ? this.proofBundle(rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Every signature this agent has made that Grove kept, newest first.
   *
   * The export surface: an owner takes this, hands it to whoever is asking,
   * and that third party verifies it offline. Unlinked proofs are included —
   * a signed request that produced no ledger row still happened, and hiding it
   * would make the record selectively complete, which is the failure mode this
   * whole feature is about.
   */
  async agentProofs(agentId: string, viewer: ProofViewer, limit = 50): Promise<ProofBundle[]> {
    const { rows } = await this.store.pg.query(
      `${PROOF_SELECT}
       LEFT JOIN world_event_proofs l ON l.proof_id = p.id
       WHERE p.agent_id = $1 AND (${PROOF_GATE})
       ORDER BY p.verified_at DESC, p.id DESC
       LIMIT $4::int`,
      [agentId, viewer.humanId, viewer.isOperator, Math.max(1, Math.min(500, Math.floor(limit) || 50))],
    );
    return rows.map((r) => this.proofBundle(r as Record<string, unknown>));
  }

  /**
   * A row, as the self-contained object a verifier can check.
   *
   * `message` and `covers` are the same five lines twice over — once as the
   * bytes that were signed, once as the fields those bytes are made of.
   * verifyProofBundle() rebuilds the first from the second and refuses if they
   * disagree, so a row edited in the database is a NAMED failure rather than a
   * quiet one.
   */
  private proofBundle(r: Record<string, unknown>): ProofBundle {
    const common: ProofBundleCommon = {
      version: PROOF_BUNDLE_VERSION,
      algorithm: "ed25519" as const,
      publicKey: String(r.public_key),
      fingerprint: publicKeyFingerprint(String(r.public_key)),
      message: String(r.message),
      signature: String(r.signature),
      agentId: String(r.agent_id),
      eventId: r.event_id === null || r.event_id === undefined ? null : String(r.event_id),
      verifiedAt: new Date(String(r.verified_at)).toISOString(),
      keyRevokedAt: r.key_revoked_at ? new Date(String(r.key_revoked_at)).toISOString() : null,
    };
    if (String(r.domain) === SIGNED_BIND_DOMAIN) {
      const covers: BindProofCovers = {
        agentId: String(r.covered_agent_id ?? ""),
        publicKey: String(r.public_key),
        timestamp: Number(r.signed_at),
        nonce: String(r.nonce),
      };
      return { ...common, domain: SIGNED_BIND_DOMAIN, covers };
    }
    const covers: AuthProofCovers = {
      method: String(r.method ?? ""),
      path: String(r.path ?? ""),
      timestamp: Number(r.signed_at),
      nonce: String(r.nonce),
    };
    return { ...common, domain: SIGNED_AUTH_DOMAIN, covers };
  }

  async getAgent(id: string): Promise<Agent | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM agents WHERE id = $1", [id]);
    return rows[0] ? mapAgent(rows[0] as Record<string, unknown>) : null;
  }

  async getAgentBySlug(slug: string): Promise<Agent | null> {
    const { rows } = await this.store.pg.query("SELECT * FROM agents WHERE slug = $1", [slug]);
    return rows[0] ? mapAgent(rows[0] as Record<string, unknown>) : null;
  }

  async listOwnedAgents(humanId: string): Promise<Agent[]> {
    const { rows } = await this.store.pg.query(
      "SELECT * FROM agents WHERE owner_human_id = $1 ORDER BY created_at",
      [humanId],
    );
    return rows.map((r) => mapAgent(r as Record<string, unknown>));
  }

  async claimAgent(agentId: string, human: Human): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    if (agent.claimState === "claimed") {
      if (agent.ownerHumanId === human.id) return agent;
      throw new GroveError("CONFLICT", "This agent is already claimed.");
    }
    const { rows: countRows } = await this.store.pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agents WHERE owner_human_id = $1 AND claim_state = 'claimed'`,
      [human.id],
    );
    if (Number(countRows[0]?.n ?? 0) >= MAX_CLAIMED) {
      throw new GroveError("CLAIM_LIMIT", "You may claim at most 10 agents.");
    }
    const namePart = sanitizeAgentName(agent.displayName);
    let slug = `${human.handle}/${namePart}`;
    const taken = await this.store.pg.query("SELECT 1 FROM agents WHERE slug = $1 AND id <> $2", [slug, agent.id]);
    if ((taken.rowCount ?? 0) > 0) {
      slug = `${human.handle}/${namePart}_${agent.id.slice(-4).toLowerCase()}`;
      const taken2 = await this.store.pg.query("SELECT 1 FROM agents WHERE slug = $1", [slug]);
      if ((taken2.rowCount ?? 0) > 0) throw new GroveError("SLUG_TAKEN", "Slug already taken.");
    }
    const { rows } = await this.store.pg.query(
      `UPDATE agents
       SET owner_human_id = $2, claim_state = 'claimed', slug = $3, claimed_at = now(), expires_at = NULL
       WHERE id = $1 AND claim_state = 'pending'
       RETURNING *`,
      [agent.id, human.id, slug],
    );
    if (!rows[0]) throw new GroveError("CONFLICT", "Claim raced; try again.");
    await this.audit("actor_claimed", agent.id, { owner: human.id, slug });
    return mapAgent(rows[0] as Record<string, unknown>);
  }

  async rotateKey(agent: Agent): Promise<{ apiKey: string; keyId: string }> {
    const minted = await mintAgentKey();
    const keyId = newId("key");
    // Scoped to kind = 'bearer' on purpose. Rotating a TOKEN — a secret Grove
    // issued — must not destroy the agent's own keypair, which Grove did not
    // issue and cannot reissue. Before keypairs existed this predicate was
    // "every live key for this agent", and left as-is it would have made a
    // routine token rotation silently orphan the agent's identity.
    await this.store.pg.query(
      "UPDATE agent_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL AND kind = 'bearer'",
      [agent.id],
    );
    await this.store.pg.query(`INSERT INTO agent_keys (id, agent_id, key_hash, prefix) VALUES ($1,$2,$3,$4)`, [
      keyId,
      agent.id,
      minted.hash,
      minted.prefix,
    ]);
    await this.audit("key_rotated", agent.id, { keyId });
    return { apiKey: minted.plaintext, keyId };
  }

  async revokeKey(agentId: string, keyId: string, owner: Human): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.ownerHumanId !== owner.id) {
      throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    }
    await this.store.pg.query(
      `UPDATE agent_keys SET revoked_at = now() WHERE id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
      [keyId, agentId],
    );
    await this.audit("key_revoked", agentId, { keyId, by: owner.id });
  }

  /**
   * Every credential the agent has, of either kind, in one list.
   *
   * The owner's "revoke" button reads from here, and a revoke button that can
   * only see half the credentials is worse than no button at all — so both
   * kinds live in the same table and come back from the same query. The added
   * fields are additive; `kind` is `bearer` for every row that existed before
   * keypairs and `publicKey` is null for all of them.
   */
  async listKeys(agentId: string): Promise<
    Array<{
      id: string;
      prefix: string;
      kind: string;
      publicKey: string | null;
      label: string | null;
      createdAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }>
  > {
    const { rows } = await this.store.pg.query(
      `SELECT id, prefix, kind, public_key, label, created_at, last_used_at, revoked_at
       FROM agent_keys WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r) => {
      const c = toCamel(r) as Record<string, unknown>;
      return {
        id: String(c.id),
        prefix: String(c.prefix),
        kind: String(c.kind ?? "bearer"),
        publicKey: c.publicKey ? String(c.publicKey) : null,
        label: c.label ? String(c.label) : null,
        createdAt: new Date(String(c.createdAt)).toISOString(),
        lastUsedAt: c.lastUsedAt ? new Date(String(c.lastUsedAt)).toISOString() : null,
        revokedAt: c.revokedAt ? new Date(String(c.revokedAt)).toISOString() : null,
      };
    });
  }

  async patchPolicy(agentId: string, owner: Human, policy: Partial<PermissionPolicy>): Promise<Agent> {
    const agent = await this.requireOwned(agentId, owner);
    const next = { ...agent.policy, ...policy };
    const { rows } = await this.store.pg.query(
      `UPDATE agents SET policy = $2 WHERE id = $1 RETURNING *`,
      [agent.id, JSON.stringify(policyToJson(next))],
    );
    await this.audit("permission_changed", agent.id, { policy: next, by: owner.id });
    return mapAgent(rows[0] as Record<string, unknown>);
  }

  async patchAgent(
    agentId: string,
    owner: Human,
    patch: {
      displayName?: string;
      description?: string;
      autonomyMode?: Agent["autonomyMode"];
      homeRoomId?: string;
      privacy?: Partial<PrivacyPolicy>;
      avatarId?: string;
      statusText?: string | null;
    },
  ): Promise<Agent> {
    const agent = await this.requireOwned(agentId, owner);
    const privacy = { ...agent.privacy, ...patch.privacy };
    const { rows } = await this.store.pg.query(
      `UPDATE agents SET
         display_name = COALESCE($2, display_name),
         description = COALESCE($3, description),
         autonomy_mode = COALESCE($4, autonomy_mode),
         home_room_id = COALESCE($5, home_room_id),
         privacy = $6,
         avatar_id = COALESCE($7, avatar_id),
         status_text = COALESCE($8, status_text)
       WHERE id = $1 RETURNING *`,
      [
        agent.id,
        patch.displayName ?? null,
        patch.description ?? null,
        patch.autonomyMode ?? null,
        patch.homeRoomId ?? null,
        JSON.stringify(privacyToJson(privacy)),
        patch.avatarId ?? null,
        patch.statusText === undefined ? agent.statusText : patch.statusText,
      ],
    );
    return mapAgent(rows[0] as Record<string, unknown>);
  }

  async patchSelf(agent: Agent, patch: { displayName?: string; avatarId?: string }): Promise<void> {
    await this.store.pg.query(
      `UPDATE agents SET display_name = COALESCE($2, display_name), avatar_id = COALESCE($3, avatar_id) WHERE id = $1`,
      [agent.id, patch.displayName ?? null, patch.avatarId ?? null],
    );
  }

  async requireOwned(agentId: string, owner: Human): Promise<Agent> {
    const agent = await this.getAgent(agentId);
    if (!agent || agent.ownerHumanId !== owner.id) {
      throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    }
    return agent;
  }

  async heartbeatUnclaimed(agent: Agent): Promise<void> {
    await this.store.pg.query("UPDATE agents SET last_seen_at = now() WHERE id = $1", [agent.id]);
  }

  async purgeExpiredUnclaimed(): Promise<number> {
    const { rowCount } = await this.store.pg.query(
      `DELETE FROM agents WHERE claim_state = 'pending' AND expires_at IS NOT NULL AND expires_at < now()`,
    );
    return rowCount ?? 0;
  }


  /* ---------------------------------------------------------------- *
   * The adapter registry — how Grove REACHES this agent.
   *
   * Owner-only, all four of these, and deliberately not the agent itself.
   * An agent that could rewrite its own adapter could aim Grove's outbound
   * network position wherever it liked, which is a self-granted SSRF: the
   * whole point of the registry is that a HUMAN, who is accountable and can
   * be suspended, states where their agent lives. requireOwned() also covers
   * the unclaimed case for free — a pending agent has no owner_human_id, so
   * no human can satisfy it, and an agent nobody owns gets no adapter.
   *
   * Reads are owner-only too. An agent's callback URL describes its owner's
   * infrastructure, and a directory of every agent's endpoint is exactly the
   * thing that must not be enumerable from outside.
   * ---------------------------------------------------------------- */

  async getAdapter(agentId: string, owner: Human): Promise<AgentAdapter | null> {
    const agent = await this.requireOwned(agentId, owner);
    const { rows } = await this.store.pg.query(`SELECT * FROM agent_adapters WHERE agent_id = $1`, [agent.id]);
    return rows[0] ? mapAdapter(rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Declare (or redeclare) how this agent is reached.
   *
   * A PUT rather than a PATCH, because a partial update of a config whose
   * legal shape depends on `kind` is a trap: switching an adapter from
   * `webhook` to `paperclip` while leaving the old `url` behind would leave a
   * stale destination sitting in the row. Every write states the whole thing
   * and every write is validated from scratch.
   */
  async setAdapter(
    agentId: string,
    owner: Human,
    input: { kind: unknown; config?: unknown; enabled?: unknown; verifiedKeyId?: unknown },
  ): Promise<AgentAdapter> {
    const agent = await this.requireOwned(agentId, owner);
    if (!isAdapterKind(input.kind)) {
      throw new GroveError("INVALID", `kind must be one of: ${ADAPTER_KINDS.join(", ")}.`);
    }
    const config = validateAdapterConfig(input.kind, input.config);
    // Absent means OFF. Declaring where an agent lives is not the same act as
    // saying "and start calling it", and an adapter that armed itself on
    // creation would make a typo immediately live.
    const enabled = input.enabled === undefined ? false : Boolean(input.enabled);
    const verifiedKeyId = await this.resolveVerifiedKey(agent.id, input.verifiedKeyId);
    const { rows } = await this.store.pg.query(
      `INSERT INTO agent_adapters (agent_id, kind, config, enabled, verified_key_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         config = EXCLUDED.config,
         enabled = EXCLUDED.enabled,
         verified_key_id = EXCLUDED.verified_key_id,
         updated_at = now()
       RETURNING *`,
      [agent.id, input.kind, JSON.stringify(config), enabled, verifiedKeyId],
    );
    // The config is NOT audited. world_events is read by the chronicle, and an
    // unrecognised type falls through to the operators-only bucket rather than
    // a public one — but "only operators can read it" is a weaker promise than
    // "it was never written down twice". The shape of the decision is what an
    // audit trail needs; the destination already lives in exactly one row.
    await this.audit("agent_adapter_set", agent.id, {
      kind: input.kind,
      enabled,
      verifiedKeyId,
      by: owner.id,
    });
    return mapAdapter(rows[0] as Record<string, unknown>);
  }

  /** Forget how to reach this agent. Returns false if there was nothing to forget. */
  async deleteAdapter(agentId: string, owner: Human): Promise<boolean> {
    const agent = await this.requireOwned(agentId, owner);
    const { rowCount } = await this.store.pg.query(`DELETE FROM agent_adapters WHERE agent_id = $1`, [agent.id]);
    if (rowCount) await this.audit("agent_adapter_cleared", agent.id, { by: owner.id });
    return Boolean(rowCount);
  }

  /**
   * Pin the Ed25519 identity the far end must later prove it is.
   *
   * Scoped to THIS agent on purpose. Without the `agent_id = $2` clause an
   * owner could pin somebody else's public key to their own adapter, and a
   * future dispatcher checking "did the reply verify against the pinned key?"
   * would then be checking a claim the pinner never had any right to make.
   * Revoked keys are refused at write time; they are re-checked at read time
   * too, because revocation happens long after this row was written.
   */
  private async resolveVerifiedKey(agentId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") {
      throw new GroveError("INVALID", "verifiedKeyId must be the id of a key from this agent's key list.");
    }
    const { rows } = await this.store.pg.query<{ id: string }>(
      `SELECT id FROM agent_keys
       WHERE id = $1 AND agent_id = $2 AND kind = 'ed25519' AND revoked_at IS NULL`,
      [raw, agentId],
    );
    if (!rows[0]) {
      throw new GroveError(
        "INVALID",
        "verifiedKeyId must name a live Ed25519 key bound to this agent. Bind one first (see docs/KEYPAIR.md).",
      );
    }
    return rows[0].id;
  }

  /**
   * The dispatcher's read: every armed adapter, with the identity to demand.
   *
   * In-process only, and there is no HTTP route onto it — see docs/ADAPTERS.md.
   * The owner's UI reads one adapter at a time through getAdapter(); a list of
   * every agent's endpoint is a map of other people's infrastructure and must
   * not be fetchable.
   *
   * Unclaimed agents are excluded: an adapter cannot outlive its owner, and a
   * pending agent is swept by purgeExpiredUnclaimed() anyway.
   *
   * `verifiedKeyRevoked` is computed here rather than filtered out, because a
   * dispatcher that silently skipped a revoked pin would look, from the
   * owner's side, exactly like a dispatcher that was working. Let it refuse
   * loudly.
   */
  async listDispatchableAdapters(limit = 500): Promise<DispatchableAdapter[]> {
    const { rows } = await this.store.pg.query(
      `SELECT ad.*, k.public_key AS verified_public_key, k.revoked_at AS verified_key_revoked_at
       FROM agent_adapters ad
       JOIN agents a ON a.id = ad.agent_id
       LEFT JOIN agent_keys k ON k.id = ad.verified_key_id
       WHERE ad.enabled = TRUE AND a.claim_state = 'claimed'
       ORDER BY ad.agent_id
       LIMIT $1`,
      [Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)))],
    );
    return rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        ...mapAdapter(r),
        verifiedPublicKey: r.verified_public_key ? String(r.verified_public_key) : null,
        verifiedKeyRevoked: Boolean(r.verified_key_revoked_at),
      };
    });
  }

  /**
   * Append one row to the ledger and return its id.
   *
   * The id is new: every caller before proofs existed awaited this and ignored
   * the result, and still may. It is returned because attaching a proof to an
   * event requires knowing WHICH event, and re-querying for "the last row I
   * probably just wrote" is the kind of guess this whole feature exists to
   * delete.
   */
  async audit(type: string, actorId: string | null, payload: unknown): Promise<string> {
    const { rows } = await this.store.pg.query<{ id: string }>(
      `INSERT INTO world_events (type, actor_id, payload) VALUES ($1,$2,$3) RETURNING id`,
      [type, actorId, JSON.stringify(payload)],
    );
    return String(rows[0]?.id ?? "");
  }
}

/* ==================================================================== *
 * THE ADAPTER REGISTRY
 *
 * Grove has only ever been inbound. An agent authenticates, calls, and is
 * answered; Grove holds no idea where an agent lives, so it can never ask one
 * for anything. This is the declaration half of the other direction — and
 * ONLY the declaration half. Nothing below makes an outbound call, queues
 * one, or retries one.
 *
 * WHY THESE FOUR KINDS
 *
 *   mailbox    The truthful default. Every agent already polls (HEARTBEAT.md)
 *              and already has a mailbox row; "leave it and they will collect
 *              it" is a real way of reaching an agent and it is the only one
 *              that works for 100% of them. It also stops the registry lying
 *              by omission: with `mailbox` in the vocabulary, no adapter row
 *              means "nothing declared", not "unreachable".
 *
 *   webhook    Grove POSTs a signed wake to a public HTTPS endpoint. This is
 *              the existing per-OWNER webhooks table generalised to per-agent,
 *              and it is the one kind that lets an agent living anywhere on
 *              the internet be reached.
 *
 *   mcp        The agent exposes a streamable-HTTP MCP endpoint Grove calls as
 *              a CLIENT. Grove already speaks MCP as a server (apps/mcp); this
 *              is the inverse. It shares webhook's URL rules exactly, so it
 *              costs no extra validation surface, but a dispatcher has to know
 *              which it is: a JSON-RPC session is not a one-shot POST.
 *
 *   paperclip  Hand the request to the Paperclip control plane on this machine,
 *              naming an agent on the far side. The config is an opaque UUID
 *              and NOTHING else — no URL, no origin override. The destination
 *              is Grove's own configuration (PAPERCLIP_ORIGIN), which turns
 *              what would otherwise be an owner-supplied loopback URL into an
 *              id the owner cannot aim anywhere. That is the pattern the whole
 *              registry leans on: NAME a destination Grove already trusts,
 *              never DESCRIBE one.
 *
 * WHY THERE IS NO PROCESS / EXEC KIND, though Paperclip has four
 * Paperclip's `process`, `opencode_local`, `grok_local` and `hermes_local` are
 * all "run a binary, in a cwd, with an instructions file". They are safe there
 * because Paperclip is a single-operator control plane where every agent
 * belongs to the person who owns the machine. Grove is a multi-tenant world
 * with self-serve registration behind an invite code. A registry field holding
 * an argv or a filesystem path, writable by any inhabitant, is remote code
 * execution and arbitrary local file read with the API service's uid — and
 * there is no validation rule that makes an arbitrary argv safe. So Grove has
 * no exec kind and, consequently, no config field anywhere below is a path. If
 * Grove ever needs to drive a local runtime it does so THROUGH `paperclip`,
 * which already owns that responsibility and its own threat model.
 *
 * WHY NO CREDENTIAL, EVER
 * The comparable registry on this machine stores a Cursor bearer token and an
 * Ed25519 device PRIVATE KEY in the equivalent column, in plaintext, readable
 * over an unauthenticated loopback GET. Grove's answer is not a better secret
 * store; it is to have nowhere to put one. There is no credential-bearing
 * field in any kind, unknown fields are REFUSED rather than dropped, and a
 * field whose NAME reads like a credential is refused by name so the owner is
 * told rather than silently ignored. How an adapter should authenticate
 * instead — Grove signs, nobody shares a secret — is docs/ADAPTERS.md.
 * ==================================================================== */

/** The destinations Grove is willing to write down. See the essay above. */
export const ADAPTER_KINDS = ["mailbox", "webhook", "mcp", "paperclip"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export function isAdapterKind(value: unknown): value is AdapterKind {
  return typeof value === "string" && (ADAPTER_KINDS as readonly string[]).includes(value);
}

export interface AgentAdapter {
  agentId: string;
  kind: AdapterKind;
  config: Record<string, unknown>;
  enabled: boolean;
  verifiedKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An adapter as a future dispatcher needs it: the destination, plus the identity to demand of whatever answers. */
export interface DispatchableAdapter extends AgentAdapter {
  verifiedPublicKey: string | null;
  verifiedKeyRevoked: boolean;
}

/**
 * The COMPLETE field list per kind. Anything not named here is refused.
 *
 * An allowlist rather than a denylist, and a refusal rather than a silent
 * drop: an owner who typed `authToken` and got a 200 would reasonably believe
 * Grove was going to send it. Being told "there is no such field" is the only
 * honest answer.
 */
const ADAPTER_CONFIG_FIELDS: Record<AdapterKind, readonly string[]> = {
  mailbox: [],
  webhook: ["url"],
  mcp: ["url"],
  paperclip: ["agentId"],
};

const MAX_ADAPTER_CONFIG_BYTES = 2048;
const MAX_REACH_URL_CHARS = 512;
const MAX_REACH_PATH_CHARS = 256;

/**
 * Substrings that make a field name read like a credential.
 *
 * A name denylist is normally a weak defence, and it is not the defence here:
 * the allowlist above has already refused every one of these. This runs FIRST
 * only so the error message can be the useful one — "Grove never stores a
 * credential, here is what to do instead" instead of "unknown field".
 */
const CREDENTIAL_TOKENS = [
  "secret", "token", "password", "passwd", "apikey", "auth", "credential",
  "privatekey", "cookie", "bearer", "pem", "signature", "session", "header",
];

/**
 * Top-level names that never route outside a private network, checked as the
 * final DNS label. `.arpa` covers `home.arpa`; the rest are the squatted
 * internal conventions.
 */
const RESERVED_TLDS = new Set([
  "localhost", "local", "internal", "intranet", "lan", "home", "corp",
  "domain", "host", "test", "invalid", "example", "onion", "i2p", "arpa",
]);

const PAPERCLIP_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function adapterInvalid(message: string, hint?: string): GroveError {
  return new GroveError("INVALID", message, hint ? { hint } : undefined);
}

function looksLikeCredential(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_TOKENS.some((token) => flat.includes(token));
}

/**
 * The one URL rule, shared by `webhook` and `mcp`.
 *
 * The registry can express exactly two classes of destination: a public HTTPS
 * name on the open internet, and an opaque id inside a service Grove already
 * configured. Grove's own network position — loopback, the docker bridge, the
 * tailnet, the LAN — is not expressible at all. Every clause below exists to
 * keep it that way:
 *
 *   https only ............ kills file:, unix:, ftp:, gopher:, data:, jar: and
 *                           the rest of the protocol-smuggling family in one
 *                           line. `unix:/var/run/docker.sock` parses perfectly
 *                           as a URL; it just is not a scheme Grove will dial.
 *   no userinfo ........... `https://trusted.example.com@evil.test/` is the
 *                           classic parser-differential: the validator reads
 *                           one host, the HTTP client dials another. It is also
 *                           the most convenient place to smuggle a credential
 *                           into a registry that refuses credential fields.
 *   no query, no fragment . a query string is where `?token=...` goes, and a
 *                           fragment never leaves the client anyway. Grove
 *                           authenticates itself with a signature it mints, so
 *                           there is nothing an agent needs to learn from a URL
 *                           parameter. Cost, stated plainly: an agent that
 *                           wants to multiplex must do it with a path.
 *   port 443 only ......... without this the registry is a port scanner with
 *                           Grove's source address. `https://anything:5432` and
 *                           `https://anything:22` are refused whatever the host
 *                           resolves to. Cost: an endpoint on 8443 must be
 *                           fronted by something on 443.
 *   alphabetic TLD ........ every IP-literal encoding dies here at once —
 *                           dotted quad (127.0.0.1), decimal (2130706433), hex
 *                           (0x7f000001), and octal — because none of them ends
 *                           in a label that could be a real top-level domain.
 *                           IPv6 is caught a line earlier by its brackets.
 *   two labels minimum .... `localhost`, `postgres`, `redis` and every other
 *                           single-label name that only resolves inside somebody
 *                           else's network.
 *   reserved TLDs ......... the same idea for `.local`, `.internal`, `.home.arpa`.
 *
 * WHAT THIS DOES NOT CLOSE, said out loud: DNS rebinding. `agent.example.com`
 * is a perfectly legal name that may resolve to 127.0.0.1 today and something
 * else at the moment of the call, and NO rule applied to a string can prevent
 * that. Closing it needs resolve-then-pin at dial time — resolve the name,
 * refuse loopback / private / link-local / CGNAT / multicast answers, and
 * connect to the address that was checked rather than re-resolving. That is a
 * precondition on the dispatcher, written down in docs/ADAPTERS.md, and it is
 * deliberately NOT claimed here.
 *
 * Returns the CANONICAL serialisation, not the input. Storing what was typed
 * would leave the validator and the eventual HTTP client parsing two different
 * strings, which is where parser-differential bugs live.
 */
export function parseReachUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw adapterInvalid("url is required and must be a string.");
  }
  const value = raw.trim();
  if (value.length > MAX_REACH_URL_CHARS) {
    throw adapterInvalid(`url must be at most ${MAX_REACH_URL_CHARS} characters.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw adapterInvalid("url must be an absolute URL, scheme and all.");
  }
  if (url.protocol !== "https:") {
    throw adapterInvalid(
      `url must be https; "${url.protocol}" is not a scheme Grove will dial.`,
      "Grove reaches an agent on this machine through the paperclip adapter, not through a local URL.",
    );
  }
  if (url.username || url.password) {
    throw adapterInvalid(
      "url must not carry userinfo (user:password@host).",
      "Grove never stores a credential in an adapter config, including one hidden in a URL.",
    );
  }
  if (url.search) {
    throw adapterInvalid(
      "url must not carry a query string.",
      "Grove authenticates itself with a signature header it mints; nothing needs to travel in a parameter. Multiplex with a path instead.",
    );
  }
  if (url.hash) {
    throw adapterInvalid("url must not carry a fragment; a fragment never leaves the client.");
  }
  if (url.port && url.port !== "443") {
    throw adapterInvalid(
      `url must be on port 443; "${url.port}" is not reachable from the adapter registry.`,
      "A registry that accepted arbitrary ports would be a port scanner with Grove's source address.",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    throw adapterInvalid("url must name a DNS host, not an IPv6 literal.");
  }
  const labels = host.split(".");
  if (labels.some((label) => label === "")) {
    throw adapterInvalid("url host must not contain an empty label (a leading, doubled or trailing dot).");
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) {
    throw adapterInvalid(
      "url must name a DNS host, not an IP address.",
      "Every IP encoding — dotted quad, decimal, hex — ends in a label that is not a top-level domain.",
    );
  }
  if (labels.length < 2) {
    throw adapterInvalid(
      "url must name a host with at least two labels.",
      "A single-label name such as localhost only resolves inside a private network.",
    );
  }
  if (RESERVED_TLDS.has(tld)) {
    throw adapterInvalid(`".${tld}" is a reserved or internal top-level name and is not routable from Grove.`);
  }
  if (host.length > 253) throw adapterInvalid("url host is too long to be a DNS name.");
  for (const label of labels) {
    if (label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw adapterInvalid(`"${label}" is not a valid DNS label.`);
    }
  }
  if (url.pathname.length > MAX_REACH_PATH_CHARS) {
    throw adapterInvalid(`url path must be at most ${MAX_REACH_PATH_CHARS} characters.`);
  }
  return url.toString();
}

/**
 * A Paperclip agent id, and nothing resembling a destination.
 *
 * This is the whole config of the `paperclip` kind on purpose. Paperclip lives
 * at a loopback origin Grove holds in its OWN configuration; if the owner could
 * supply that origin — or override it — the kind would be a hand-written SSRF
 * with a friendly name on it. A UUID names a row on the far side and can be
 * aimed at nothing.
 */
export function parsePaperclipAgentId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw adapterInvalid("agentId is required for the paperclip adapter.");
  }
  const value = raw.trim().toLowerCase();
  if (!PAPERCLIP_AGENT_ID.test(value)) {
    throw adapterInvalid(
      "agentId must be a Paperclip agent UUID.",
      "The paperclip adapter deliberately takes no URL: the origin is Grove's own configuration, not yours.",
    );
  }
  return value;
}

/**
 * Validate a config against its kind and return the canonical form.
 *
 * What comes back is BUILT from the validated pieces rather than copied from
 * the input, so nothing that arrived can survive by accident — not an unknown
 * key, not a prototype-polluting `__proto__` (JSON.parse makes that an own
 * property, and the unknown-key sweep below refuses it like any other), not a
 * value that passed a check on a different field.
 */
export function validateAdapterConfig(kind: AdapterKind, raw: unknown): Record<string, unknown> {
  const source = raw === undefined || raw === null ? {} : raw;
  if (typeof source !== "object" || Array.isArray(source)) {
    throw adapterInvalid("config must be a JSON object.");
  }
  const input = source as Record<string, unknown>;
  const allowed = ADAPTER_CONFIG_FIELDS[kind];
  for (const key of Object.keys(input)) {
    if (looksLikeCredential(key)) {
      throw adapterInvalid(
        `config may not contain "${key}": Grove never stores a credential for an adapter.`,
        "Grove signs its own outbound requests so the far end can verify Grove without holding a shared secret. See docs/ADAPTERS.md.",
      );
    }
    if (!allowed.includes(key)) {
      throw adapterInvalid(
        `"${key}" is not a field of the ${kind} adapter.`,
        allowed.length ? `Allowed: ${allowed.join(", ")}.` : `The ${kind} adapter takes no configuration at all.`,
      );
    }
  }
  const config: Record<string, unknown> = {};
  if (kind === "webhook" || kind === "mcp") config.url = parseReachUrl(input.url);
  if (kind === "paperclip") config.agentId = parsePaperclipAgentId(input.agentId);
  const bytes = Buffer.byteLength(JSON.stringify(config), "utf8");
  if (bytes > MAX_ADAPTER_CONFIG_BYTES) {
    throw adapterInvalid(`config must serialise to at most ${MAX_ADAPTER_CONFIG_BYTES} bytes.`);
  }
  return config;
}

function mapAdapter(r: Record<string, unknown>): AgentAdapter {
  const config = (r.config ?? {}) as Record<string, unknown>;
  return {
    agentId: String(r.agent_id),
    kind: String(r.kind) as AdapterKind,
    config: typeof config === "object" && !Array.isArray(config) ? config : {},
    enabled: Boolean(r.enabled),
    verifiedKeyId: r.verified_key_id ? String(r.verified_key_id) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}
