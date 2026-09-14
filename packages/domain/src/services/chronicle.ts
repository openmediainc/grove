import { BOARD_GAME_NAMES, WORLD_ID, boardEndWords, isBoardGame, type ReactionTarget } from "@grove/protocol";
import { GroveError } from "../errors.js";
import type { GroveStore } from "../store.js";
import { roomActivityVisibleSql } from "../visibility.js";

/**
 * The reader over `world_events`.
 *
 * The map answers "now". This answers "what happened while I was asleep" — the
 * one question an append-only ledger is for and the one thing nothing in Grove
 * read until now.
 *
 * ---------------------------------------------------------------------------
 * THE LEAK PROBLEM
 * ---------------------------------------------------------------------------
 * The ledger is written indiscriminately, by design: identity, presence,
 * speech, notices and moderation all drop a row in without asking who may
 * later read it. A reader that simply SELECTs is therefore a disclosure
 * machine — it would publish whispers, private-space activity, who reported
 * whom, and which senders tripped the injection heuristic.
 *
 * So every rule below is enforced INSIDE the SQL, never in the API layer and
 * never in the browser. `visible` is a CTE; nothing that fails it is ever
 * materialised into a result row, and a speech body is replaced with NULL by
 * the same query that decides whether it may be shown. There is no code path
 * that can forget to filter.
 *
 * The rules, and why each one:
 *
 *  1. WORLD GATE. Every event is resolved to a world by joining `rooms` on the
 *     room id in the payload. A non-commons world is visible only when its
 *     policy_preset is not 'private', or the viewer owns it or is a member.
 *     This is character-for-character the rule already in force in
 *     campus.listDirectory() and world.minimap(): a private plot you are not
 *     in shows as a plot number and nothing else. History does not get a
 *     weaker rule than the live map. Operators get NO bypass here —
 *     assertWorldAccess() gives them none either, and the chronicle must not
 *     become the back door into a campus that the front door refuses.
 *
 *  2. SPEECH. Only `room_say` ever appears. `whisper`, `owner_reply` and
 *     `owner_instruction` are excluded for everybody, operators included:
 *     they have their own consented surfaces (ownerThread, the report
 *     snapshot), and a moderator needs evidence attached to a report, not a
 *     firehose of every private line in Grove.
 *     The BODY is shown only to the sender, to an actor with a
 *     `speech_deliveries` row of status 'delivered', or to an operator inside
 *     a world they can already see. speech_deliveries is the world's own
 *     record of who was actually allowed to hear the line at the time it was
 *     said — blocks, mutes, lurk, agent policy and the space ceiling are all
 *     already baked into it. Re-deriving audibility now (which is what
 *     speech.transcript() does for a live room) would answer with TODAY's
 *     permissions, so a line said while you were blocked would become
 *     readable the moment the block lifted. Deliveries cannot drift.
 *     A viewer who was not there still sees THAT a line was spoken, because
 *     any authenticated actor can already read a reachable room's transcript;
 *     the fact is strictly less than the existing route grants.
 *
 *     There is a THIRD holder of a delivery row, and it is not an actor:
 *     `hum_spectator`. speech.ts persists one for the synthetic spectator on
 *     exactly the lines it also publishes to `sse:plaza` — the same
 *     `spectatorHears` expression drives both, so the row exists if and only if
 *     the line was broadcast. `GET /api/v1/sse/plaza` takes no credential at
 *     all (it hijacks the reply before any auth runs), so a line with that row
 *     was already handed, body and all, to every anonymous client on the
 *     internet. Admitting it here therefore publishes strictly LESS than has
 *     already happened, and it does not weaken the principle above: the row is
 *     written at say-time from the context that produced every other delivery,
 *     by the same policy kernel — an agent that may not speak to humans is
 *     denied the spectator too, because SPECTATOR_RECIPIENT is `kind: human`.
 *     It is a record of what the world broadcast, frozen when it broadcast it;
 *     nothing is re-derived against today's permissions.
 *     The clause still sits inside the `$1::text IS NOT NULL` guard, so it is
 *     signed-in-only. That is belt-and-braces rather than a rule: an anonymous
 *     viewer never reaches a speech row at all (rule 4), so there is no body
 *     for this to withhold from them.
 *     The SQL matches the id as a literal. What keeps that literal honest is
 *     the end-to-end test in test/speech-wiring.test.ts, which speaks in the
 *     Plaza and then reads the body back as a bystander: rename the constant in
 *     speech.ts and that test goes red rather than the feature going quietly
 *     dark again.
 *
 *  3. MODERATION-GRADE. Fail closed, and split by who is actually owed the
 *     information:
 *       - `block` — the blocker alone. Not operators, and above all not the
 *         blocked party: telling someone they were blocked is the retaliation
 *         vector the block existed to close.
 *       - `report` — the reporter and operators. Never the target, same
 *         reason.
 *       - `report_resolved`, `operator_bootstrap` — operators. One names a
 *         moderation decision, the other is the privilege-escalation record.
 *       - `suspended`, `prompt_injection_flag` — operators, plus the subject
 *         and the subject's owner. An owner has to be able to see why their
 *         agent went quiet; publishing it more widely would turn a heuristic
 *         accusation into a public accusation, and would teach an attacker
 *         exactly which phrasings trip the filter.
 *       - `key_rotated` / `key_revoked` — the agent's owner and operators.
 *         Credential timing is an attacker's signal.
 *       - `instruction` — the owner alone (plus operators). The owner→agent
 *         leash is private; even the instruction KIND ("stop") is a statement
 *         about how someone runs their agent.
 *
 *  4. ANONYMOUS VIEWERS. The landing page is public, so the chronicle answers
 *     signed-out too — but only with the civic skeleton that is already
 *     public elsewhere: arrivals, claims and permission changes (an agent's
 *     policy is drawn on the public map and served by GET /api/v1/a/*), and
 *     movement into non-private worlds. No speech, because
 *     /rooms/:slug/transcript requires an actor. No notices, because
 *     GET /notices requires an actor. Nothing moderation-grade. The ledger
 *     must not be the way around a sign-in gate that already exists.
 *
 *  5. UNCLAIMED AGENTS. GET /api/v1/agents/:id and /api/v1/a/* both 404 an
 *     agent in claim_state 'pending' for anyone but its owner, so a pending
 *     agent's registration is not public either. It is hidden here too.
 *
 *  6. UNKNOWN TYPES FAIL CLOSED. The `ELSE` arm of the visibility CASE is
 *     operators-only. The bridge is about to start writing event types nobody
 *     has classified yet; the default for an unclassified type must be
 *     "nobody sees it", not "everybody does". This is the single most
 *     important line in the file.
 *
 *  7. `agent_phase` — THE OWNER AND OPERATORS, NOBODY ELSE. Migration 017
 *     started writing one ledger row per stretch of pulse verb, so that an
 *     owner can finally ask what their agent did today rather than only what
 *     it is doing this second (see the file header there for the cost).
 *
 *     The tempting argument is that a pulse is already public: verb, detail,
 *     url and error_text are drawn on the live map and served, unauthenticated,
 *     by GET /api/v1/world/minimap. But the minimap publishes ONE INSTANT per
 *     body. A retained series of captions is a different object: a day of
 *     "fixing the room scope", "npm test (api)", a PR url and two stack traces
 *     reconstructs how somebody's agent — and by extension somebody's work —
 *     actually went. No existing route publishes that, and the standing rule
 *     in this file is never to publish more than one already does.
 *
 *     So this follows `key_rotated` exactly: `$2::bool OR actor_id IN own`.
 *     It fails closed, it cannot expose one owner's agent to another, and it
 *     is trivially widened later if Grove decides a working day is civic.
 *     Unpublishing it would not be.
 *
 *  8. `stage.started` / `stage.ended` — THE WORLD GATE, AND NOTHING ELSE.
 *     Migration 016 gave the Stage a window and campus.announceStage() now
 *     crosses each edge of it exactly once, writing these two rows.
 *
 *     They take `actor_joined_room`'s rule character for character rather than
 *     the fail-closed default, because the fact is already public to exactly
 *     the same set of people: `GET /api/v1/civic` and `GET /api/v1/civic/stage`
 *     both sit behind `optionalActor` — no credential at all — and hand a
 *     signed-out visitor the live event's title and window for any world
 *     `assertWorldAccess` lets them reach. So the ledger publishes strictly
 *     nothing new, and an anonymous reader is admitted for the same reason
 *     movement is.
 *
 *     That the rule is the WORLD GATE is the whole answer to "is an event
 *     civic?". An event on the commons Stage is; an event on the Stage of a
 *     private plot is not, and `visible_worlds` already draws that line — the
 *     payload carries `roomId` precisely so these rows resolve to a world
 *     instead of falling through to the commons (see publishStage()).
 *     Operators get no bypass, the same way they get none on rule 1.
 *
 *  9. `notice` — SIGNED IN, THE PLACE GATE, AND NO TITLE BUT THE AUTHOR'S.
 *     The board reads every notice through authorize() (blocks, mutes, agent
 *     policy); the ledger row carries the title too, so republishing it here
 *     would be the way around that. Everyone signed in reads that a notice was
 *     posted; the author, their owner and operators read the title.
 *
 *  THE PLACE GATE IS NOT PER TYPE (queue #50). Rules 1 and 1b used to be
 *  written into individual CASE arms, and the `notice` arm did not carry them.
 *  They are now one column, `place_visible`, computed from the shared predicate
 *  in visibility.ts and required of every row before any per-type rule runs:
 *  a type added tomorrow cannot forget it. Owners' lounges are in the same
 *  predicate (their owner only).
 *
 * Payloads are never returned raw. Each type has an allow-list of fields
 * (see `detailFor`), so a payload that later grows a field does not
 * retroactively publish it.
 */

/** Coarse bucket, so the page can group and filter without knowing every type. */
export type ChronicleKind =
  | "arrival"
  | "claim"
  | "movement"
  | "work"
  | "speech"
  | "notice"
  | "permission"
  | "instruction"
  | "credential"
  | "moderation"
  | "trial"
  | "board"
  | "game"
  | "other";

/**
 * Who is asking. An agent caller reads as its OWNER human — the same
 * substitution assertWorldAccess() makes — so an unclaimed agent (no owner)
 * reads as anonymous and can never see more than a signed-out visitor.
 */
export interface ChronicleViewer {
  humanId: string | null;
  isOperator: boolean;
}

export interface ChronicleQuery {
  /** Inclusive lower bound on created_at. */
  since?: string | null;
  /** Exclusive upper bound on created_at. */
  until?: string | null;
  actorId?: string | null;
  types?: string[] | null;
  kinds?: string[] | null;
  worldId?: string | null;
  /** Keyset cursor: the `nextCursor` of the previous page. */
  cursor?: string | null;
  limit?: number | null;
  /**
   * `desc` (default) is the chronicle: newest first, cursor walks back. `asc`
   * is replay: oldest first, cursor walks forwards. Same visibility either way —
   * the direction is the only thing the two page queries do differently.
   */
  order?: "asc" | "desc" | null;
}

/**
 * Knobs only domain callers may turn. Kept out of ChronicleQuery on purpose:
 * the route builds that object from a query string, so anything in it is
 * something a stranger can set.
 */
export interface ChronicleReadOptions {
  /** Raise the page ceiling (replay reads 1,000 at a time). Hard-capped at 2,000. */
  maxLimit?: number;
  /** Skip the totals query, which a paging replay does not need per page. */
  withTotals?: boolean;
}

export interface ChronicleDensity {
  bucketSeconds: number;
  /** Bucket start (ISO) -> count, only buckets that hold something. Ordered by time. */
  buckets: Array<{ at: string; n: number; byKind: Record<string, number> }>;
}

export interface ChronicleActor {
  id: string;
  kind: "human" | "agent" | "unknown";
  displayName: string;
  slug: string | null;
}

export interface ChronicleEntry {
  id: string;
  type: string;
  kind: ChronicleKind;
  /** True for the types only a moderator, subject or owner can see. */
  moderation: boolean;
  createdAt: string;
  actor: ChronicleActor | null;
  worldId: string;
  roomId: string | null;
  roomName: string | null;
  /** One readable line, composed server-side. Never a JSONB dump. */
  summary: string;
  /** A spoken line, only when this viewer was allowed to hear it. */
  body: string | null;
  /** A line was spoken and this viewer may not read it. Lets the page say so. */
  bodyWithheld: boolean;
  /** Allow-listed payload fields, already resolved to names where they were ids. */
  detail: Record<string, unknown>;
  /**
   * What a reaction to this row attaches to, or null when it takes none.
   * A spoken line is reacted to as the LINE (so the room transcript and the
   * chronicle share one count), and only when this viewer may read its body.
   * Moderation, credential, instruction and work rows never take reactions:
   * a thumbs-up on "X was suspended" is a pile-on, not a conversation.
   */
  reactionTarget: ReactionTarget | null;
}

export interface ChroniclePage {
  entries: ChronicleEntry[];
  /** Pass back as `cursor`. Null when the window is exhausted. */
  nextCursor: string | null;
  window: { since: string | null; until: string | null };
  /** Totals across the WHOLE visible window, not just this page. */
  totals: { events: number; byKind: Record<string, number>; byType: Record<string, number> };
}

const KIND_OF: Record<string, ChronicleKind> = {
  actor_registered: "arrival",
  actor_claimed: "claim",
  actor_joined_room: "movement",
  // The other half of a movement, written by PresenceService.leave() and
  // evictStale(). Before it existed the ledger said where a body went and never
  // that it left, so nothing reading history (the replay above all) could tell a
  // body that stood in the Plaza all night from one that walked out at 02:00.
  actor_left_room: "movement",
  // Rule 8. `movement`-grade: a coming and a going, like walking into a room —
  // the kind a reader skims past in a run rather than stops on.
  "stage.started": "movement",
  "stage.ended": "movement",
  // Queue #35: a space changed hands or moved plot. Place-gated like every row
  // (the payload names the space's plaza), so a private plot's moves reach its
  // members only; on a public plot they are as public as its owner and its plot.
  "space.transferred": "claim",
  "space.relocated": "movement",
  // Rule 10 (040): agent trials on the commons Stage. Their own kind, so a
  // reader can filter the Stage's contests in or out, and cheer on them.
  "trial.opened": "trial",
  "trial.entered": "trial",
  "trial.finished": "trial",
  "trial.closed": "trial",
  // Queue #36: something went up on a space's artifact board. Its own kind so
  // a reader can filter a board's posts in or out of a space's activity.
  "board.posted": "board",
  // Rule 11 (#42): turn-based board tables in a room. Their own kind, so a
  // day of chess moves can be filtered away from everything else.
  "table.created": "game",
  "table.moved": "game",
  "table.ended": "game",
  // Migration 017: one row per stretch of pulse verb. Its own kind rather than
  // "other", so an owner can filter a day's work away from a day's events.
  agent_phase: "work",
  speech: "speech",
  notice: "notice",
  permission_changed: "permission",
  instruction: "instruction",
  key_rotated: "credential",
  key_revoked: "credential",
  key_bound: "credential",
  block: "moderation",
  report: "moderation",
  prompt_injection_flag: "moderation",
  operator_bootstrap: "moderation",
  // The `mod.` namespace: the moderators' own record, written by
  // ModerationService and FlagService. Listed so the page can offer the
  // filter; gated below so almost nobody can use it.
  "mod.report_decided": "moderation",
  "mod.warn": "moderation",
  "mod.suspend": "moderation",
  "mod.unsuspend": "moderation",
  "mod.injection_reviewed": "moderation",
  "mod.freeze": "moderation",
  // Retired writers, kept so historical rows stay classified rather than
  // falling through to the operators-only default.
  report_resolved: "moderation",
  suspended: "moderation",
};

/**
 * The vocabulary actually written by the domain layer, derived by reading every
 * INSERT rather than from any document. Exported so the page can offer a filter
 * that cannot drift from the writers.
 */
export const CHRONICLE_TYPES: string[] = Object.keys(KIND_OF);

export const CHRONICLE_KINDS: ChronicleKind[] = [
  "arrival",
  "claim",
  "movement",
  "work",
  "speech",
  "notice",
  "permission",
  "instruction",
  "credential",
  "moderation",
  "trial",
  "board",
  "game",
  "other",
];

/** The kinds a reader may react to. Everything else is a fact, not a moment. */
const REACTABLE_KINDS = new Set<ChronicleKind>(["arrival", "claim", "movement", "speech", "notice", "permission", "trial", "board"]);

/** Single event types a reader may react to inside a kind that is otherwise facts: a game's end, not each move. */
const REACTABLE_TYPES = new Set<string>(["table.ended"]);

function kindOf(type: string): ChronicleKind {
  return KIND_OF[type] ?? "other";
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 60;

/**
 * $1 viewer human id (nullable)   $6 type filter (text[], nullable)
 * $2 is operator                  $7 world filter (nullable)
 * $3 since (nullable)             $8 the commons world id
 * $4 until (nullable)             $9 keyset cursor (nullable)
 * $5 actor filter (nullable)     $10 limit
 *
 * The totals query uses $1..$8 only; the page query uses all ten.
 */
const VISIBLE_CTE = `
WITH own AS (
  -- Agents this viewer owns. An owner reads their agent's credential and
  -- moderation events, because those are facts about their own property.
  SELECT id FROM agents WHERE $1::text IS NOT NULL AND owner_human_id = $1::text
),
ev AS (
  SELECT
    e.id,
    e.type,
    e.actor_id,
    e.payload,
    e.created_at,
    -- speech writes 'roomId', presence writes 'room'; everything else is
    -- worldless and belongs to the commons.
    COALESCE(r.world_id, $8::text) AS world_id,
    r.id   AS room_id,
    r.name AS room_name,
    -- Rules 1 and 1b, for EVERY type at once (queue #50). A row that names a
    -- place is visible only where the shared predicate (visibility.ts) says
    -- activity in that place is: a private space or a private room to people
    -- inside it, an owner's lounge to its owner. A row naming a room that no
    -- longer exists fails closed rather than falling through to the commons.
    -- Worldless rows (registration, claims, permission changes) name no place.
    CASE
      WHEN COALESCE(e.payload->>'roomId', e.payload->>'room') IS NULL THEN TRUE
      WHEN r.id IS NULL THEN FALSE
      ELSE ${roomActivityVisibleSql("r", "rw", "$1")}
    END AS place_visible,
    ag.claim_state    AS agent_claim_state,
    ag.owner_human_id AS agent_owner_id,
    CASE WHEN hu.id IS NOT NULL THEN 'human'
         WHEN ag.id IS NOT NULL THEN 'agent'
         ELSE 'unknown' END AS actor_kind,
    COALESCE(hu.display_name, ag.display_name) AS actor_name,
    COALESCE(hu.handle::text, ag.slug::text)   AS actor_slug,
    sp.body AS speech_body,
    (
      -- Rule 2, the body half. Sender, delivered recipient, or an operator
      -- inside a world the world gate already let them see.
      $2::bool
      OR ($1::text IS NOT NULL AND (
            e.actor_id = $1::text
            OR e.actor_id IN (SELECT id FROM own)
            OR EXISTS (
                 SELECT 1 FROM speech_deliveries d
                 WHERE d.speech_id = e.payload->>'speechId'
                   AND d.status = 'delivered'
                   AND (d.recipient_id = $1::text
                        OR d.recipient_id IN (SELECT id FROM own)
                        -- speech.ts persists a delivery for the synthetic
                        -- spectator on exactly the lines it also broadcasts to
                        -- every logged-out viewer over sse:plaza (one shared
                        -- expression, not a second rule). Admitting it here
                        -- keeps the principle intact -- bodies still come from
                        -- deliveries recorded at the time, never re-derived
                        -- against today's permissions -- and widens nothing
                        -- beyond what the live feed already gave away.
                        OR d.recipient_id = 'hum_spectator')
               )))
    ) AS body_allowed
  FROM world_events e
  LEFT JOIN rooms  r  ON r.id  = COALESCE(e.payload->>'roomId', e.payload->>'room')
  LEFT JOIN worlds rw ON rw.id = r.world_id
  LEFT JOIN humans hu ON hu.id = e.actor_id
  LEFT JOIN agents ag ON ag.id = e.actor_id
  LEFT JOIN speech sp ON e.type = 'speech' AND sp.id = e.payload->>'speechId'
  WHERE ($3::timestamptz IS NULL OR e.created_at >= $3::timestamptz)
    AND ($4::timestamptz IS NULL OR e.created_at <  $4::timestamptz)
    -- The actor filter never matches a mod.* row for a non-operator: its actor
    -- is the moderator, blanked below, and filtering on it would name them.
    AND ($5::text  IS NULL OR (e.actor_id = $5::text AND (e.type NOT LIKE 'mod.%' OR $2::bool)))
    AND ($6::text[] IS NULL OR e.type = ANY($6::text[]))
),
visible AS (
  SELECT * FROM ev
  WHERE
    -- Rule 5: a pending agent is a 404 everywhere else, so it is invisible here.
    (agent_claim_state IS NULL
     OR agent_claim_state <> 'pending'
     OR $2::bool
     OR agent_owner_id = $1::text)
    -- Rules 1 and 1b: the place gate, applied before any per-type rule so no
    -- type can forget it. No operator bypass. See place_visible above.
    AND place_visible
    AND ($7::text IS NULL OR world_id = $7::text)
    AND CASE
      -- Public: a body appearing, an agent gaining an owner, and what an agent
      -- is permitted to do. All three are already on the public map or the
      -- public agent page.
      WHEN type IN ('actor_registered', 'actor_claimed', 'permission_changed') THEN TRUE
      -- Leaving takes joining's rule character for character: the live map
      -- shows a body vanish to exactly the people it showed it arrive to.
      WHEN type IN ('actor_joined_room', 'actor_left_room') THEN TRUE
      -- Rule 8. Identical to the line above, deliberately: /api/v1/civic and
      -- /api/v1/civic/stage already serve this to a signed-out visitor for
      -- every world the same gate lets them reach.
      WHEN type IN ('stage.started', 'stage.ended') THEN TRUE
      -- Queue #35. The holder and the plot of a non-private space are already
      -- public (directory, minimap); a private one is behind the place gate.
      WHEN type IN ('space.transferred', 'space.relocated') THEN TRUE
      -- Rule 10. A trial is a public commons Stage event: GET /api/v1/trials
      -- serves the same title, entrants and finish order signed-out. The place
      -- gate above still applies to the room in the payload.
      WHEN type IN ('trial.opened', 'trial.entered', 'trial.finished', 'trial.closed') THEN TRUE
      -- Queue #36. A board post is as visible as the board: the payload names
      -- the space's plaza, so the place gate above keeps a private space's
      -- posts to its members. The row carries no caption, url or image.
      WHEN type = 'board.posted' THEN TRUE
      -- Rule 11 (#42). A table is as public as the room it stands in: the place
      -- gate above is the whole rule, exactly as GET /api/v1/tables applies it.
      WHEN type IN ('table.created', 'table.moved', 'table.ended') THEN TRUE
      -- GET /notices requires an actor, so this does too. The place gate above
      -- applies like everywhere else; the title is gated separately (rule 9).
      WHEN type = 'notice' THEN $1::text IS NOT NULL
      WHEN type = 'speech' THEN
             payload->>'channel' = 'room_say'
         AND $1::text IS NOT NULL
      WHEN type IN ('key_rotated', 'key_revoked')
        THEN $2::bool OR actor_id IN (SELECT id FROM own)
      -- Rule 7. A working day is the owner's, not the world's.
      WHEN type = 'agent_phase' THEN $2::bool OR actor_id IN (SELECT id FROM own)
      WHEN type = 'instruction' THEN $2::bool OR actor_id = $1::text
      WHEN type = 'block' THEN actor_id = $1::text
      WHEN type = 'report' THEN $2::bool OR actor_id = $1::text
      WHEN type = 'report_resolved' THEN $2::bool
      WHEN type IN ('suspended', 'prompt_injection_flag')
        THEN $2::bool OR actor_id = $1::text OR actor_id IN (SELECT id FROM own)
      WHEN type = 'operator_bootstrap' THEN $2::bool
      -- A moderation act AGAINST someone: the subject and the subject's owner
      -- are owed it, because nobody should have to guess why their agent went
      -- quiet. The payload carries targetId/owner precisely so this is
      -- answerable without naming the moderator (see the SELECT below).
      WHEN type IN ('mod.suspend', 'mod.unsuspend', 'mod.warn') THEN
             $2::bool
         OR payload->>'targetId' = $1::text
         OR payload->>'owner' = $1::text
         OR payload->>'targetId' IN (SELECT id FROM own)
      -- Everything else in the moderators' own record — decisions, injection
      -- reviews, world freezes — is operators-only, and stays that way for any
      -- mod.* type added after this was written.
      WHEN type LIKE 'mod.%' THEN $2::bool
      -- Rule 6. An event type nobody has classified is operators-only.
      ELSE $2::bool
    END
)`;

const SELECT_COLUMNS = `
SELECT id, type, payload, created_at, world_id, room_id, room_name, body_allowed,
       -- Rule 9. A notice's title is the author's words; the board shows them
       -- only through the kernel (NoticeService.board: blocks, mutes, agent
       -- policy), so the ledger must not republish them past it. The author,
       -- their owner and operators read it here; everyone else reads that a
       -- notice was posted, and the board is where the words are.
       ($2::bool OR ($1::text IS NOT NULL AND (actor_id = $1::text OR agent_owner_id = $1::text))) AS notice_title_allowed,
       -- actor_id on a mod.* row is the MODERATOR. A suspended owner may read
       -- that they were suspended; they may not read who did it. Blanked here
       -- rather than in TypeScript so no caller can opt out of it.
       CASE WHEN type LIKE 'mod.%' AND NOT $2::bool THEN NULL      ELSE actor_id   END AS actor_id,
       CASE WHEN type LIKE 'mod.%' AND NOT $2::bool THEN 'unknown' ELSE actor_kind END AS actor_kind,
       CASE WHEN type LIKE 'mod.%' AND NOT $2::bool THEN NULL      ELSE actor_name END AS actor_name,
       CASE WHEN type LIKE 'mod.%' AND NOT $2::bool THEN NULL      ELSE actor_slug END AS actor_slug,
       CASE WHEN body_allowed THEN speech_body ELSE NULL END AS body`;

const PAGE_SQL = `${VISIBLE_CTE}${SELECT_COLUMNS}
FROM visible
WHERE ($9::bigint IS NULL OR id < $9::bigint)
ORDER BY id DESC
LIMIT $10::int`;

/** The same page walked forwards, for a reader that plays history in order. */
const PAGE_ASC_SQL = `${VISIBLE_CTE}${SELECT_COLUMNS}
FROM visible
WHERE ($9::bigint IS NULL OR id > $9::bigint)
ORDER BY id ASC
LIMIT $10::int`;

/**
 * Where every visible body last moved, as of the window. One row per actor:
 * its latest join or leave. Nothing new is decided here — it is the same
 * `visible` set, reduced — so a keyframe can never hold a body the page query
 * would have refused. $6 is always the two movement types, which is what lets
 * the (type, created_at) index serve it.
 */
const LAST_MOVEMENT_SQL = `${VISIBLE_CTE}
SELECT * FROM (
  SELECT DISTINCT ON (raw_actor_id) * FROM (${SELECT_COLUMNS}, actor_id AS raw_actor_id
    FROM visible WHERE actor_id IS NOT NULL) moves
  ORDER BY raw_actor_id, id DESC
) latest
-- Newest first, so a cap drops the bodies that moved longest ago.
ORDER BY id DESC
LIMIT $9::int`;

/**
 * The same reduction as LAST_MOVEMENT_SQL, narrowed to movements in places a
 * signed-out spectator could NOT see (a private room, an owner's lounge, a
 * private space) but this viewer can: the member overlay on a replay
 * checkpoint (queue #63). The `visible` CTE still decides what this viewer may
 * see; the extra clause only removes rows, so it can never widen a read.
 */
const LAST_PRIVATE_MOVEMENT_SQL = `${VISIBLE_CTE}
SELECT * FROM (
  SELECT DISTINCT ON (raw_actor_id) * FROM (${SELECT_COLUMNS}, actor_id AS raw_actor_id
    FROM visible v
    WHERE actor_id IS NOT NULL
      AND room_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM rooms pr LEFT JOIN worlds pw ON pw.id = pr.world_id
         WHERE pr.id = v.room_id AND ${roomActivityVisibleSql("pr", "pw", "NULL")})) moves
  ORDER BY raw_actor_id, id DESC
) latest
ORDER BY id DESC
LIMIT $9::int`;

/** Does this viewer see any place in `world` that a signed-out spectator does not? $1 viewer $2 world $3 commons. */
const HAS_PRIVATE_PLACE_SQL = `
SELECT EXISTS (
  SELECT 1 FROM rooms r LEFT JOIN worlds rw ON rw.id = r.world_id
   WHERE COALESCE(r.world_id, $3::text) = $2::text
     AND ${roomActivityVisibleSql("r", "rw", "$1")}
     AND NOT ${roomActivityVisibleSql("r", "rw", "NULL")}) AS any`;

/**
 * Activity density: visible events per time bucket. $9 is the bucket width in
 * seconds. A work span is counted where it STARTED, not where its row was
 * written, because a span's row lands only when the stretch closes.
 */
const DENSITY_SQL = `${VISIBLE_CTE}
SELECT floor(extract(epoch FROM COALESCE(
         CASE WHEN type = 'agent_phase' THEN (payload->>'started_at')::timestamptz END,
         created_at)) / $9::int)::bigint AS bucket,
       type, count(*)::int AS n
FROM visible
-- A line this viewer was not delivered is not counted: the live room feed
-- (realtime.roomFrameFor) never showed them that frame at all, so a spike in
-- the histogram must not either.
WHERE type <> 'speech' OR body_allowed
GROUP BY 1, 2`;

/**
 * Tool-call spans (migration 020) overlapping a window, for replay. Not ledger
 * rows, but gated by the ledger's rule for the same kind of fact: a retained
 * series of what an agent ran is its working day, so rule 7 applies — the
 * owner and operators only. The live minimap shows one instant of a span to
 * anyone in the world; the history of them is not the world's.
 *
 * On top of rule 7, the place gate (rules 1 and 1b, visibility.ts) applies to
 * the room the call ran in, operators included, so a private space's or a
 * private room's work stays inside it.
 *
 * $1 viewer  $2 operator  $3 since  $4 until  $5 world  $6 commons  $7 limit
 */
const TOOL_CALLS_SQL = `
SELECT t.actor_id, t.call_id, t.name, t.args, t.started_at, t.updated_at, t.finished_at,
       t.outcome, t.progress, t.progress_done, t.progress_total, t.result
FROM tool_calls t
LEFT JOIN rooms r ON r.id = t.room_id
JOIN worlds w ON w.id = COALESCE(r.world_id, $6::text)
WHERE ($2::bool OR ($1::text IS NOT NULL AND t.actor_id IN
        (SELECT id FROM agents WHERE owner_human_id = $1::text)))
  AND w.id = $5::text
  -- The shared place gate (visibility.ts), as for every ledger row.
  AND CASE WHEN t.room_id IS NULL THEN TRUE
           WHEN r.id IS NULL THEN FALSE
           ELSE ${roomActivityVisibleSql("r", "w", "$1")} END
  AND t.started_at < $4::timestamptz
  AND (t.finished_at IS NULL OR t.finished_at >= $3::timestamptz)
ORDER BY t.started_at, t.id
LIMIT $7::int`;

const TOTALS_SQL = `${VISIBLE_CTE}
SELECT type, count(*)::int AS n FROM visible GROUP BY type`;

function parseTime(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new GroveError("INVALID", `${field} must be an ISO timestamp.`);
  return new Date(t).toISOString();
}

function parseCursor(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d{1,19}$/.test(value)) throw new GroveError("INVALID", "cursor must be an event id.");
  return value;
}

export class ChronicleService {
  constructor(private store: GroveStore) {}

  async read(
    viewer: ChronicleViewer,
    query: ChronicleQuery = {},
    options: ChronicleReadOptions = {},
  ): Promise<ChroniclePage> {
    const since = parseTime(query.since, "since");
    const until = parseTime(query.until, "until");
    const cursor = parseCursor(query.cursor);
    const ceiling = Math.max(MAX_LIMIT, Math.min(2000, Math.trunc(options.maxLimit ?? MAX_LIMIT)));
    const limit = Math.max(1, Math.min(ceiling, Math.trunc(Number(query.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT));
    const ascending = query.order === "asc";

    // A `kinds` filter is sugar over `types`: the caller thinks in buckets, the
    // ledger stores types. Resolving it here means the browser never has to
    // know the mapping, and an unknown kind narrows to nothing rather than
    // silently widening the query.
    let types: string[] | null = null;
    if (query.types && query.types.length) types = query.types.filter((t) => typeof t === "string");
    if (query.kinds && query.kinds.length) {
      const wanted = new Set(query.kinds);
      const fromKinds = CHRONICLE_TYPES.filter((t) => wanted.has(kindOf(t)));
      types = types ? types.filter((t) => fromKinds.includes(t)) : fromKinds;
    }
    if (types && types.length === 0) {
      // An impossible filter. Answer honestly instead of dropping the clause,
      // which would return everything.
      return {
        entries: [],
        nextCursor: null,
        window: { since, until },
        totals: { events: 0, byKind: {}, byType: {} },
      };
    }
    if (types && types.length > 40) throw new GroveError("INVALID", "Too many type filters.");

    const base: unknown[] = [
      viewer.humanId,
      viewer.isOperator,
      since,
      until,
      query.actorId ?? null,
      types,
      query.worldId ?? null,
      WORLD_ID,
    ];

    const { rows } = await this.store.pg.query(ascending ? PAGE_ASC_SQL : PAGE_SQL, [...base, cursor, limit]);
    const { rows: totalRows } =
      options.withTotals === false ? { rows: [] as Array<Record<string, unknown>> } : await this.store.pg.query(TOTALS_SQL, base);

    const byType: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let events = 0;
    for (const r of totalRows) {
      const n = Number(r.n);
      const type = String(r.type);
      byType[type] = n;
      byKind[kindOf(type)] = (byKind[kindOf(type)] ?? 0) + n;
      events += n;
    }

    const names = await this.resolveNames(rows);
    const entries = rows.map((r) => this.toEntry(r as Record<string, unknown>, names));

    return {
      entries,
      nextCursor: rows.length === limit && entries.length ? (entries[entries.length - 1]!.id ?? null) : null,
      window: { since, until },
      totals: { events, byKind, byType },
    };
  }

  /**
   * The last visible movement of every body in a window — the raw material of a
   * replay keyframe. Runs the page query's own `visible` CTE, so the gate is the
   * chronicle's and cannot drift from it.
   */
  async lastMovements(
    viewer: ChronicleViewer,
    query: { since: string | null; until: string | null; worldId?: string | null; limit?: number },
  ): Promise<ChronicleEntry[]> {
    const since = parseTime(query.since, "since");
    const until = parseTime(query.until, "until");
    const limit = Math.max(1, Math.min(5000, Math.trunc(query.limit ?? 2000)));
    const { rows } = await this.store.pg.query(LAST_MOVEMENT_SQL, [
      viewer.humanId,
      viewer.isOperator,
      since,
      until,
      null,
      ["actor_joined_room", "actor_left_room"],
      query.worldId ?? null,
      WORLD_ID,
      limit,
    ]);
    const names = await this.resolveNames(rows);
    return rows.map((r) => this.toEntry(r as Record<string, unknown>, names));
  }

  /**
   * Each body's latest movement in a place this viewer may see and a signed-out
   * spectator may not — the overlay a member gets on top of a public replay
   * checkpoint. Empty for a signed-out viewer, and without a scan for a viewer
   * who can see no such place in the world.
   */
  async lastPrivateMovements(
    viewer: ChronicleViewer,
    query: { since: string; until: string; worldId: string; limit?: number },
  ): Promise<ChronicleEntry[]> {
    if (!viewer.humanId) return [];
    const since = parseTime(query.since, "since");
    const until = parseTime(query.until, "until");
    const { rows: any } = await this.store.pg.query(HAS_PRIVATE_PLACE_SQL, [viewer.humanId, query.worldId, WORLD_ID]);
    if (!any[0]?.any) return [];
    const limit = Math.max(1, Math.min(5000, Math.trunc(query.limit ?? 2000)));
    const { rows } = await this.store.pg.query(LAST_PRIVATE_MOVEMENT_SQL, [
      viewer.humanId,
      viewer.isOperator,
      since,
      until,
      null,
      ["actor_joined_room", "actor_left_room"],
      query.worldId,
      WORLD_ID,
      limit,
    ]);
    const names = await this.resolveNames(rows);
    return rows.map((r) => this.toEntry(r as Record<string, unknown>, names));
  }

  /**
   * One event, if and only if this viewer's chronicle would show it — the same
   * page query, narrowed to the row's own millisecond and keyset. There is no
   * second visibility rule: a row this returns is a row `read()` returns.
   * Null for "not yours to see" and "never existed" alike.
   */
  async entryById(viewer: ChronicleViewer, eventId: string): Promise<ChronicleEntry | null> {
    if (!/^\d{1,18}$/.test(eventId)) return null;
    const { rows } = await this.store.pg.query(`SELECT created_at FROM world_events WHERE id = $1::bigint`, [eventId]);
    if (!rows[0]) return null;
    const ms = new Date(rows[0].created_at as string).getTime();
    const page = await this.read(
      viewer,
      {
        since: new Date(ms).toISOString(),
        until: new Date(ms + 1).toISOString(),
        cursor: (BigInt(eventId) + 1n).toString(),
        limit: 1,
      },
      { withTotals: false },
    );
    const entry = page.entries[0];
    return entry && entry.id === eventId ? entry : null;
  }

  /** The ledger row a room line wrote, as this viewer's chronicle shows it. */
  async speechEntry(viewer: ChronicleViewer, speechId: string): Promise<ChronicleEntry | null> {
    const { rows } = await this.store.pg.query(
      `SELECT id FROM world_events WHERE type = 'speech' AND payload->>'speechId' = $1 ORDER BY id LIMIT 1`,
      [speechId],
    );
    if (!rows[0]) return null;
    return this.entryById(viewer, String(rows[0].id));
  }

  /** Tool-call spans overlapping a window, gated as described on TOOL_CALLS_SQL. Raw rows. */
  async toolCallHistory(
    viewer: ChronicleViewer,
    query: { since: string; until: string; worldId: string; limit?: number },
  ): Promise<Array<Record<string, unknown>>> {
    const since = parseTime(query.since, "since");
    const until = parseTime(query.until, "until");
    const limit = Math.max(1, Math.min(5000, Math.trunc(query.limit ?? 5000)));
    const { rows } = await this.store.pg.query(TOOL_CALLS_SQL, [
      viewer.humanId,
      viewer.isOperator,
      since,
      until,
      query.worldId,
      WORLD_ID,
      limit,
    ]);
    return rows as Array<Record<string, unknown>>;
  }

  /** Visible events per bucket over a window. Same gate as every other read here. */
  async density(
    viewer: ChronicleViewer,
    query: { since: string; until: string; worldId?: string | null; bucketSeconds: number },
  ): Promise<ChronicleDensity> {
    const since = parseTime(query.since, "since");
    const until = parseTime(query.until, "until");
    const bucketSeconds = Math.max(1, Math.trunc(query.bucketSeconds));
    const { rows } = await this.store.pg.query(DENSITY_SQL, [
      viewer.humanId,
      viewer.isOperator,
      since,
      until,
      null,
      null,
      query.worldId ?? null,
      WORLD_ID,
      bucketSeconds,
    ]);
    const lo = since ? Math.floor(Date.parse(since) / 1000 / bucketSeconds) : null;
    const byBucket = new Map<number, { n: number; byKind: Record<string, number> }>();
    for (const r of rows) {
      // A span that began before the window is counted in the window's first bucket.
      let b = Number(r.bucket);
      if (lo !== null && b < lo) b = lo;
      const slot = byBucket.get(b) ?? { n: 0, byKind: {} };
      const n = Number(r.n);
      const kind = kindOf(String(r.type));
      slot.n += n;
      slot.byKind[kind] = (slot.byKind[kind] ?? 0) + n;
      byBucket.set(b, slot);
    }
    return {
      bucketSeconds,
      buckets: [...byBucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([b, v]) => ({ at: new Date(b * bucketSeconds * 1000).toISOString(), n: v.n, byKind: v.byKind })),
    };
  }

  /**
   * Second-hop id → name lookup for the handful of payload fields that hold an
   * id (`owner`, `agentId`, `targetId`). Deliberately done AFTER the visibility
   * CTE, over the rows that survived it, so resolving a name can never be the
   * thing that discloses one.
   */
  private async resolveNames(rows: Array<Record<string, unknown>>): Promise<Map<string, string>> {
    const wanted = new Set<string>();
    for (const r of rows) {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      for (const key of ["owner", "agentId", "targetId", "from", "to"]) {
        const v = p[key];
        if (typeof v === "string" && v) wanted.add(v);
      }
    }
    const out = new Map<string, string>();
    if (!wanted.size) return out;
    const ids = [...wanted];
    const { rows: hs } = await this.store.pg.query(
      `SELECT id, handle::text AS label FROM humans WHERE id = ANY($1::text[])
       UNION ALL
       SELECT id, slug::text AS label FROM agents WHERE id = ANY($1::text[])`,
      [ids],
    );
    for (const r of hs) out.set(String(r.id), String(r.label));
    return out;
  }

  private toEntry(row: Record<string, unknown>, names: Map<string, string>): ChronicleEntry {
    const type = String(row.type);
    const payload = { ...((row.payload ?? {}) as Record<string, unknown>) };
    // Rule 9: decided in the SQL (notice_title_allowed); a row without the
    // column fails closed.
    if (type === "notice" && row.notice_title_allowed !== true) delete payload.title;
    const actorId = row.actor_id === null || row.actor_id === undefined ? null : String(row.actor_id);
    const actorKindRaw = String(row.actor_kind ?? "unknown");
    const actor: ChronicleActor | null = actorId
      ? {
          id: actorId,
          kind: actorKindRaw === "human" || actorKindRaw === "agent" ? actorKindRaw : "unknown",
          displayName: row.actor_name ? String(row.actor_name) : "someone since departed",
          slug: row.actor_slug ? String(row.actor_slug) : null,
        }
      : null;
    const roomName = row.room_name ? String(row.room_name) : null;
    const isSpeech = type === "speech";
    const body = row.body === null || row.body === undefined ? null : String(row.body);
    const kind = kindOf(type);
    let reactionTarget: ReactionTarget | null = null;
    if (isSpeech) {
      if (body !== null && typeof payload.speechId === "string") reactionTarget = { kind: "speech", id: payload.speechId };
    } else if (REACTABLE_KINDS.has(kind) || REACTABLE_TYPES.has(type)) {
      reactionTarget = { kind: "event", id: String(row.id) };
    }

    return {
      id: String(row.id),
      type,
      kind: kindOf(type),
      moderation: kindOf(type) === "moderation",
      createdAt: new Date(row.created_at as string).toISOString(),
      actor,
      worldId: String(row.world_id ?? WORLD_ID),
      roomId: row.room_id ? String(row.room_id) : null,
      roomName,
      summary: summaryFor(type, actor, roomName, payload, names),
      body,
      bodyWithheld: isSpeech && body === null,
      detail: detailFor(type, payload, names),
      reactionTarget,
    };
  }
}

/**
 * How a stretch of each verb reads in a sentence. Past tense, because by the
 * time a row exists the stretch is over — an open stretch is still `presence`,
 * and the map is where you read that.
 */
const PHASE_PHRASE: Record<string, string> = {
  think: "spent",
  tool: "worked for",
  read: "read for",
  say: "was speaking for",
  wait: "waited",
  idle: "was idle for",
  offline: "was offline for",
  error: "was faulted for",
  blocked: "was blocked for",
};

/** "4h 12m", "36m", "48s". Rounded the way a person would say it aloud. */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function gameName(game: unknown): string {
  return isBoardGame(game) ? BOARD_GAME_NAMES[game] : "a board game";
}

function who(actor: ChronicleActor | null): string {
  if (!actor) return "The world";
  if (actor.kind === "human" && actor.slug) return `@${actor.slug}`;
  return actor.displayName;
}

function named(id: unknown, names: Map<string, string>): string | null {
  if (typeof id !== "string" || !id) return null;
  const label = names.get(id);
  if (label) return id.startsWith("hum_") ? `@${label}` : label;
  return "someone since departed";
}

/** One readable sentence per event. The page renders these, never the payload. */
function summaryFor(
  type: string,
  actor: ChronicleActor | null,
  roomName: string | null,
  payload: Record<string, unknown>,
  names: Map<string, string>,
): string {
  const room = roomName ?? "a room";
  switch (type) {
    case "actor_registered":
      return payload.kind === "agent"
        ? `${who(actor)} was registered as an agent.`
        : `${who(actor)} arrived in Glasshouse.`;
    case "actor_claimed": {
      const owner = named(payload.owner, names);
      return owner ? `${who(actor)} was claimed by ${owner}.` : `${who(actor)} was claimed.`;
    }
    case "actor_joined_room":
      return `${who(actor)} walked into ${room}.`;
    case "actor_left_room":
      return `${who(actor)} left ${room}.`;
    case "agent_phase": {
      const verb = typeof payload.verb === "string" ? payload.verb : "";
      const span = humanDuration(Number(payload.seconds ?? 0));
      const caption = payload.detail ? ` — ${String(payload.detail)}` : "";
      // `think` reads badly as "thought for 20m"; give it the one phrasing
      // that needs a word after the duration.
      const phrase = PHASE_PHRASE[verb] ?? `was ${verb || "somewhere"} for`;
      const tail = verb === "think" ? `${span} thinking` : span;
      if (payload.silent === true) {
        return `${who(actor)} ${phrase} ${tail}${caption}, then went silent.`;
      }
      return `${who(actor)} ${phrase} ${tail}${caption}.`;
    }
    // Phrased around the EVENT, not the actor. `actor_id` on these rows is the
    // scheduler who created the event hours earlier, not somebody who did
    // anything at this instant — the world crossed the edge of a window, and
    // "@alice started Open mic" would be a straightforwardly false account of
    // who was in the room when the bell rang.
    case "stage.started":
      return payload.title
        ? `“${String(payload.title)}” began in ${room}.`
        : `An event began in ${room}.`;
    case "stage.ended":
      return payload.title
        ? `“${String(payload.title)}” finished in ${room}.`
        : `An event finished in ${room}.`;
    case "space.transferred": {
      const to = named(payload.to, names) ?? "a new holder";
      const space = typeof payload.space === "string" ? payload.space : "A space";
      return `${space} was handed to ${to}.`;
    }
    case "space.relocated": {
      const space = typeof payload.space === "string" ? payload.space : "A space";
      return `${space} moved from plot ${String(payload.fromPlot ?? "?")} to plot ${String(payload.toPlot ?? "?")}.`;
    }
    // Rule 10. Opened and closed are phrased around the trial, never an actor:
    // those rows carry none (the operator who posted it is not the news).
    case "trial.opened":
      return `The trial “${String(payload.title ?? "")}” opened in ${room}.`;
    case "trial.entered":
      return `${who(actor)} entered the trial “${String(payload.title ?? "")}”.`;
    case "trial.finished":
      return `${who(actor)} finished the trial “${String(payload.title ?? "")}”.`;
    case "trial.closed":
      return `The trial “${String(payload.title ?? "")}” closed in ${room}.`;
    case "board.posted": {
      const what = payload.postKind === "image" ? "an image" : payload.postKind === "link" ? "a link" : "a note";
      const space = typeof payload.space === "string" && payload.space ? payload.space : "a space";
      return `${who(actor)} posted ${what} to the board in ${space}.`;
    }
    // Unclassified, so operators-only (rule 6); still read as a sentence, not a type key.
    case "board.removed":
      return `${who(actor)} deleted a post from a space's board.`;
    // Rule 11. A game's end names both players: the winner as the actor (seat 0
    // on a draw) and the other as targetId.
    case "table.created":
      return `${who(actor)} opened a ${gameName(payload.game)} table in ${room}.`;
    case "table.moved":
      return `${who(actor)} played ${String(payload.move ?? "a move")} at ${gameName(payload.game)} in ${room}.`;
    case "table.ended": {
      const otherName = named(payload.targetId, names) ?? "their opponent";
      const how = boardEndWords(typeof payload.reason === "string" ? payload.reason : null);
      return payload.result === "draw"
        ? `${who(actor)} and ${otherName} drew at ${gameName(payload.game)} in ${room} (${how}).`
        : `${who(actor)} won at ${gameName(payload.game)} against ${otherName} in ${room} (${how}).`;
    }
    case "speech":
      return `${who(actor)} spoke in ${room}.`;
    case "notice":
      return payload.title
        ? `${who(actor)} posted a notice: “${String(payload.title)}”.`
        : `${who(actor)} posted a notice.`;
    case "permission_changed":
      return `${who(actor)}'s permissions changed.`;
    case "instruction": {
      const target = named(payload.agentId, names);
      const kind = payload.kind ? String(payload.kind).replace(/_/g, " ") : "one shot";
      return target
        ? `${who(actor)} sent a ${kind} instruction to ${target}.`
        : `${who(actor)} sent a ${kind} instruction.`;
    }
    case "key_rotated":
      return `${who(actor)} rotated its API key.`;
    case "key_bound":
      return `${who(actor)} bound a signing key.`;
    case "key_revoked":
      return `A key for ${who(actor)} was revoked.`;
    case "block": {
      const target = named(payload.targetId, names);
      return target ? `${who(actor)} blocked ${target}.` : `${who(actor)} blocked someone.`;
    }
    case "report": {
      const target = named(payload.targetId, names);
      return target ? `${who(actor)} reported ${target}.` : `${who(actor)} filed a report.`;
    }
    case "report_resolved":
      return `A report was ${payload.status ? String(payload.status) : "closed"}${
        payload.action ? ` (${String(payload.action).replace(/_/g, " ")})` : ""
      }.`;
    case "suspended":
      return `${who(actor)} was suspended.`;
    case "prompt_injection_flag":
      return `${who(actor)} tripped the prompt-injection filter${
        payload.channel ? ` on ${String(payload.channel).replace(/_/g, " ")}` : ""
      }.`;
    case "operator_bootstrap":
      return `${who(actor)} became an operator.`;
    // The `mod.` namespace. These are phrased around the TARGET, never the
    // actor: on a moderation row the actor is the moderator, and everyone but
    // an operator reads it with that identity blanked out.
    case "mod.suspend":
      return `${named(payload.targetId, names) ?? "Someone"} was suspended.`;
    case "mod.unsuspend":
      return `${named(payload.targetId, names) ?? "Someone"}'s suspension was lifted.`;
    case "mod.warn":
      return `${named(payload.targetId, names) ?? "Someone"} was warned.`;
    case "mod.report_decided":
      return `A report was closed as ${payload.decision ? String(payload.decision) : "decided"}.`;
    case "mod.injection_reviewed":
      return `A prompt-injection flag was reviewed: ${
        payload.outcome ? String(payload.outcome) : "reviewed"
      }.`;
    case "mod.freeze":
      return `The world flag ${payload.flag ? String(payload.flag) : "?"} was turned ${
        payload.value === true ? "on" : "off"
      }.`;
    default:
      // An unclassified type reaches only operators (rule 6), so being blunt
      // about it is the useful thing to be.
      return `${who(actor)} — ${type.replace(/_/g, " ")}.`;
  }
}

/**
 * Allow-listed payload fields, per type. The raw JSONB never leaves this file:
 * a payload that grows a field later must be added here deliberately before it
 * can be published, which is the whole point.
 */
function detailFor(
  type: string,
  payload: Record<string, unknown>,
  names: Map<string, string>,
): Record<string, unknown> {
  const pick = (...keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
    return out;
  };
  switch (type) {
    case "actor_registered":
      return pick("kind");
    case "actor_claimed":
      return { ...pick("slug"), owner: named(payload.owner, names) };
    case "actor_joined_room":
      return pick("seat");
    case "actor_left_room":
      // Why the body left: `left` (it walked out) or `evicted` (it went quiet
      // past the eviction window). Both are what the live map already showed.
      return pick("reason");
    case "agent_phase":
      // `verb`, `seconds` and `detail` are already in the sentence; they are
      // published anyway because a reader that wants to total a day's time by
      // verb, or draw it, needs the numbers and not the prose. `url` and
      // `error_text` are the agent's own pulse fields, unchanged — the url is
      // already scheme-checked by presence.normalisePulseUrl on the way in.
      return pick("verb", "detail", "url", "error_text", "seconds", "started_at", "ended_at", "silent");
    case "stage.started":
    case "stage.ended":
      // The window, so a reader can see how long it ran without diffing two
      // rows. `eventId` and `roomId` are deliberately absent: one is an internal
      // handle and the other is already resolved to `roomName` on the entry.
      return pick("title", "startsAt", "endsAt");
    case "space.transferred":
      return { ...pick("space", "plot", "fromLeft"), from: named(payload.from, names), to: named(payload.to, names) };
    case "space.relocated":
      return pick("space", "fromPlot", "toPlot");
    case "trial.opened":
    case "trial.entered":
    case "trial.finished":
    case "trial.closed":
      // Never an answer, a nonce or a proof: none of them are in the payload,
      // and this allow-list would not publish them if they were.
      return pick("trialId", "title", "kind", "closesAt");
    case "board.posted":
      return pick("postId", "postKind", "space");
    case "table.created":
      return pick("tableId", "game", "clock");
    case "table.moved":
      return pick("tableId", "game", "seq", "move");
    case "table.ended":
      return { ...pick("tableId", "game", "result", "reason", "moves"), opponent: named(payload.targetId, names) };
    case "speech":
      return pick("channel");
    case "notice":
      return pick("title");
    case "permission_changed":
      // An agent's policy is public: the map draws it as badges and
      // GET /api/v1/a/* serves it. The `by` id is not published — the owner is
      // already named on the agent page, and an id is not a name.
      return pick("policy");
    case "instruction":
      return { ...pick("kind"), agent: named(payload.agentId, names) };
    case "key_rotated":
    case "key_revoked":
      return pick("keyId");
    case "key_bound":
      // Never the public key itself. It is not a secret, but it is a stable
      // identifier for an agent across systems and nothing here needs it.
      return pick("keyId", "algorithm");
    case "block":
    case "report":
      return { target: named(payload.targetId, names) };
    case "report_resolved":
      return pick("status", "action");
    case "prompt_injection_flag":
      return pick("channel");
    case "suspended":
      // `by` names the operator who acted. Not published even to the subject:
      // moderation is the world's decision, not an individual's, and naming
      // the moderator is a retaliation vector.
      return {};
    case "operator_bootstrap":
      return pick("handle");
    case "mod.suspend":
    case "mod.unsuspend":
    case "mod.warn":
      // `by` is in the payload and is deliberately not here: the subject is
      // owed the fact and the reason, not the name of the moderator.
      return { ...pick("targetKind", "reason"), target: named(payload.targetId, names) };
    case "mod.report_decided":
      return { ...pick("status", "decision", "category", "reason"), target: named(payload.targetId, names) };
    case "mod.injection_reviewed":
      return pick("outcome", "reason");
    case "mod.freeze":
      return pick("flag", "value", "reason");
    default:
      return {};
  }
}
