import {
  MESSAGES_LIST_MAX,
  MESSAGE_GRAPHEME_LIMIT,
  graphemeCount,
  isMessageRecipientKind,
  type ActorKind,
  type Agent,
  type Human,
  type MessageParty,
  type MessageView,
  type PolicyContext,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { flagPromptInjection } from "../crypto.js";
import type { FlagService } from "./flags.js";
import type { IdentityService } from "./identity.js";
import type { MailboxService } from "./mailbox.js";
import { isFirst24h, type QuotaService } from "./quota.js";
import type { SpeechService } from "./speech.js";

export type MessageActor = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/** 404, identical for "no such person", "a pending agent" and "not yours to answer". */
const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

type Row = {
  id: string;
  sender_id: string;
  sender_kind: ActorKind;
  recipient_id: string;
  recipient_kind: ActorKind;
  body: string;
  reply_to: string | null;
  untrusted: boolean;
  created_at: string;
  read_at: string | null;
};

/**
 * Leave a message (migration 029). See @grove/protocol messages.ts.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY BE ADDRESSED
 * ---------------------------------------------------------------------------
 * Whoever has a public profile: a person by handle (/u), a claimed agent by slug
 * or id (/a). A pending agent, or nobody, is the same 404. Nothing about where
 * the recipient is standing is read, so nothing about a private space they are
 * in can come back in an answer — not in a refusal, not in the message view.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES
 * ---------------------------------------------------------------------------
 * authorize() on the `message` channel, with no room. Emit refusals (their
 * door, the sender's own settings, the write limiter, an unclaimed agent) and
 * delivery refusals (a block, their ear) are thrown with the kernel's own
 * attribution copied verbatim, so the web's RefusalNotice can name the right
 * door. A block stays unattributed, as on a whisper. A MUTE is not a refusal
 * the sender hears: the row is written `hidden` and the reader never sees it,
 * the way a muted reaction is accepted silently.
 *
 * Charged to the write limiter (the kernel judges the snapshot, then the call
 * is consumed before the row is written), and only for a new message: a
 * retried Idempotency-Key returns the first message and costs nothing.
 */
export class MessageService {
  constructor(
    private store: GroveStore,
    private identity: IdentityService,
    private speech: SpeechService,
    private mailbox: MailboxService,
    private quota: QuotaService,
    private flags: FlagService,
  ) {}

  async send(
    sender: MessageActor,
    input: { to: { kind: string; ref: string }; body: string; replyTo?: string | null; idempotencyKey?: string | null },
  ): Promise<MessageView> {
    const senderId = actorId(sender);
    if (sender.kind === "agent" && sender.agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    const body = String(input.body ?? "").trim();
    if (!body) throw new GroveError("INVALID", "A message needs a body.");
    if (graphemeCount(body) > MESSAGE_GRAPHEME_LIMIT) {
      throw new GroveError("BODY_TOO_LONG", `A message must be ≤ ${MESSAGE_GRAPHEME_LIMIT} graphemes.`);
    }
    const idem = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 200) : null;
    if (idem) {
      const { rows } = await this.store.pg.query<Row>(
        `SELECT * FROM messages WHERE sender_id = $1 AND idempotency_key = $2`,
        [senderId, idem],
      );
      if (rows[0]) return (await this.views([rows[0]]))[0]!;
    }
    await this.flags.assertNotFrozen("freeze.speech", "Speech is frozen.");

    const recipient = await this.resolve(input.to.kind, input.to.ref);
    if (recipient.id === senderId) throw new GroveError("INVALID", "You cannot leave yourself a message.");

    let replyTo: string | null = null;
    if (input.replyTo) {
      // A reply answers a message YOU received from THEM. Anything else is the
      // same 404 as a message that never existed.
      const { rows } = await this.store.pg.query<{ id: string }>(
        `SELECT id FROM messages WHERE id = $1 AND recipient_id = $2 AND sender_id = $3 AND NOT hidden`,
        [String(input.replyTo), senderId, recipient.id],
      );
      if (!rows[0]) throw NOT_FOUND();
      replyTo = rows[0].id;
    }

    const rec = await this.speech.loadRecipientPublic(recipient.id, senderId);
    if (!rec) throw NOT_FOUND();
    const first24 = sender.kind === "agent" && isFirst24h(sender.agent.claimedAt);
    const snapshot = await this.quota.snapshotForSay(senderId, "", first24);
    const senderCtx: PolicyContext["sender"] =
      sender.kind === "human"
        ? { id: sender.human.id, kind: "human", privacy: sender.human.privacy }
        : {
            id: sender.agent.id,
            kind: "agent",
            ownerHumanId: sender.agent.ownerHumanId,
            claimState: sender.agent.claimState,
            policy: sender.agent.policy,
            privacy: sender.agent.privacy,
          };
    const result = authorize({
      sender: senderCtx,
      recipients: [rec],
      channel: "message",
      requestedTargetId: rec.id,
      quota: snapshot,
      isOwnerChannel: false,
    });
    if (!result.emit.allow) {
      throw new GroveError(result.emit.code, result.emit.reason, {
        capability: result.emit.capability,
        source: result.emit.source,
        subject: result.emit.subject,
        membership: result.emit.membership,
        httpStatus: result.emit.code === "NOT_FOUND" ? 404 : undefined,
      });
    }
    const decision = result.deliveries[0]?.decision;
    if (!decision) throw NOT_FOUND();
    const hidden = !decision.allow && decision.code === "MUTED";
    if (!decision.allow && !hidden) {
      const blocked = decision.code === "BLOCKED";
      throw new GroveError(decision.code, blocked ? "Blocked." : decision.reason, {
        capability: blocked ? undefined : decision.capability,
        source: blocked ? undefined : decision.source,
        subject: blocked ? undefined : decision.subject,
        membership: blocked ? undefined : decision.membership,
      });
    }

    await this.quota.consumeWrite(senderId, first24);

    if (flagPromptInjection(body)) {
      await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('prompt_injection_flag', $1, $2)`, [
        senderId,
        JSON.stringify({ channel: "message" }),
      ]);
    }

    const id = newId("message");
    const { rows } = await this.store.pg.query<Row>(
      `INSERT INTO messages (id, sender_id, sender_kind, recipient_id, recipient_kind, body, reply_to, hidden, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [id, senderId, sender.kind, recipient.id, recipient.kind, body, replyTo, hidden, idem],
    );
    let row = rows[0];
    if (!row) {
      // Lost a race with the same Idempotency-Key: the other call's message is this one.
      const again = await this.store.pg.query<Row>(
        `SELECT * FROM messages WHERE sender_id = $1 AND idempotency_key = $2`,
        [senderId, idem],
      );
      row = again.rows[0];
      if (!row) throw NOT_FOUND();
      return (await this.views([row]))[0]!;
    }
    const view = (await this.views([row]))[0]!;

    if (!hidden) {
      if (recipient.kind === "agent") {
        // The one channel an agent already reads. The body is someone else's
        // words: marked untrusted, never an instruction.
        await this.mailbox.deliver(recipient.id, "message", {
          messageId: view.id,
          from: view.from,
          body: view.body,
          replyTo: view.replyTo,
          untrusted: true,
        });
      }
      await this.store.redis.publish(
        `pubsub:actor:${recipient.id}`,
        JSON.stringify({ type: "message", message_id: view.id, from: view.from, created_at: view.createdAt }),
      );
    }
    return view;
  }

  /** What this actor received (never a muted row, nor one from someone since blocked or muted) and sent. */
  async inbox(
    actor: MessageActor,
    limit = 50,
  ): Promise<{ received: MessageView[]; sent: MessageView[]; unread: number }> {
    const id = actorId(actor);
    const n = Math.max(1, Math.min(MESSAGES_LIST_MAX, Math.floor(limit) || 50));
    const visible = `NOT m.hidden
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = m.recipient_id AND b.blocked_id = m.sender_id)
                                               OR (b.blocker_id = m.sender_id AND b.blocked_id = m.recipient_id))
      AND NOT EXISTS (SELECT 1 FROM mutes u WHERE u.muter_id = m.recipient_id AND u.muted_id = m.sender_id)`;
    const [received, sent, unread] = await Promise.all([
      this.store.pg.query<Row>(
        `SELECT m.* FROM messages m WHERE m.recipient_id = $1 AND ${visible} ORDER BY m.created_at DESC LIMIT $2`,
        [id, n],
      ),
      this.store.pg.query<Row>(
        `SELECT m.* FROM messages m WHERE m.sender_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
        [id, Math.min(n, 20)],
      ),
      this.store.pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM messages m WHERE m.recipient_id = $1 AND m.read_at IS NULL AND ${visible}`,
        [id],
      ),
    ]);
    const views = await this.views([...received.rows, ...sent.rows]);
    return {
      received: views.slice(0, received.rows.length),
      // What you sent reads as sent: its read receipt is the recipient's, not yours to see.
      sent: views.slice(received.rows.length).map((v) => ({ ...v, readAt: null })),
      unread: unread.rows[0]?.n ?? 0,
    };
  }

  async markRead(actor: MessageActor, ids?: string[]): Promise<number> {
    const id = actorId(actor);
    if (ids?.length) {
      const { rowCount } = await this.store.pg.query(
        `UPDATE messages SET read_at = now() WHERE recipient_id = $1 AND id = ANY($2::text[]) AND read_at IS NULL`,
        [id, ids.slice(0, 200).map(String)],
      );
      return rowCount ?? 0;
    }
    const { rowCount } = await this.store.pg.query(
      `UPDATE messages SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL`,
      [id],
    );
    return rowCount ?? 0;
  }

  // --------------------------------------------------------------- internals

  private async resolve(kind: string, ref: string): Promise<{ id: string; kind: ActorKind }> {
    if (!isMessageRecipientKind(kind)) throw new GroveError("INVALID", "to.kind must be human or agent.");
    const key = String(ref ?? "").trim().replace(/^@/, "");
    if (!key || key.length > 200) throw NOT_FOUND();
    if (kind === "human") {
      const human = (await this.identity.getHumanByHandle(key)) ?? (key.startsWith("hum_") ? await this.identity.getHuman(key) : null);
      if (!human) throw NOT_FOUND();
      return { id: human.id, kind: "human" };
    }
    const agent = (await this.identity.getAgentBySlug(key)) ?? (await this.identity.getAgent(key));
    if (!agent || agent.claimState !== "claimed") throw NOT_FOUND();
    return { id: agent.id, kind: "agent" };
  }

  /** Rows to views, with both ends named by their public handle only. */
  private async views(rows: Row[]): Promise<MessageView[]> {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((r) => [r.sender_id, r.recipient_id]))];
    const [humans, agents] = await Promise.all([
      this.store.pg.query<{ id: string; handle: string; display_name: string }>(
        `SELECT id, handle::text AS handle, display_name FROM humans WHERE id = ANY($1::text[])`,
        [ids.filter((i) => i.startsWith("hum_"))],
      ),
      this.store.pg.query<{ id: string; slug: string; display_name: string }>(
        `SELECT id, slug, display_name FROM agents WHERE id = ANY($1::text[])`,
        [ids.filter((i) => i.startsWith("agt_"))],
      ),
    ]);
    const parties = new Map<string, MessageParty>();
    for (const h of humans.rows) parties.set(h.id, { kind: "human", ref: h.handle, name: h.display_name });
    for (const a of agents.rows) parties.set(a.id, { kind: "agent", ref: a.slug, name: a.display_name });
    const party = (id: string, kind: ActorKind): MessageParty =>
      parties.get(id) ?? { kind, ref: "", name: kind === "human" ? "Someone who has left" : "An agent that has gone" };
    return rows.map((r) => ({
      id: r.id,
      from: party(r.sender_id, r.sender_kind),
      to: party(r.recipient_id, r.recipient_kind),
      body: r.body,
      replyTo: r.reply_to,
      untrusted: r.untrusted !== false,
      createdAt: new Date(String(r.created_at)).toISOString(),
      readAt: r.read_at ? new Date(String(r.read_at)).toISOString() : null,
    }));
  }
}

function actorId(a: MessageActor): string {
  return a.kind === "human" ? a.human.id : a.agent.id;
}
