import {
  graphemeCount,
  SPEECH_GRAPHEME_LIMIT,
  STATUS_GRAPHEME_LIMIT,
  type Agent,
  type Human,
  type PolicyContext,
  type PrivacyPolicy,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { mapAgent, mapHuman } from "../mappers.js";
import type { PresenceService } from "./presence.js";
import { spectatorMayHear, type SpeechService } from "./speech.js";
import type { FlagService } from "./flags.js";

/**
 * The Notice Board.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANIC: one pin per UTC day.
 * ---------------------------------------------------------------------------
 * `notices.pinned` shipped defaulting to TRUE, so every notice was pinned and
 * the word meant nothing. It means one thing now: the FIRST notice posted on a
 * UTC day holds that day's pin, and every later notice that day lands on the
 * board unpinned. Nobody can take a pin off someone else — the day's pin is
 * settled the moment it is claimed — and at 00:00 UTC the slot opens again.
 *
 * First-come rather than last-writer-wins on purpose. Last-writer-wins makes
 * the board a shouting match whose only winner is whoever posted most recently;
 * first-come makes the pin a thing you have to turn up for, which is the point.
 * The arbiter is the partial unique index from migration 016, not this file:
 * two people posting in the same millisecond must not both get the day, and a
 * service-layer check cannot promise that.
 *
 * ---------------------------------------------------------------------------
 * THE LEAK THIS CLOSES
 * ---------------------------------------------------------------------------
 * `list()` used to SELECT every notice and hand the bodies to any authenticated
 * caller. Posting ran `authorize()` — but only its EMIT half, and only against
 * whoever happened to be standing on the board at the time. So a line an agent
 * was forbidden to say to humans, or a line from someone you had blocked, was
 * on the board for you to read anyway.
 *
 * Reads now go through the same kernel the room transcript does. For each
 * notice: the AUTHOR is the sender, the VIEWER is the sole recipient, the room
 * is the board, and `authorize()` from @grove/policy decides. There is no second
 * rule here — the predicate is the same function, called with the same shape
 * `SpeechService.transcript()` builds, so blocks, mutes, lurk, agent policy and
 * speaker privacy all apply to the board exactly as they apply to speech.
 *
 * WHY NOT `speech_deliveries`, THE WAY chronicle.ts DOES IT?
 * Because a board and a transcript are different objects. `speech_deliveries`
 * is the world's record of who was allowed to HEAR a line at the moment it was
 * said, and chronicle.ts is right to read it back rather than re-derive: a line
 * spoken while you were blocked must not become readable when the block lifts.
 * But a notice is not addressed to the crowd that happened to be standing there
 * — it is pinned to a wall for whoever walks past next, and nobody who arrives
 * tomorrow has a delivery row at all. Reading deliveries would make the board
 * permanently blank for everyone but the handful present at posting time.
 * So the board takes the OTHER half of the same doctrine: it is a live surface,
 * read with today's permissions, which is precisely what `transcript()` does
 * for a live room. What must never happen — an unauthorised body reaching a
 * viewer — cannot happen either way.
 */

type Sender = { kind: "human"; human: Human } | { kind: "agent"; agent: Agent };

/** Who is reading the board. `null` is a signed-out spectator. */
export type NoticeViewer = Sender | null;

export interface NoticeRow {
  id: string;
  authorId: string;
  authorKind: "human" | "agent";
  /** Already public: /api/v1/u/:handle and /api/v1/a/* serve both. */
  authorName: string | null;
  authorSlug: string | null;
  title: string;
  body: string;
  pinned: boolean;
  /** The UTC day this notice holds the pin for. Null unless `pinned`. */
  pinnedOn: string | null;
  createdAt: string;
}

/** The board as a reader sees it: the day's pin, then everything else. */
export interface BoardView {
  /** The UTC day being asked about, as YYYY-MM-DD. */
  day: string;
  /** Today's pin, or null — either nobody claimed it yet, or this reader may not hear it. */
  pin: NoticeRow | null;
  /** Everything else on the board, newest first, already filtered for this reader. */
  posts: NoticeRow[];
  /** Notices this reader is not allowed to hear. A count, never a hint at what. */
  withheld: number;
  /** When the pin slot opens again: the next UTC midnight. */
  pinOpensAt: string;
}

/** Posting answers with what actually happened to the pin, not what was asked for. */
export interface NoticePosted extends NoticeRow {
  /** True when this notice took the day's pin; false when the day was already taken. */
  tookPin: boolean;
}

/**
 * A historical read: the author already passed rate limiting when they posted,
 * so replaying must not deny them a second time. Same constant `transcript()`
 * and `recentPublicSpeech()` use.
 */
const REPLAY_QUOTA: QuotaSnapshot = {
  roomSayRemaining: 8,
  roomSayGapOk: true,
  writeRemaining: 30,
  roomWindowCount: 0,
};

const BOARD_ROOM_ID = "board";

/**
 * Explicit columns, never `SELECT *`, for one reason: `pinned_on` is a DATE and
 * node-postgres parses a bare DATE into a JS Date at LOCAL midnight. On a host
 * east of UTC that turns 2026-09-12 into 2026-09-11 the moment it is formatted
 * back, which would silently hand today's pin to yesterday. Cast to text in the
 * query and the day never leaves the database's calendar.
 */
const NOTICE_COLUMNS =
  "id, author_id, author_kind, title, body, pinned, pinned_on::text AS pinned_on, created_at";
const DEFAULT_BOARD_LIMIT = 50;

/** YYYY-MM-DD for a UTC instant. The pin's day is UTC everywhere, never local. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** The next UTC midnight after `at`: when the pin slot opens again. */
export function nextUtcMidnight(at: Date = new Date()): string {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
  return next.toISOString();
}

/** An author, resolved once per read rather than once per row. */
interface AuthorFacts {
  sender: PolicyContext["sender"];
  displayName: string | null;
  slug: string | null;
}

export class NoticeService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private speech: SpeechService,
    private flags: FlagService,
  ) {}

  async post(sender: Sender, input: { title: string; body: string; pinned?: boolean }): Promise<NoticePosted> {
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

    const board = await this.presence.getRoomById(BOARD_ROOM_ID);
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
    const members = await this.presence.nearby(BOARD_ROOM_ID, senderId);
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
    const wantsPin = input.pinned !== false;
    const row = await this.insertNotice({ id, senderId, kind: sender.kind, title, body, wantsPin });

    await this.store.pg.query(`INSERT INTO world_events (type, actor_id, payload) VALUES ('notice', $1, $2)`, [
      senderId,
      JSON.stringify({ noticeId: id, title, roomId: BOARD_ROOM_ID, pinned: row.pinned }),
    ]);
    const frame = {
      type: "notice",
      notice_id: id,
      author_id: senderId,
      author_kind: sender.kind,
      title,
      body,
      pinned: row.pinned,
      pinned_on: row.pinnedOn,
    };
    await this.store.redis.publish(`pubsub:room:${BOARD_ROOM_ID}`, JSON.stringify(frame));
    return { ...row, tookPin: row.pinned };
  }

  /**
   * Claim the day, or settle for an ordinary post.
   *
   * Two statements rather than one, and deliberately not a transaction: the
   * first tries for the pin and loses harmlessly to whoever already holds the
   * day (`ON CONFLICT DO NOTHING` on the partial unique index), the second
   * writes the same notice unpinned. Nothing between them can produce a
   * half-written notice, because the first either wrote the whole row or wrote
   * nothing at all.
   *
   * THE DAY IS THE DATABASE'S, AND THE SAME INSTANT AS `created_at`.
   * This used to take `utcDay()` from the app's clock at the top of `post()`,
   * then await flags, presence, the policy context and a recipient per board
   * member before the INSERT stamped `created_at` from Postgres's `now()`. Two
   * clocks, read at two instants: a notice posted across midnight UTC (or on a
   * host whose clock has drifted from the database's — Postgres runs in a VM
   * here) claimed YESTERDAY's slot with today's `created_at`, left today's pin
   * open, and made migration 016 unreplayable (its collapse step keys the day
   * off `created_at`, and trips the `notices_pin_day` CHECK on such a row).
   * `now()` is fixed for the statement, so the pin day and the timestamp are
   * now one reading of one clock.
   */
  private async insertNotice(n: {
    id: string;
    senderId: string;
    kind: "human" | "agent";
    title: string;
    body: string;
    wantsPin: boolean;
  }): Promise<NoticeRow> {
    if (n.wantsPin) {
      const { rows } = await this.store.pg.query(
        `INSERT INTO notices (id, author_id, author_kind, title, body, pinned, pinned_on, created_at)
         VALUES ($1,$2,$3,$4,$5,TRUE,(now() AT TIME ZONE 'UTC')::date, now())
         ON CONFLICT (pinned_on) WHERE pinned_on IS NOT NULL DO NOTHING
         RETURNING ${NOTICE_COLUMNS}`,
        [n.id, n.senderId, n.kind, n.title, n.body],
      );
      if (rows[0]) return mapNotice(rows[0] as Record<string, unknown>, null);
    }
    const { rows } = await this.store.pg.query(
      `INSERT INTO notices (id, author_id, author_kind, title, body, pinned, pinned_on)
       VALUES ($1,$2,$3,$4,$5,FALSE,NULL)
       RETURNING ${NOTICE_COLUMNS}`,
      [n.id, n.senderId, n.kind, n.title, n.body],
    );
    return mapNotice(rows[0] as Record<string, unknown>, null);
  }

  /**
   * The board, filtered for one reader.
   *
   * `viewer` is the actor asking. Pass `null` for a signed-out spectator and the
   * gate becomes `spectatorMayHear()` — the same exported function the public
   * landing page and the Plaza SSE feed use, so a logged-out visitor can never
   * read more off the board than they can already overhear in the Plaza.
   */
  async board(viewer: NoticeViewer = null, limit = DEFAULT_BOARD_LIMIT): Promise<BoardView> {
    // TWO reads, not one ordered `pinned DESC`. Every day's pin stays pinned
    // forever, so a single ordered page would fill with the last fifty DAYS and
    // push this morning's conversation off the board entirely. The pin is looked
    // up by its date (one row, straight off the unique index) and the rest of the
    // board is simply the most recent notices.
    //
    // "Today" comes back from the same query as the pin, off the database clock
    // `post()` writes with. Asking the app clock would let the board and the
    // writer disagree about which day it is.
    const [{ day, pinRows }, recentRows] = await Promise.all([this.readPinRow(), this.readRows(limit)]);
    const pinId = pinRows[0] ? String(pinRows[0].id) : null;
    const rows = [...pinRows, ...recentRows.filter((r) => String(r.id) !== pinId)];
    const authorIds = [...new Set(rows.map((r) => String(r.author_id)))];
    const authors = await this.resolveAuthors(authorIds);
    const board = await this.presence.getRoomById(BOARD_ROOM_ID);
    // The reader as a RECIPIENT of each author: one lookup per distinct author,
    // not per notice. `loadRecipientPublic()` is SpeechService's own loader, so
    // the blocks table, the mutes table and the per-agent grant overlay all land
    // on the context exactly as they do for a spoken line — this is where the
    // board stops being a way around a block.
    const asRecipient = await this.recipientsFor(viewer, authorIds);

    let pin: NoticeRow | null = null;
    const posts: NoticeRow[] = [];
    let withheld = 0;

    for (const raw of rows) {
      const authorId = String(raw.author_id);
      const facts = authors.get(authorId) ?? null;
      if (!this.audible(facts, viewer, asRecipient.get(authorId) ?? null, board)) {
        withheld += 1;
        continue;
      }
      const notice = mapNotice(raw, facts);
      if (notice.pinned && notice.pinnedOn === day) pin = notice;
      else posts.push(notice);
    }

    return { day, pin, posts, withheld, pinOpensAt: nextUtcMidnight(new Date(`${day}T00:00:00Z`)) };
  }

  /**
   * The reader, loaded once per distinct author.
   *
   * A block and a mute are directional facts about a PAIR, so the recipient
   * context differs per author and cannot be built from the viewer alone. That
   * is the whole reason this is a map rather than one object: building it from
   * `viewer` by hand is how the board would quietly stop honouring blocks.
   */
  private async recipientsFor(
    viewer: NoticeViewer,
    authorIds: string[],
  ): Promise<Map<string, PolicyContext["recipients"][number]>> {
    const out = new Map<string, PolicyContext["recipients"][number]>();
    if (!viewer) return out;
    const viewerId = viewer.kind === "human" ? viewer.human.id : viewer.agent.id;
    for (const authorId of authorIds) {
      if (authorId === viewerId) continue;
      const rec = await this.speech.loadRecipientPublic(viewerId, authorId);
      if (rec) out.set(authorId, rec);
    }
    return out;
  }

  /**
   * Flat list, newest first, pin at the head — the shape the original route
   * answers with.
   *
   * The `viewer` argument is optional and defaults to `null`, which is the
   * SPECTATOR gate rather than "no gate". A caller that forgets to say who is
   * asking therefore gets the narrowest possible answer instead of the widest:
   * the failure mode of forgetting is an under-full board, never a leak.
   */
  async list(viewer: NoticeViewer = null, limit = DEFAULT_BOARD_LIMIT): Promise<NoticeRow[]> {
    const view = await this.board(viewer, limit);
    return view.pin ? [view.pin, ...view.posts] : view.posts;
  }

  /** Today's pin alone, for the surfaces that only want the one line. */
  async pinOfTheDay(viewer: NoticeViewer = null): Promise<NoticeRow | null> {
    return (await this.board(viewer, DEFAULT_BOARD_LIMIT)).pin;
  }

  private async readRows(limit: number): Promise<Array<Record<string, unknown>>> {
    const capped = Math.max(1, Math.min(200, Math.trunc(limit) || DEFAULT_BOARD_LIMIT));
    const { rows } = await this.store.pg.query(
      `SELECT ${NOTICE_COLUMNS} FROM notices ORDER BY created_at DESC LIMIT $1`,
      [capped],
    );
    return rows as Array<Record<string, unknown>>;
  }

  /**
   * Today's UTC day on the database clock, and its pin. At most one pin row:
   * the unique index guarantees it. The LEFT JOIN keeps the day when nobody
   * holds it yet.
   */
  private async readPinRow(): Promise<{ day: string; pinRows: Array<Record<string, unknown>> }> {
    const cols = NOTICE_COLUMNS.split(", ")
      .map((c) => `n.${c}`)
      .join(", ");
    const { rows } = await this.store.pg.query(
      `SELECT t.day::text AS today, ${cols}
         FROM (SELECT (now() AT TIME ZONE 'UTC')::date AS day) AS t
         LEFT JOIN notices n ON n.pinned_on = t.day`,
    );
    const day = String((rows[0] as { today: string }).today);
    return { day, pinRows: (rows as Array<Record<string, unknown>>).filter((r) => r.id != null) };
  }

  /**
   * Can this reader hear this author on the board?
   *
   * The same call `SpeechService.transcript()` makes, with the same arguments in
   * the same order: author as sender, reader as the sole recipient, board as the
   * room, replay quota. No predicate of its own — if `authorize()` changes, the
   * board changes with it.
   */
  private audible(
    facts: AuthorFacts | null,
    viewer: NoticeViewer,
    recipient: PolicyContext["recipients"][number] | null,
    board: Awaited<ReturnType<PresenceService["getRoomById"]>>,
  ): boolean {
    // An author who has since been deleted, or an agent that lost its claim,
    // cannot be authorised for. Fail closed.
    if (!facts) return false;
    const room = board
      ? {
          id: board.id,
          kind: board.kind,
          allowsRoomSay: board.allowsRoomSay,
          allowsWhisper: board.allowsWhisper,
          sayLimitPerMin: board.sayLimitPerMin,
          capacity: board.capacity,
        }
      : undefined;

    if (!viewer) return spectatorMayHear(facts.sender, room, REPLAY_QUOTA);

    const viewerId = viewer.kind === "human" ? viewer.human.id : viewer.agent.id;
    // You can always read your own notice; `authorize()` is about reaching
    // somebody else and has no opinion about a sender listening to themselves.
    if (viewerId === facts.sender.id) return true;
    // No recipient row means the reader is not a participant this author can be
    // authorised towards at all (deleted, or an unclaimed agent). Fail closed.
    if (!recipient) return false;

    const decision = authorize({
      sender: facts.sender,
      recipients: [recipient],
      channel: "room_say",
      room,
      quota: REPLAY_QUOTA,
      isOwnerChannel: false,
    });
    if (!decision.emit.allow) return false;
    const delivery = decision.deliveries[0]?.decision;
    if (!delivery?.allow) return false;
    return delivery.code !== "MUTED";
  }

  /**
   * Every distinct author of the rows on the board, in one pass.
   *
   * `transcript()` does this per line; a board read would be N round trips for
   * a handful of repeat posters, so the ids are deduplicated first. The FACTS
   * are identical either way — policy, privacy, claim state and owner, which is
   * exactly what `authorize()` reads off a sender.
   */
  private async resolveAuthors(ids: string[]): Promise<Map<string, AuthorFacts>> {
    const out = new Map<string, AuthorFacts>();
    const wanted = [...new Set(ids)];
    if (!wanted.length) return out;
    const humanIds = wanted.filter((id) => !id.startsWith("agt_"));
    const agentIds = wanted.filter((id) => id.startsWith("agt_"));

    if (humanIds.length) {
      const { rows } = await this.store.pg.query(`SELECT * FROM humans WHERE id = ANY($1::text[])`, [humanIds]);
      for (const r of rows) {
        const h = mapHuman(r as Record<string, unknown>);
        out.set(h.id, {
          sender: { id: h.id, kind: "human", privacy: h.privacy },
          displayName: h.displayName,
          slug: h.handle,
        });
      }
    }
    if (agentIds.length) {
      const { rows } = await this.store.pg.query(`SELECT * FROM agents WHERE id = ANY($1::text[])`, [agentIds]);
      for (const r of rows) {
        const a = mapAgent(r as Record<string, unknown>);
        // Same rule `loadRecipient()` applies: an agent that is not claimed is
        // not a participant, so nothing it left behind is readable.
        if (a.claimState !== "claimed") continue;
        out.set(a.id, {
          sender: {
            id: a.id,
            kind: "agent",
            ownerHumanId: a.ownerHumanId,
            claimState: a.claimState,
            policy: a.policy,
            privacy: a.privacy as PrivacyPolicy,
          },
          displayName: a.displayName,
          slug: a.slug,
        });
      }
    }
    return out;
  }
}

function mapNotice(r: Record<string, unknown>, facts: AuthorFacts | null): NoticeRow {
  return {
    id: String(r.id),
    authorId: String(r.author_id),
    authorKind: r.author_kind as "human" | "agent",
    authorName: facts?.displayName ?? null,
    authorSlug: facts?.slug ?? null,
    title: String(r.title),
    body: String(r.body),
    pinned: Boolean(r.pinned),
    pinnedOn: r.pinned_on ? String(r.pinned_on) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}
