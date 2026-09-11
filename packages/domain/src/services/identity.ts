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
import { newId } from "../ids.js";
import { mapAgent, mapHuman, policyToJson, privacyToJson } from "../mappers.js";
import { avatarFor, mintAgentKey, randomToken, sanitizeAgentName, sanitizeHandle, verifyAgentKey } from "../crypto.js";
import type { QuotaService } from "./quota.js";
import type { FlagService } from "./flags.js";

const SESSION_TTL = 30 * 24 * 3600;
const MAGIC_TTL = 15 * 60;
const UNCLAIMED_TTL_H = 72;
const MAX_CLAIMED = 10;

export class IdentityService {
  constructor(
    private store: GroveStore,
    private quota: QuotaService,
    private flags: FlagService,
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
    return { token, devLoginUrl: this.store.config.magicLinkStdout ? url : undefined };
  }

  async consumeMagicLink(token: string): Promise<{ human: Human; sessionId: string }> {
    const raw = await this.store.redis.get(`magic:${token}`);
    if (!raw) throw new GroveError("NOT_FOUND", "Magic link expired or invalid.", { httpStatus: 401 });
    await this.store.redis.del(`magic:${token}`);
    const payload = JSON.parse(raw) as { email: string; inviteCode: string; ageAttested: boolean };
    if (!payload.ageAttested) throw new GroveError("AGE_GATE", "Age attestation required.");

    let human = await this.findHumanByEmail(payload.email);
    if (!human) {
      human = await this.createHuman(payload.email, payload.inviteCode);
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

  private async createHuman(email: string, inviteCode: string): Promise<Human> {
    const id = newId("human");
    let handle = sanitizeHandle(email.split("@")[0] ?? "human");
    for (let i = 0; i < 8; i++) {
      const clash = await this.store.pg.query("SELECT 1 FROM humans WHERE handle = $1", [handle]);
      if (clash.rowCount === 0) break;
      handle = sanitizeHandle(`${email.split("@")[0]}_${i + 2}`);
    }
    const role =
      this.store.config.operatorEmail && email.toLowerCase() === this.store.config.operatorEmail
        ? "operator"
        : "inhabitant";
    const { rows } = await this.store.pg.query(
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
    );
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
    return { items };
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

  async registerAgent(
    input: { name: string; description?: string },
    ip: string,
  ): Promise<{ agent: Agent; apiKey: string; claimUrl: string }> {
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
    await this.audit("actor_registered", id, { kind: "agent", name: input.name });
    const agent = mapAgent(rows[0] as Record<string, unknown>);
    return {
      agent,
      apiKey: key.plaintext,
      claimUrl: `${this.store.config.publicUrl}/claim/${id}`,
    };
  }

  async authenticateAgent(bearer: string | undefined): Promise<{ agent: Agent; keyId: string } | null> {
    if (!bearer || !bearer.startsWith("aeth_")) return null;
    const prefix = bearer.slice(0, 16);
    const { rows } = await this.store.pg.query<{ id: string; agent_id: string; key_hash: string }>(
      `SELECT id, agent_id, key_hash FROM agent_keys WHERE prefix = $1 AND revoked_at IS NULL`,
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
    await this.store.pg.query("UPDATE agent_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL", [
      agent.id,
    ]);
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

  async listKeys(agentId: string): Promise<Array<{ id: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>> {
    const { rows } = await this.store.pg.query(
      `SELECT id, prefix, created_at, last_used_at, revoked_at FROM agent_keys WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map((r) => {
      const c = toCamel(r) as Record<string, unknown>;
      return {
        id: String(c.id),
        prefix: String(c.prefix),
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

  async audit(type: string, actorId: string | null, payload: unknown): Promise<void> {
    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ($1,$2,$3)`, [
      type,
      actorId,
      JSON.stringify(payload),
    ]);
  }
}
