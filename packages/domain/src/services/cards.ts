import {
  CARD_EDITABLE,
  VERB_LABEL,
  WORLD_ID,
  describeToolCall,
  isActiveVerb,
  mergeCard,
  normaliseCardPatch,
  readStoredCard,
  type AgentVerb,
  type CardField,
  type CardFields,
  type CardSubject,
  type Human,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import { GroveError } from "../errors.js";
import type { CampusService } from "./campus.js";
import type { IdentityService } from "./identity.js";
import { toToolCallView } from "./tool-calls.js";
import { isStalledPulse } from "./presence.js";

/** Where a derived field came from, so the card can say "from its tool calls". */
export type CardSource = "owner" | "span" | "pulse" | null;

export interface CardView {
  subject: CardSubject;
  /** The public handle: a space slug, an agent slug, a human handle. */
  slug: string;
  name: string;
  card: CardFields;
  sources: { workingOn: CardSource; latest: CardSource };
  /** When "latest" happened, if it is a reading rather than something typed. */
  latestAt: string | null;
  /** Fields THIS viewer may write. Empty for everyone but the owner. */
  editable: CardField[];
}

const NOT_FOUND = () => new GroveError("NOT_FOUND", "Not found.", { httpStatus: 404 });

/**
 * Rooms a viewer may read a body's activity from: the rooms the minimap would
 * show them. A public (non-lounge) room of the commons, or a room of a space
 * the viewer belongs to. An agent's pulse or tool call in a private space, an
 * owner's lounge, or any space the viewer is not in never reaches its card —
 * otherwise the card would be a way to read through a closed door.
 *
 * `$v` is the viewer's human id (an agent reads as its owner) or NULL.
 */
const VISIBLE_ROOM = (room: string, v: string) => `(
  ${room}.kind <> 'owner_lounge' AND (
    ${room}.world_id = '${WORLD_ID}'
    OR (${v}::text IS NOT NULL AND EXISTS (
      SELECT 1 FROM worlds cw
        LEFT JOIN world_members cm ON cm.world_id = cw.id AND cm.human_id = ${v}::text
       WHERE cw.id = ${room}.world_id AND cw.archived_at IS NULL
         AND (cw.owner_human_id = ${v}::text OR cm.human_id IS NOT NULL)))
  ))`;

/**
 * Cards (migration 027). See @grove/protocol card.ts for who writes what.
 *
 * Visibility, in one place:
 *  - A space's card is behind the same door as its name. A private space answers
 *    404 to a non-member, identical to "no such space", whether asked by id or
 *    slug. An archived space is gone.
 *  - An agent's written fields are as public as its /a profile (a pending agent
 *    is 404). Its derived fields read only from rooms the viewer could watch.
 *  - A human's card is as public as /u/:handle, and is only ever what they wrote.
 */
export class CardService {
  constructor(
    private store: GroveStore,
    private identity: IdentityService,
    private campus: CampusService,
  ) {}

  // ------------------------------------------------------------------ spaces

  async spaceCard(viewer: Human | null, ref: string): Promise<CardView> {
    const world = await this.campus.getWorld(ref);
    if (!world || world.archivedAt) throw NOT_FOUND();
    const member = viewer ? await this.campus.isMember(world.id, viewer.id) : false;
    if (world.policyPreset === "private" && world.id !== WORLD_ID && !member) throw NOT_FOUND();
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM worlds WHERE id = $1`, [world.id]);
    return {
      subject: "space",
      slug: world.slug,
      name: world.name,
      card: readStoredCard(rows[0]?.card),
      sources: { workingOn: "owner", latest: "owner" },
      latestAt: null,
      editable: viewer && this.campus.canOperate(viewer, world) ? [...CARD_EDITABLE.space] : [],
    };
  }

  async setSpaceCard(human: Human, ref: string, raw: unknown): Promise<CardView> {
    const world = await this.campus.requireWorld(ref);
    if (world.archivedAt) throw NOT_FOUND();
    await this.campus.assertOperate(human, world);
    const patch = readPatch(raw, "space");
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM worlds WHERE id = $1`, [world.id]);
    const next = mergeCard(readStoredCard(rows[0]?.card), patch);
    await this.store.pg.query(`UPDATE worlds SET card = $2 WHERE id = $1`, [world.id, JSON.stringify(next)]);
    return this.spaceCard(human, world.id);
  }

  // ------------------------------------------------------------------ agents

  /** `viewerHumanId` is the human looking, or an agent's owner; null signed out. */
  async agentCard(viewerHumanId: string | null, slugOrId: string): Promise<CardView> {
    const agent = (await this.identity.getAgentBySlug(slugOrId)) ?? (await this.identity.getAgent(slugOrId));
    if (!agent || agent.claimState === "pending") throw NOT_FOUND();
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM agents WHERE id = $1`, [agent.id]);
    const stored = readStoredCard(rows[0]?.card);
    const now = Date.now();

    // Working on: an open span first (it has a name and a shape), then the
    // pulse's own caption. Both only from a room this viewer could watch.
    let workingOn: string | null = null;
    let workingSource: CardSource = null;
    const open = await this.store.pg.query(
      `SELECT t.* FROM tool_calls t JOIN rooms r ON r.id = t.room_id
        WHERE t.actor_id = $1 AND t.finished_at IS NULL AND ${VISIBLE_ROOM("r", "$2")}
        ORDER BY t.started_at DESC LIMIT 1`,
      [agent.id, viewerHumanId],
    );
    if (open.rows[0]) {
      workingOn = describeToolCall(toToolCallView(open.rows[0] as Record<string, unknown>, now));
      workingSource = "span";
    } else {
      const pulse = await this.store.pg.query<{ verb: string | null; detail: string | null; pulsed_at: Date | string | null }>(
        `SELECT p.verb, p.detail, p.pulsed_at FROM presence p JOIN rooms r ON r.id = p.room_id
          WHERE p.actor_id = $1 AND ${VISIBLE_ROOM("r", "$2")}`,
        [agent.id, viewerHumanId],
      );
      const p = pulse.rows[0];
      const verb = p?.verb && p.verb in VERB_LABEL ? (p.verb as AgentVerb) : null;
      if (p && verb && isActiveVerb(verb)) {
        const pulsedAt = p.pulsed_at ? new Date(p.pulsed_at).toISOString() : null;
        const said = p.detail?.trim() || VERB_LABEL[verb];
        workingOn = isStalledPulse(verb, pulsedAt, now) ? `${said} · gone quiet` : said;
        workingSource = "pulse";
      }
    }

    // Latest: the most recent finished span it reported, from the same rooms.
    const done = await this.store.pg.query(
      `SELECT t.* FROM tool_calls t JOIN rooms r ON r.id = t.room_id
        WHERE t.actor_id = $1 AND t.finished_at IS NOT NULL AND ${VISIBLE_ROOM("r", "$2")}
        ORDER BY t.finished_at DESC LIMIT 1`,
      [agent.id, viewerHumanId],
    );
    const last = done.rows[0] ? toToolCallView(done.rows[0] as Record<string, unknown>, now) : null;

    return {
      subject: "agent",
      slug: agent.slug,
      name: agent.displayName,
      card: {
        workingOn,
        lookingFor: stored.lookingFor,
        latest: last ? describeToolCall(last) : null,
        links: stored.links,
      },
      sources: { workingOn: workingSource, latest: last ? "span" : null },
      latestAt: last?.finishedAt ?? null,
      editable: viewerHumanId && agent.ownerHumanId === viewerHumanId ? [...CARD_EDITABLE.agent] : [],
    };
  }

  async setAgentCard(human: Human, agentId: string, raw: unknown): Promise<CardView> {
    const agent = await this.identity.requireOwned(agentId, human);
    const patch = readPatch(raw, "agent");
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM agents WHERE id = $1`, [agent.id]);
    const next = mergeCard(readStoredCard(rows[0]?.card), patch);
    // Only the fields an owner writes are ever stored for an agent.
    const stored = { lookingFor: next.lookingFor, links: next.links };
    await this.store.pg.query(`UPDATE agents SET card = $2 WHERE id = $1`, [agent.id, JSON.stringify(stored)]);
    return this.agentCard(human.id, agent.id);
  }

  // ------------------------------------------------------------------ humans

  async humanCard(viewer: Human | null, handle: string): Promise<CardView> {
    const human = await this.identity.getHumanByHandle(handle);
    if (!human) throw NOT_FOUND();
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM humans WHERE id = $1`, [human.id]);
    return {
      subject: "human",
      slug: human.handle,
      name: human.displayName,
      card: readStoredCard(rows[0]?.card),
      sources: { workingOn: "owner", latest: "owner" },
      latestAt: null,
      editable: viewer?.id === human.id ? [...CARD_EDITABLE.human] : [],
    };
  }

  async setHumanCard(human: Human, raw: unknown): Promise<CardView> {
    const patch = readPatch(raw, "human");
    const { rows } = await this.store.pg.query<{ card: unknown }>(`SELECT card FROM humans WHERE id = $1`, [human.id]);
    const next = mergeCard(readStoredCard(rows[0]?.card), patch);
    await this.store.pg.query(`UPDATE humans SET card = $2 WHERE id = $1`, [human.id, JSON.stringify(next)]);
    return this.humanCard(human, human.handle);
  }
}

function readPatch(raw: unknown, subject: CardSubject): Partial<CardFields> {
  const r = normaliseCardPatch(raw, subject);
  if (!r.ok) throw new GroveError("INVALID", r.message);
  return r.patch;
}
