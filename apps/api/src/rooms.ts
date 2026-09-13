import type { FastifyInstance } from "fastify";
import type { GroveApp } from "@grove/domain";
import { WORLD_ID } from "@grove/protocol";
import { assertWorldAccess, optionalActor, type Actor } from "./auth.js";
import { sendOk } from "./http.js";

/**
 * What each civic room is DOING.
 *
 * Lives in its own module, registered from app.ts exactly like registerPlatform
 * and registerModeration. Paths are /api/v1/civic/*; nothing in routes.ts or
 * platform.ts is touched or shadowed.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROOM STATE, RATHER THAN A STAGE ENDPOINT AND A BOARD ENDPOINT
 * ---------------------------------------------------------------------------
 * Grove has six civic rooms and, until now, exactly one mechanical difference
 * between any of them (the Garden's 3/min cap). The obvious fix — teach the map
 * that "stage" means draw a marquee and "board" means draw a pin — puts the
 * meaning in the renderer, where it has to be re-taught to every surface and
 * re-learnt by every future room.
 *
 * So every room answers with the SAME envelope: a `state` from a closed set, a
 * server-composed `headline`, an expiry, and a texture of what the bodies in it
 * are doing. The Stage is "live" because an event is running in it, not because
 * it is called the Stage; a space's Stage room gets the same treatment for free;
 * the Workshop reads "busy — 3 at work" out of presence with no rule of its own.
 * A renderer draws states, never room names, and stays correct when a seventh
 * room appears.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DISCLOSED
 * ---------------------------------------------------------------------------
 * Two headlines say something that was not already public, and each is gated by
 * the thing that already owns that decision:
 *
 *  - The Stage's headline is an event title. The world gate runs first
 *    (assertWorldAccess), so a space's schedule is unreachable to a non-member;
 *    inside the commons a Stage event is public by construction — `stage` ships
 *    with spectator_visible TRUE, which is the world saying its Stage is for
 *    watching. A room WITHOUT spectator_visible never gets a headline for a
 *    signed-out caller.
 *  - The Board's headline is the day's pinned notice. It is not read here at
 *    all: NoticeService.board() runs it through authorize() for this exact
 *    viewer, and through spectatorMayHear() for a signed-out one. If the kernel
 *    would not deliver that line to this reader, `pin` comes back null and the
 *    Board reads as unpinned. There is no path through this file that can show
 *    a line its author was not allowed to say to the person looking.
 */

/** The closed set. A renderer maps state -> how it draws; it never reads a slug. */
const ROOM_STATES = ["empty", "quiet", "busy", "live", "posted"] as const;
type RoomState = (typeof ROOM_STATES)[number];

/** presence.activity -> the words a headline uses. Unknown activities are counted, not named. */
const ACTIVITY_PHRASE: Record<string, string> = {
  working: "at work",
  reading: "reading",
  chatting: "talking",
  idle: "resting",
};

/** Anything below this is "someone is here", not "something is happening". */
const BUSY_THRESHOLD = 2;

interface RoomStatus {
  id: string;
  slug: string;
  name: string;
  kind: string;
  capacity: number;
  occupancy: number;
  spectatorVisible: boolean;
  allowsRoomSay: boolean;
  /** The Garden's 3/min is a fact about the room; the map may as well show it. */
  sayLimitPerMin: number | null;
  state: RoomState;
  /** One line, composed here. Never a payload dump, never a body. */
  headline: string | null;
  /** Who the headline belongs to, when it belongs to someone. */
  byline: string | null;
  /** When this state runs out: an event's end, or the pin's UTC midnight. */
  until: string | null;
  /** Counts by presence activity, for texture. Derived from what the viewer may see. */
  activity: Record<string, number>;
}

function phrase(activity: string, n: number): string {
  const words = ACTIVITY_PHRASE[activity];
  return words ? `${n} ${words}` : `${n} ${activity}`;
}

/**
 * The busiest thing happening in a room, or null when it is just occupancy.
 * `idle` never wins: a room full of people resting is quiet, which is exactly
 * what the Garden is for.
 */
function dominant(activity: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [name, n] of Object.entries(activity)) {
    if (name === "idle") continue;
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best && bestN >= BUSY_THRESHOLD ? phrase(best, bestN) : null;
}

export async function registerRooms(app: FastifyInstance, grove: GroveApp) {
  /**
   * Every civic room, and what it is doing. One round trip: a map that has to
   * ask three endpoints to draw one frame will draw an inconsistent one.
   *
   * Deliberately NOT behind requireActor, for the same reason
   * /api/v1/world/minimap is not: the landing page is public and a signed-out
   * visitor should be able to see that something is on. Every line that is not
   * already public is gated per-viewer below.
   */
  app.get("/api/v1/civic", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const worldId = await assertWorldAccess(req, grove, actor);
    const viewerId = actor ? (actor.kind === "human" ? actor.human.id : actor.agent.id) : undefined;

    const rooms = await grove.presence.listPublicRooms(worldId);
    const byRoom = await grove.presence.nearbyByRooms(
      rooms.map((r) => r.id),
      viewerId,
    );
    const stage = await grove.campus.stageNow(worldId);
    // Notices are a fixture of the civic core — the table is not world-scoped
    // and NoticeService posts to the one `board` room. A space's Board is a room
    // with no pins rather than a wrong answer about somebody else's.
    const board = worldId === WORLD_ID ? await grove.notices.board(viewerOf(actor)) : null;

    const statuses: RoomStatus[] = rooms.map((room) => {
      const nearby = byRoom.get(room.id) ?? [];
      const activity: Record<string, number> = {};
      for (const n of nearby) {
        const key = n.presence.activity;
        activity[key] = (activity[key] ?? 0) + 1;
      }

      // ONE precedence, written once, applied to every room:
      //
      //   live   — an event is running here. The only state with a hard clock
      //            on it, and the only one that says "walk in NOW".
      //   posted — today's pin is up. What you came to the Board to read.
      //   next   — nothing is on, but something is scheduled here. Not a state
      //            of its own: the room really is still quiet, it just knows
      //            what is coming, so `until` counts down to the START.
      //   busy   — enough bodies doing the same thing to be worth naming.
      //   quiet  — somebody is here.
      //   empty  — nobody is.
      //
      // Nothing below branches on a room's slug or name. The Stage is lit
      // because an event is in it; a space's Stage, or a seventh room that
      // schedules something one day, lights up by the same line of code.
      const isStageRoom = room.id === stage.roomId;
      const busy = dominant(activity);

      let state: RoomState = room.occupancy > 0 ? "quiet" : "empty";
      let headline: string | null = null;
      let byline: string | null = null;
      let until: string | null = null;

      if (isStageRoom && stage.live) {
        state = "live";
        headline = stage.live.title;
        until = stage.live.endsAtEffective;
      } else if (board?.pin && room.id === "board") {
        state = "posted";
        headline = board.pin.title;
        byline = board.pin.authorSlug ?? board.pin.authorName;
        until = board.pinOpensAt;
      } else if (isStageRoom && stage.next) {
        if (busy) state = "busy";
        headline = `Next: ${stage.next.title}`;
        until = stage.next.startsAt;
      } else if (busy) {
        state = "busy";
        headline = busy;
      }

      // A signed-out caller gets a headline only from a room the world has
      // already declared watchable. spectator_visible is that declaration, and
      // it is a column on the room, not a list of slugs in this file.
      if (!actor && !room.spectatorVisible) {
        headline = null;
        byline = null;
        until = null;
      }

      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        kind: room.kind,
        capacity: room.capacity,
        occupancy: room.occupancy,
        spectatorVisible: room.spectatorVisible,
        allowsRoomSay: room.allowsRoomSay,
        sayLimitPerMin: room.sayLimitPerMin,
        state,
        headline,
        byline,
        until,
        activity,
      };
    });

    return sendOk(reply, {
      worldId,
      generatedAt: new Date().toISOString(),
      rooms: statuses,
      /** The legend, served with the data so a renderer cannot drift from it. */
      states: ROOM_STATES,
      stage: { roomId: stage.roomId, live: stage.live, next: stage.next },
      board: board ? { day: board.day, pinned: Boolean(board.pin), pinOpensAt: board.pinOpensAt } : null,
    });
  });

  /** The Stage's own schedule: what is on, what is next, what just came down. */
  app.get("/api/v1/civic/stage", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const worldId = await assertWorldAccess(req, grove, actor);
    const stage = await grove.campus.stageNow(worldId);
    return sendOk(reply, { stage });
  });

  /**
   * The Board, as this reader is allowed to see it.
   *
   * `withheld` is a count and nothing else. A reader is owed the fact that the
   * board is not empty — otherwise a filtered board is indistinguishable from a
   * broken one — but not a single word about what they are missing or who from.
   */
  app.get("/api/v1/civic/board", async (req, reply) => {
    const actor = await optionalActor(req, grove);
    const worldId = await assertWorldAccess(req, grove, actor);
    if (worldId !== WORLD_ID) {
      // Same shape, honestly empty. A space has a Board room; the notices table
      // belongs to the commons.
      return sendOk(reply, {
        board: { day: new Date().toISOString().slice(0, 10), pin: null, posts: [], withheld: 0, pinOpensAt: null },
      });
    }
    const board = await grove.notices.board(viewerOf(actor));
    return sendOk(reply, { board });
  });
}

/** An authenticated actor as NoticeService reads it; null is a spectator. */
function viewerOf(actor: Actor | null) {
  if (!actor) return null;
  return actor.kind === "human"
    ? ({ kind: "human", human: actor.human } as const)
    : ({ kind: "agent", agent: actor.agent } as const);
}
