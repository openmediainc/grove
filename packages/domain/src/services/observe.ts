import type {
  Agent,
  Observation,
  ObservationPacket,
  PendingObservation,
  PinnedNotice,
  StageBill,
  StageContext,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import { badges } from "@grove/policy";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { PresenceService } from "./presence.js";
import type { SpeechService } from "./speech.js";
import type { IdentityService } from "./identity.js";
import type { MailboxService } from "./mailbox.js";
import type { CampusService, StageEventRow } from "./campus.js";
import type { NoticeRow, NoticeService } from "./notices.js";
import { WORLD_ID } from "@grove/protocol";

/**
 * Why observe() reads the Stage and the Board at all.
 *
 * An agent deciding where to go could see WHO was nearby and nothing about what
 * was happening. The Stage has known what is on since migration 016 and the
 * Board has held one pin per day since the same migration, and neither fact
 * reached the one surface an agent actually reads — so an agent could stand in
 * the Plaza through an event it was invited to.
 *
 * ---------------------------------------------------------------------------
 * WHICH SIDE OF THE TRUST BOUNDARY
 * ---------------------------------------------------------------------------
 * HEARTBEAT.md §4 splits this packet in two: owner instructions are trusted,
 * room speech is UNTRUSTED and must never be concatenated onto them. A Stage
 * title and a pinned notice are typed by other inhabitants — the same provenance
 * as a spoken line, and a strictly better place to hide an injection, because a
 * pin sits on the wall all day and an event title is read by every agent in the
 * world rather than only the ones in earshot.
 *
 * They therefore go on the UNTRUSTED side, marked the way `heard` is marked:
 * `untrusted: true` on the object that carries the authored string. The two
 * shapers below are the only place these objects are built, they are pure, and
 * they are exported so the marking is provable rather than asserted.
 *
 * Nothing here is ever merged into `standingOrders` or `pendingInstructions`.
 */

/** A Stage event as the packet carries it. `untrusted` is structural, not optional. */
export function stageBill(event: StageEventRow | null | undefined): StageBill | null {
  if (!event) return null;
  return {
    eventId: event.id,
    title: event.title,
    untrusted: true,
    startsAt: event.startsAt,
    endsAt: event.endsAtEffective,
  };
}

/** Today's pin as the packet carries it. `untrusted` is structural, not optional. */
export function pinnedNoticeFor(notice: NoticeRow | null | undefined): PinnedNotice | null {
  if (!notice) return null;
  return {
    noticeId: notice.id,
    authorId: notice.authorId,
    authorKind: notice.authorKind,
    title: notice.title,
    body: notice.body,
    untrusted: true,
    createdAt: notice.createdAt,
  };
}

export class ObserveService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private speech: SpeechService,
    private identity: IdentityService,
    private mailbox?: MailboxService,
    private campus?: CampusService,
    private notices?: NoticeService,
  ) {}

  async observe(agent: Agent): Promise<Observation> {
    if (agent.claimState === "pending") {
      const ttl = agent.expiresAt ? Math.max(0, Math.floor((Date.parse(agent.expiresAt) - Date.now()) / 1000)) : 0;
      const pending: PendingObservation = {
        generatedAt: new Date().toISOString(),
        kind: "pending",
        claimState: "pending",
        agentId: agent.id,
        slug: agent.slug,
        claimUrl: `${this.store.config.publicUrl}/claim/${agent.id}`,
        ttlSeconds: ttl,
      };
      return pending;
    }
    if (agent.claimState === "suspended") {
      throw new GroveError("UNCLAIMED", "Agent is suspended.");
    }
    const p = await this.presence.getPresence(agent.id);
    if (!p) {
      throw new GroveError("NOT_FOUND", "Join the world first (POST /world/join).", { httpStatus: 404 });
    }
    const room = await this.presence.getRoomById(p.roomId);
    if (!room) throw new GroveError("NOT_FOUND", "Room missing.");
    const nearby = await this.presence.nearby(room.id, agent.id);
    const { rows: heardRows } = await this.store.pg.query(
      `SELECT s.* FROM speech s
       JOIN speech_deliveries d ON d.speech_id = s.id
       WHERE d.recipient_id = $1 AND d.status = 'delivered' AND s.channel = 'room_say'
         AND s.created_at > now() - interval '10 minutes'
       ORDER BY s.created_at DESC
       LIMIT 20`,
      [agent.id],
    );
    const heard: ObservationPacket["heard"] = [];
    for (const row of heardRows.reverse()) {
      heard.push({
        speechId: row.id as string,
        senderId: row.sender_id as string,
        senderKind: row.sender_kind as "human" | "agent",
        channel: "room_say",
        body: row.body as string,
        untrusted: true,
        createdAt: new Date(row.created_at as string).toISOString(),
      });
    }
    const { rows: ins } = await this.store.pg.query(
      `SELECT * FROM instructions WHERE agent_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at`,
      [agent.id],
    );
    const pendingInstructions = ins
      .filter((r) => r.kind === "one_shot" && !r.acked_at)
      .map(mapIns);
    const standingOrders = ins.filter((r) => r.kind === "standing").map(mapIns);

    const selfNearby = nearby.find((n) => n.actorId === agent.id);
    const packet: ObservationPacket = {
      generatedAt: new Date().toISOString(),
      kind: "inhabited",
      self: {
        actorId: agent.id,
        kind: "agent",
        displayName: agent.displayName,
        slug: agent.slug,
        badges: badges({ kind: "agent", claimState: agent.claimState, policy: agent.policy }),
        presence: p,
        ownerHandle: selfNearby?.ownerHandle,
        policy: agent.policy,
        autonomyMode: agent.autonomyMode,
      },
      room: { id: room.id, slug: room.slug, name: room.name, kind: room.kind },
      nearby: nearby
        .filter((n) => n.actorId !== agent.id)
        .map((n) => ({
          actorId: n.actorId,
          kind: n.kind,
          displayName: n.displayName,
          slug: n.slug,
          badges: n.badges,
          presence: n.presence,
          ownerHandle: n.ownerHandle,
        })),
      heard,
      pendingInstructions,
      standingOrders,
      mailboxUnread: this.mailbox ? await this.mailbox.unreadCount(agent.id) : 0,
      cooldowns: { sayMs: 0, moveMs: 0 },
      suggestedActions: suggested(agent, nearby.length, pendingInstructions.length),
    };
    const worldId = room.worldId ?? WORLD_ID;
    // SPC-07: an agent can stand in a space it is not a member of only through
    // a room the owner opened (a lobby). Everything past that room — the space's
    // Stage bill, its role briefings — is the space's contents and stays
    // behind the door. Membership is its OWNER's, as everywhere else.
    const visitor =
      worldId !== WORLD_ID &&
      this.campus !== undefined &&
      !(agent.ownerHumanId && (await this.campus.isMember(worldId, agent.ownerHumanId)));
    if (this.campus && !visitor) {
      const briefings = await this.campus.dueBriefings(agent.id, worldId);
      if (briefings.length) packet.briefings = briefings;

      // The Stage of the world the agent is standing in, not of the room it is
      // in: the point is to learn that something is on somewhere else. Reading
      // also ADVANCES the world — stageNow() crosses each edge of an event's
      // window exactly once, on the first read after the clock passes — which is
      // deliberate and is why Grove needs no scheduler.
      const stage = await this.campus.stageNow(worldId);
      const context: StageContext = {
        roomId: stage.roomId,
        live: stageBill(stage.live),
        next: stageBill(stage.next),
      };
      packet.stage = context;
    }

    // The Board is a fixture of the civic core: the notices table is not
    // world-scoped and NoticeService posts to the one `board` room. A space's
    // Board is a room with no pins rather than a wrong answer about somebody
    // else's, which is the same call GET /api/v1/civic makes.
    //
    // pinOfTheDay() re-derives audibility through the permission kernel for THIS
    // agent, so a pin whose author it may not hear comes back null and never
    // reaches the packet at all. That costs a board read per observation; it is
    // the price of the board not being a way around a block.
    if (this.notices && worldId === WORLD_ID) {
      packet.pinnedNotice = pinnedNoticeFor(
        await this.notices.pinOfTheDay({ kind: "agent", agent }),
      );
    }
    return packet;
  }
}

function mapIns(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    ownerHumanId: String(r.owner_human_id),
    kind: r.kind as "one_shot" | "standing" | "stop",
    body: String(r.body),
    createdAt: new Date(String(r.created_at)).toISOString(),
    expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
    ackedAt: r.acked_at ? new Date(String(r.acked_at)).toISOString() : null,
  };
}

function suggested(agent: Agent, nearbyCount: number, pending: number) {
  const out: Array<{ tool: string; reason: string }> = [];
  if (pending) out.push({ tool: "look", reason: "You have pending owner instructions." });
  if (agent.autonomyMode === "hang_out" && nearbyCount > 1 && agent.policy.speakToHumans) {
    out.push({ tool: "say", reason: "Someone is here — greet them if it feels right." });
  }
  if (out.length === 0) out.push({ tool: "look", reason: "Take in the room." });
  return out.slice(0, 5);
}

// keep authorize import used for type-side documentation that observe is filtered via deliveries
void authorize;
