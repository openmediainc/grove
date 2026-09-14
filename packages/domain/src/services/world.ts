import { EMOTE_ENUM, normaliseMarks, publishedDecor, publishedDefaultTheme, publicEstates, readStoredBranding, type Agent, type EmoteKind, type Human, type ToolCallView } from "@grove/protocol";
import type { SupporterService } from "./supporters.js";
import type { GroveStore } from "../store.js";
import { visibleOccupancySql } from "../visibility.js";
import { GroveError } from "../errors.js";
import { newId } from "../ids.js";
import { isStalledPulse, pulseAgeSeconds, STALL_AFTER_SECONDS, type PresenceService } from "./presence.js";
import { spectatorMayHear } from "./speech.js";
import type { IdentityService } from "./identity.js";
import type { FlagService } from "./flags.js";
import type { MailboxService } from "./mailbox.js";
import type { ToolCallService } from "./tool-calls.js";
import { OPEN_ROOMS_SQL, mapOpenRooms } from "./campus.js";
import { UsageService } from "./usage.js";
import { WORLD_ID, WORLD_PUBLIC_NAME } from "@grove/protocol";

export class WorldService {
  constructor(
    private store: GroveStore,
    private presence: PresenceService,
    private identity: IdentityService,
    private flags: FlagService,
    private mailbox?: MailboxService,
    /** Optional so older callers and unit fakes keep working; the app always passes it. */
    private toolCalls?: ToolCallService,
  ) {}

  /** Late-bound (queue #47): which plot owners show a supporter trim. Absent or off = nobody. */
  supporters?: SupporterService;

  async world(worldId: string = WORLD_ID) {
    const rooms = await this.presence.listPublicRooms(worldId);
    const flags = await this.flags.getAll();
    const { rows } = await this.store.pg.query<{ name: string }>(`SELECT name FROM worlds WHERE id = $1`, [worldId]);
    return {
      id: worldId,
      name: rows[0]?.name ?? WORLD_PUBLIC_NAME,
      codeName: "Aetheria",
      rooms,
      flags,
    };
  }

  async emote(actorId: string, kind: string, actorKind: "human" | "agent") {
    await this.flags.assertNotFrozen("freeze.speech", "Emotes are frozen with public speech.");
    if (!(EMOTE_ENUM as readonly string[]).includes(kind)) {
      throw new GroveError("INVALID", "Emote must be one of nod|wave|notes|work|rest.");
    }
    const p = await this.presence.getPresence(actorId);
    if (!p) throw new GroveError("NOT_FOUND", "Join a room first.", { httpStatus: 404 });
    const activity =
      kind === "work" ? "working" : kind === "notes" ? "reading" : kind === "rest" ? "idle" : "chatting";
    await this.presence.touch(actorId, { activity });
    const frame = {
      type: "emote",
      actor_id: actorId,
      kind: actorKind,
      emote: kind as EmoteKind,
      room_id: p.roomId,
    };
    await this.store.redis.publish(`pubsub:room:${p.roomId}`, JSON.stringify(frame));
    if (p.roomId === "plaza") await this.store.redis.publish("sse:plaza", JSON.stringify(frame));
    return frame;
  }

  async createInstruction(
    owner: Human,
    agent: Agent,
    input: { kind: "one_shot" | "standing" | "stop"; body: string },
  ) {
    if (agent.ownerHumanId !== owner.id) throw new GroveError("NOT_FOUND", "Agent not found.", { httpStatus: 404 });
    const id = newId("instruction");
    const expires = input.kind === "one_shot" ? new Date(Date.now() + 24 * 3600 * 1000) : null;
    await this.store.pg.query(
      `INSERT INTO instructions (id, agent_id, owner_human_id, kind, body, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, agent.id, owner.id, input.kind, input.body, expires?.toISOString() ?? null],
    );
    if (input.kind === "stop") {
      await this.store.pg.query(
        `UPDATE instructions SET acked_at = now() WHERE agent_id = $1 AND kind = 'one_shot' AND acked_at IS NULL`,
        [agent.id],
      );
    }
    await this.identity.audit("instruction", owner.id, { instructionId: id, agentId: agent.id, kind: input.kind });
    await this.store.redis.publish(
      `pubsub:actor:${agent.id}`,
      JSON.stringify({ type: "instruction", id, kind: input.kind, body: input.body }),
    );
    await this.mailbox?.enqueueIfOffline(agent.id, "owner_instruction", {
      instructionId: id,
      kind: input.kind,
      body: input.body,
      ownerHumanId: owner.id,
    });
    return { id, kind: input.kind };
  }

  async ackInstruction(agent: Agent, instructionId: string) {
    const { rows } = await this.store.pg.query(
      `UPDATE instructions SET acked_at = now() WHERE id = $1 AND agent_id = $2 RETURNING *`,
      [instructionId, agent.id],
    );
    if (!rows[0]) throw new GroveError("NOT_FOUND", "Instruction not found.", { httpStatus: 404 });
    return { id: instructionId, acked: true };
  }

  /**
   * The last few public lines a logged-out spectator is allowed to hear.
   * A quiet Plaza reads as a dead world, so the landing needs history, not just
   * the live feed. Who may hear what is decided by `spectatorMayHear` — the same
   * exported gate the live SSE path uses — rather than re-implemented here.
   */
  async recentPublicSpeech(limit = 3) {
    const { rows } = await this.store.pg.query(
      `SELECT s.id, s.body, s.created_at, s.sender_id, s.sender_kind,
              a.policy AS agent_policy, a.privacy AS agent_privacy, a.claim_state,
              a.owner_human_id, h.privacy AS human_privacy,
              COALESCE(a.display_name, h.display_name) AS display_name
         FROM speech s
         LEFT JOIN agents a ON a.id = s.sender_id
         LEFT JOIN humans h ON h.id = s.sender_id
        WHERE s.channel = 'room_say' AND s.room_id = 'plaza'
          AND s.created_at > now() - interval '6 hours'
        ORDER BY s.created_at DESC LIMIT 40`,
    );
    const room = {
      id: "plaza",
      kind: "public" as const,
      allowsRoomSay: true,
      allowsWhisper: true,
      sayLimitPerMin: null,
      capacity: 80,
    };
    // Historical read: the sender already passed rate limiting when they spoke,
    // so replaying must not deny them a second time.
    const quota = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
    const out: Array<{ speechId: string; senderId: string; senderName: string; body: string; createdAt: string }> = [];
    for (const r of rows) {
      const kind = r.sender_kind as "human" | "agent";
      const sender =
        kind === "agent"
          ? {
              id: String(r.sender_id),
              kind: "agent" as const,
              ownerHumanId: (r.owner_human_id as string | null) ?? null,
              claimState: r.claim_state as Agent["claimState"],
              policy: jsonPolicy(r.agent_policy),
              privacy: jsonPrivacy(r.agent_privacy),
            }
          : {
              id: String(r.sender_id),
              kind: "human" as const,
              privacy: jsonPrivacy(r.human_privacy),
            };
      if (!spectatorMayHear(sender, room, quota)) continue;
      out.push({
        speechId: String(r.id),
        senderId: String(r.sender_id),
        senderName: String(r.display_name ?? r.sender_id),
        body: String(r.body),
        createdAt: new Date(String(r.created_at)).toISOString(),
      });
      if (out.length >= limit) break;
    }
    return out.reverse();
  }

  async plazaSnapshot() {
    const room = await this.presence.getRoomById("plaza");
    const nearby = await this.presence.nearby("plaza");
    return {
      room,
      nearby: nearby.map((n) => ({
        actorId: n.actorId,
        kind: n.kind,
        displayName: n.displayName,
        slug: n.slug,
        badges: n.badges,
        presence: n.presence,
        ownerHandle: n.ownerHandle,
        avatarId: n.avatarId,
      })),
      recentSpeech: await this.recentPublicSpeech(),
    };
  }

  /**
   * The public map. Polled by every spectator every 8 seconds, logged out, so
   * it is the one read where duplicated work is multiplied by the audience.
   *
   * Concurrent callers for the same world share ONE build rather than each
   * running the same dozen statements: whoever arrives while a build is in
   * flight is handed that build's promise. This is deliberately NOT a timed
   * cache — nothing is ever served after its build finished, so a caller that
   * asks after a write still sees that write, and read-after-write (an agent
   * pulsing and then looking at the map) keeps working exactly as before.
   */
  async minimap(worldId: string = WORLD_ID) {
    const inFlight = this.minimapInFlight.get(worldId);
    if (inFlight) return inFlight;
    const build = this.buildMinimap(worldId).finally(() => {
      if (this.minimapInFlight.get(worldId) === build) this.minimapInFlight.delete(worldId);
    });
    this.minimapInFlight.set(worldId, build);
    return build;
  }

  private minimapInFlight = new Map<string, Promise<MinimapSnapshot>>();

  private async buildMinimap(worldId: string = WORLD_ID) {
    const rooms = await this.presence.listPublicRooms(worldId);
    const bodies: Array<{
      id: string;
      kind: "human" | "agent";
      displayName: string;
      slug: string;
      roomId: string;
      roomSlug: string;
      activity: string;
      connection: string;
      /** The social contract, already computed by `nearby()`. The map draws it
       *  so a watcher can see why an agent will or will not answer them. */
      badges: string[];
      verb: string | null;
      detail: string | null;
      pulsedAt: string | null;
      /** Seconds since the last pulse; null if this body has never pulsed. */
      pulseAgeSeconds: number | null;
      /** Claiming an active verb but silent past the stall threshold. */
      stalled: boolean;
      url: string | null;
      errorText: string | null;
      /** Org identity, already resolved here so the map never asks per body.
       *  Null when this body reads as no org in this world. */
      orgId: string | null;
      orgColour: string | null;
      /** Stance (autonomy_mode) for agents; null for humans. */
      stance: string | null;
      /**
       * Open tool-call spans, then any that finished in the last
       * TOOL_RESULT_VISIBLE_SECONDS (migration 020). Empty for a body that
       * does not report spans — which the map shows as "no shape", not as idle.
       */
      toolCalls: ToolCallView[];
      /** A turn that just finished and reported usage: the body carries a load
       *  to the treasury. Time and priced-or-not only, never an amount — this
       *  payload is readable by anyone who can see the world. See migration 024. */
      deposit: { at: string; costed: boolean } | null;
      source: "grove";
    }> = [];
    // One clock, one rule: every consumer of the minimap agrees on what is
    // stalled instead of each client reimplementing the age arithmetic.
    const now = Date.now();
    // One statement for every room, not one per room: see nearbyByRooms().
    const byRoom = await this.presence.nearbyByRooms(rooms.map((r) => r.id));
    // Kept beside the payload, never in it: who owns an agent is not public
    // map data, it is only how a tint finds the body's org.
    const ownerOf = new Map<string, string | null>();
    for (const room of rooms) {
      for (const n of byRoom.get(room.id) ?? []) {
        ownerOf.set(n.actorId, n.kind === "human" ? n.actorId : (n.ownerHumanId ?? null));
        bodies.push({
          id: n.actorId,
          kind: n.kind,
          displayName: n.displayName,
          slug: n.slug,
          roomId: room.id,
          roomSlug: room.slug,
          activity: n.presence.activity,
          connection: n.presence.connection,
          badges: n.badges as unknown as string[],
          verb: n.presence.verb ?? null,
          detail: n.presence.detail ?? null,
          pulsedAt: n.presence.pulsedAt ?? null,
          pulseAgeSeconds: pulseAgeSeconds(n.presence.pulsedAt, now),
          stalled: isStalledPulse(n.presence.verb, n.presence.pulsedAt, now),
          url: n.presence.url ?? null,
          errorText: n.presence.errorText ?? null,
          orgId: null,
          orgColour: null,
          stance: n.stance ?? null,
          toolCalls: [],
          deposit: null,
          source: "grove",
        });
      }
    }
    // Tool-call spans for every agent body, in one statement, on the same clock.
    if (this.toolCalls) {
      const agentIds = bodies.filter((b) => b.kind === "agent").map((b) => b.id);
      const spans = await this.toolCalls.forActors(agentIds, now);
      for (const b of bodies) b.toolCalls = spans.get(b.id) ?? [];
    }
    {
      const agentIds = bodies.filter((b) => b.kind === "agent").map((b) => b.id);
      const deposits = await new UsageService(this.store).recentDeposits(agentIds);
      for (const b of bodies) b.deposit = deposits.get(b.id) ?? null;
    }
    // Claimed land. The minimap is public, so a private space shows that it is
    // held and at what access level, but not its name or owner — permission
    // state is public (SoW 5.5), the contents behind it are not.
    const { rows: spaceRows } = await this.store.pg.query(
      `SELECT w.id, w.slug, w.name, w.plot_index, w.policy_preset, h.handle AS owner_handle, w.owner_human_id,
              -- Public map, no viewer: a private plot (or a private room on a
              -- public one) contributes no headcount. Shared predicate, #50.
              ${visibleOccupancySql("w", "NULL")} AS occupancy,
              -- Bound orgs inline, the same subselect (and order) the space
              -- directory uses, so a plot can be tinted without a call per plot.
              COALESCE((SELECT json_agg(json_build_object(
                          'id', o.id, 'slug', o.slug, 'name', o.name, 'colour', o.colour)
                          ORDER BY wo.created_at, o.id)
                        FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
                        WHERE wo.world_id = w.id), '[]'::json) AS orgs,
              -- SPC-07: rooms opened to non-members. Shown even on a private
              -- plot: a public lobby shows ONLY itself, never the space around it.
              ${OPEN_ROOMS_SQL} AS open_rooms,
              -- 030: which achievement marks the space holds. Keys only, never
              -- a count, so there is nothing to rank by.
              (SELECT array_agg(sm.mark) FROM space_marks sm WHERE sm.world_id = w.id) AS marks,
              -- 035: the owner's accent, sign text and emblem.
              w.branding,
              -- #45: the owner's placed decor; re-checked against unlocks below.
              w.decor,
              -- #59: the owner's default theme; redacted below for a private plot.
              w.default_theme,
              -- #37 estates: the chosen names, and the primary org by id. Used
              -- to group and name estates here; never published per plot.
              h.estate_name AS owner_estate_name,
              (SELECT json_build_object('id', o.id, 'estateName', o.estate_name)
                 FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
                WHERE wo.world_id = w.id
                ORDER BY wo.created_at, o.id LIMIT 1) AS primary_org
       FROM worlds w LEFT JOIN humans h ON h.id = w.owner_human_id
       WHERE w.plot_index IS NOT NULL
       ORDER BY w.plot_index`,
    );
    // #47: cosmetic only. Empty (and no query) while supporters are switched off.
    const supporterOwners = await (this.supporters?.activeAmong(spaceRows.map((r) => r.owner_human_id as string | null)) ??
      Promise.resolve(new Set<string>()));
    const spaces = spaceRows.map((r) => {
      const preset = String(r.policy_preset);
      const open = preset !== "private";
      return {
        id: String(r.id),
        plotIndex: Number(r.plot_index),
        policyPreset: preset,
        occupancy: Number(r.occupancy),
        slug: open ? String(r.slug) : null,
        name: open ? String(r.name) : null,
        ownerHandle: open && r.owner_handle ? String(r.owner_handle) : null,
        // Which orgs live on a plot is part of what is behind a private door,
        // so it redacts with the name and the owner rather than separately.
        orgs: open ? ((r.orgs as OrgBadge[] | null) ?? []) : [],
        openRooms: mapOpenRooms(r.open_rooms),
        // A private plot never shows marks: what was done behind a closed door
        // is part of what is behind it, like its name.
        marks: open ? normaliseMarks(r.marks) : [],
        // Branding redacts with the name: a colour and an emblem can identify a
        // private space as surely as its name can, so none of it leaves here.
        branding: open ? readStoredBranding(r.branding) : null,
        // Supporter trim for the signboard (TODO art after #33). Redacted on a
        // private plot like the owner it describes. Never a permission.
        supporter: open && supporterOwners.has(String(r.owner_human_id)),
        // #45 decor: never for a private plot (held land shows nothing); items
        // whose unlock (a mark, the owner's supporter perk) is gone are dropped.
        decor: open
          ? publishedDecor(preset, r.decor, { marks: r.marks as unknown[] | null, supporter: supporterOwners.has(String(r.owner_human_id)) })
          : [],
        // #59 owner default theme: never for a private plot (members read it
        // through the member-gated detail instead).
        defaultTheme: publishedDefaultTheme(preset, r.default_theme),
      };
    });

    // #37: adjacent plots of one org or one owner join as an estate. Grouped
    // from the raw rows (owner and org ids), published without them; private
    // plots never join, bridge or appear (protocol estates.ts).
    const estates = publicEstates(
      spaceRows.map((r, i) => {
        const space = spaces[i]!;
        const primary = r.primary_org as { id?: string; estateName?: string | null } | null;
        const org = space.orgs[0];
        return {
          plotIndex: space.plotIndex,
          preset: space.policyPreset,
          ownerId: (r.owner_human_id as string | null) ?? null,
          ownerHandle: space.ownerHandle,
          ownerEstateName: (r.owner_estate_name as string | null) ?? null,
          orgId: primary?.id ?? null,
          orgName: org?.name ?? null,
          orgColour: org?.colour ?? null,
          orgEstateName: primary?.estateName ?? null,
          accent: space.branding?.accent ?? null,
        };
      }),
    );

    // Org colour for the bodies standing in THIS world. Safe to publish: the
    // caller already had to pass the world gate to get a minimap at all, so a
    // private space's membership never reaches someone outside it — and the
    // plots above (other worlds) redact their orgs with their names.
    const orgRenderMode = await this.orgRenderMode(worldId);
    const orgs = await this.boundOrgs(worldId);
    if (orgs.length) {
      const tints = await this.orgTints(worldId, orgRenderMode, orgs[0]!, bodies, ownerOf);
      for (const b of bodies) {
        const tint = tints.get(b.id);
        if (!tint) continue;
        b.orgId = tint.orgId;
        b.orgColour = tint.colour;
      }
    }

    const { rows } = await this.store.pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agents WHERE claim_state = 'claimed'`,
    );
    return {
      rooms: rooms.map((r) => ({ id: r.id, slug: r.slug, name: r.name, occupancy: r.occupancy })),
      bodies,
      spaces,
      /** Joined estates over the public plots above (#37). Access stays per plot. */
      estates,
      /**
       * Agents resting at their home plot while nobody runs them. Deliberately
       * NOT in `bodies`: everything that counts or watches live bodies (the
       * headcount, TV cuts, the idle bell, search's Online now) reads `bodies`,
       * and a resting body is none of those things. See restingAtPlots().
       */
      resting: await this.restingAtPlots(),
      recentSpeech: await this.recentPublicSpeech(3),
      claimedAgents: rows[0]?.n ?? 0,
      stallAfterSeconds: STALL_AFTER_SECONDS,
      /** How this world paints its orgs; see campus.orgRenderFor(). */
      orgRenderMode,
      /** Legend for the colours on the bodies above. */
      orgs,
    };
  }

  /**
   * "Resting at plot": a claimed agent with NO presence row anywhere (its
   * runtime is gone; eviction already happened) whose home room is on a live
   * claimed plot. The map draws it dimmed at that plot, never as work — the
   * payload carries no verb, pulse, span or stance to draw work from.
   *
   * Public map, so the same redaction the plots follow, applied in SQL before
   * anything is read: a `private` plot never reveals who rests in it (not a
   * redacted row, not a count), and neither does a room whose own door is
   * `private` on an otherwise public plot. Pending agents and agents of a
   * suspended owner are left out, as they are from search.
   */
  async restingAtPlots(): Promise<RestingBody[]> {
    const { rows } = await this.store.pg.query(
      `SELECT id, slug, display_name, plot_index FROM (
         SELECT a.id, a.slug, a.display_name, w.plot_index,
                row_number() OVER (PARTITION BY w.id ORDER BY a.claimed_at NULLS LAST, a.id) AS n
           FROM agents a
           JOIN rooms r ON r.id = a.home_room_id
           JOIN worlds w ON w.id = r.world_id
           LEFT JOIN humans h ON h.id = a.owner_human_id
          WHERE a.claim_state = 'claimed'
            AND w.plot_index IS NOT NULL
            AND w.archived_at IS NULL
            AND w.policy_preset <> 'private'
            AND (r.room_preset IS NULL OR r.room_preset <> 'private')
            AND h.suspended_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM presence p WHERE p.actor_id = a.id)
       ) t
       WHERE n <= $1
       ORDER BY plot_index, n
       LIMIT $2`,
      [RESTING_PER_PLOT, RESTING_MAX],
    );
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      displayName: String(r.display_name),
      plotIndex: Number(r.plot_index),
    }));
  }

  /** How this world paints bound orgs. Unknown values read as 'shared'. */
  private async orgRenderMode(worldId: string): Promise<"shared" | "dedicated"> {
    const { rows } = await this.store.pg.query<{ org_render_mode: string | null }>(
      `SELECT org_render_mode FROM worlds WHERE id = $1`,
      [worldId],
    );
    return rows[0]?.org_render_mode === "dedicated" ? "dedicated" : "shared";
  }

  /**
   * Orgs bound to a world, public fields only. Same ordering as
   * campus.orgsOf(): first bound wins wherever a body could take two colours,
   * so the map and the space page never disagree about which colour that is.
   */
  private async boundOrgs(worldId: string): Promise<OrgBadge[]> {
    const { rows } = await this.store.pg.query(
      `SELECT o.id, o.slug, o.name, o.colour
         FROM world_orgs wo JOIN orgs o ON o.id = wo.org_id
        WHERE wo.world_id = $1
        ORDER BY wo.created_at, o.id`,
      [worldId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      colour: String(r.colour),
    }));
  }

  /**
   * One tint per body, by the same two rules campus.orgRenderFor() applies:
   *
   *   dedicated — the space IS one org's home, so every body standing in it
   *               takes that org's colour, member or not.
   *   shared    — a body takes ITS OWN org's colour, and only when that org is
   *               bound here. A body in no bound org stays untinted.
   *
   * A body's org is its owner human's: an agent holds no membership of its
   * own, so it inherits through owner_human_id.
   */
  private async orgTints(
    worldId: string,
    mode: "shared" | "dedicated",
    home: OrgBadge,
    bodies: Array<{ id: string; kind: "human" | "agent" }>,
    /** body id -> the human it counts as: itself, or an agent's owner. */
    ownerOf: Map<string, string | null>,
  ): Promise<Map<string, { orgId: string; colour: string }>> {
    const out = new Map<string, { orgId: string; colour: string }>();
    if (bodies.length === 0) return out;
    if (mode === "dedicated") {
      for (const b of bodies) out.set(b.id, { orgId: home.id, colour: home.colour });
      return out;
    }
    // A body's org is its owner human's; an agent holds no membership of its
    // own. The owner came back with the body (nearbyByRooms already joins it),
    // so this no longer costs a second pass over `agents`.
    const humanOf = (b: { id: string; kind: "human" | "agent" }) =>
      b.kind === "human" ? b.id : ownerOf.get(b.id) ?? null;
    const humanIds = [...new Set(bodies.map(humanOf).filter((id): id is string => Boolean(id)))];
    if (humanIds.length === 0) return out;
    const { rows } = await this.store.pg.query(
      // DISTINCT ON keeps one colour per human: a human in two bound orgs takes
      // the one bound first, the same tie-break campus.orgRenderFor() uses, so
      // the map never flickers between two colours.
      //
      // The id list arrives as a table (unnest) rather than as `= ANY(array)`:
      // with a crowd on the map that array is thousands long and Postgres
      // rescans it for every membership row, which is quadratic. Joined, it is
      // hashed once. Same rows, same order, same tie-break.
      `SELECT DISTINCT ON (om.human_id) om.human_id, o.id AS org_id, o.colour
         FROM org_members om
         JOIN unnest($2::text[]) AS want(human_id) ON want.human_id = om.human_id
         JOIN world_orgs wo ON wo.org_id = om.org_id AND wo.world_id = $1
         JOIN orgs o ON o.id = wo.org_id
        ORDER BY om.human_id, wo.created_at, o.id`,
      [worldId, humanIds],
    );
    const byHuman = new Map<string, { orgId: string; colour: string }>(
      rows.map((r) => [String(r.human_id), { orgId: String(r.org_id), colour: String(r.colour) }]),
    );
    for (const b of bodies) {
      const humanId = humanOf(b);
      const tint = humanId ? byHuman.get(humanId) : undefined;
      if (tint) out.set(b.id, tint);
    }
    return out;
  }
}

/** Most agents drawn resting on one plot: the plot's open tiles, not a crowd. */
export const RESTING_PER_PLOT = 12;
/** Most resting bodies on the whole map, so a big world cannot bloat the poll. */
export const RESTING_MAX = 400;

/** An agent resting at its home plot. Name and plot only: nothing to draw work from. */
export interface RestingBody {
  id: string;
  slug: string;
  displayName: string;
  plotIndex: number;
}

/** What buildMinimap() returns; named so concurrent callers can share one. */
type MinimapSnapshot = Awaited<ReturnType<WorldService["buildMinimap"]>>;

/** An org as the map needs it: enough to draw and name a colour, nothing more. */
type OrgBadge = { id: string; slug: string; name: string; colour: string };

/** presence/agent JSONB -> the camelCase shapes the kernel expects. */
function jsonPolicy(raw: unknown): Agent["policy"] {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    speakToAgents: Boolean(o.speak_to_agents ?? o.speakToAgents),
    speakToHumans: Boolean(o.speak_to_humans ?? o.speakToHumans),
    listenToAgents: Boolean(o.listen_to_agents ?? o.listenToAgents),
    listenToHumans: Boolean(o.listen_to_humans ?? o.listenToHumans),
  };
}

/** Absent keys default to true, matching the column defaults. */
function jsonPrivacy(raw: unknown): {
  addressableByAgents: boolean;
  addressableByHumans: boolean;
  overhearableByAgents: boolean;
  overhearableByHumans: boolean;
} {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (a: string, b: string) => {
    const v = o[a] ?? o[b];
    return v === undefined ? true : Boolean(v);
  };
  return {
    addressableByAgents: pick("addressable_by_agents", "addressableByAgents"),
    addressableByHumans: pick("addressable_by_humans", "addressableByHumans"),
    overhearableByAgents: pick("overhearable_by_agents", "overhearableByAgents"),
    overhearableByHumans: pick("overhearable_by_humans", "overhearableByHumans"),
  };
}
