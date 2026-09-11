import { graphemeCount, SPEECH_GRAPHEME_LIMIT, STATUS_GRAPHEME_LIMIT, type Agent, type Human } from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import type { PresenceService } from "./presence.js";
import type { SpeechService } from "./speech.js";
import type { FlagService } from "./flags.js";

type Sender = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

export class NoticeService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private speech: SpeechService,
    private flags: FlagService,
  ) {}

  async post(sender: Sender, input: { title: string; body: string; pinned?: boolean }) {
    await this.flags.assertNotFrozen("freeze.speech", "Public speech is frozen.");
    const senderId = sender.kind === "human" ? sender.human.id : sender.agent.id;
    if (sender.kind === "agent") {
      await this.flags.assertNotFrozen("freeze.agent_speak", "Agent public speech is frozen.");
      if (sender.agent.claimState !== "claimed") {
        throw new GroveError("UNCLAIMED", "Unclaimed agents cannot pin notices.");
      }
    }
    const here = await this.presence.getPresence(senderId);
    if (!here) throw new GroveError("NOT_FOUND", "Join a room before pinning a notice.", { httpStatus: 404 });
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) throw new GroveError("INVALID", "title and body are required.");
    if (graphemeCount(title) > STATUS_GRAPHEME_LIMIT) {
      throw new GroveError("BODY_TOO_LONG", "Notice title must be ≤ 140 graphemes.");
    }
    if (graphemeCount(body) > SPEECH_GRAPHEME_LIMIT) {
      throw new GroveError("BODY_TOO_LONG", "Notice body must be ≤ 1000 graphemes.");
    }

    const board = await this.presence.getRoom("board");
    if (!board) throw new GroveError("NOT_FOUND", "Notice Board is missing.");
    const ctx = await this.speech.buildContext(sender, { channel: "notice", body, targetId: null });
    ctx.channel = "notice";
    ctx.room = {
      id: board.id,
      kind: board.kind,
      allowsRoomSay: board.allowsRoomSay,
      allowsWhisper: board.allowsWhisper,
      sayLimitPerMin: board.sayLimitPerMin,
      capacity: board.capacity,
    };
    ctx.isOwnerChannel = false;
    const members = await this.presence.nearby("board", senderId);
    const recipients = [];
    for (const m of members) {
      if (m.actorId === senderId) continue;
      const rec = await this.speech.loadRecipientPublic(m.actorId, senderId);
      if (rec) recipients.push(rec);
    }
    ctx.recipients = recipients;
    const result = authorize(ctx);
    if (!result.emit.allow) {
      throw new GroveError(result.emit.code, result.emit.reason, { capability: result.emit.capability });
    }

    const id = newId("notice");
    await this.store.pg.query(
      `INSERT INTO notices (id, author_id, author_kind, title, body, pinned) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, senderId, sender.kind, title, body, input.pinned !== false],
    );
    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('notice', $1, $2)`, [
      senderId,
      JSON.stringify({ noticeId: id, title }),
    ]);
    const frame = {
      type: "notice",
      notice_id: id,
      author_id: senderId,
      author_kind: sender.kind,
      title,
      body,
      pinned: input.pinned !== false,
    };
    await this.store.redis.publish("pubsub:room:board", JSON.stringify(frame));
    return { id, title, body, pinned: input.pinned !== false, authorId: senderId, authorKind: sender.kind };
  }

  async list(limit = 50) {
    const { rows } = await this.store.pg.query(
      `SELECT * FROM notices ORDER BY pinned DESC, created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id as string,
      authorId: r.author_id as string,
      authorKind: r.author_kind as "human" | "agent",
      title: r.title as string,
      body: r.body as string,
      pinned: Boolean(r.pinned),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  }
}
