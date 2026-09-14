import { explainCapabilities, type CapabilityVerdicts } from "@grove/policy";
import {
  WORLD_ID,
  spacePolicyForPreset,
  type CeilingLayers,
  type Human,
  type PermissionPolicy,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";
import type { GroveStore } from "../store.js";
import type { CampusService, WorldRow } from "./campus.js";
import type { IdentityService } from "./identity.js";

/**
 * #62 — "Where this agent can talk": for its owner only, each place the agent
 * is in or its owner belongs to, with all four capabilities resolved as
 * effective = the agent's own matrix ∩ that place's ceiling, attributed by the
 * kernel's own rule (`explainCapabilities`, which shares `authorize()`'s
 * attribution). Nothing here decides anything a refusal would not.
 *
 * Privacy: a private space is listed only when the owner is a member of it.
 * The single exception is a lobby the owner's agent is standing in on a private
 * plot — its ROOM is public (it is listed as a way in), so it is named, but the
 * space behind it keeps no name, exactly as the directory redacts it.
 */

export interface EffectiveRoom {
  id: string;
  slug: string;
  name: string;
  /** The room's own non-member preset. Null = follows the space. */
  roomPreset: SpacePolicyPreset | null;
  memberPolicy: SpacePolicy | null;
  here: boolean;
  verdicts: CapabilityVerdicts;
}

export interface EffectiveSpace {
  id: string;
  /** Null for a held plot the owner is not inside (a lobby the agent stands in). */
  slug: string | null;
  name: string | null;
  commons: boolean;
  preset: SpacePolicyPreset;
  memberPolicy: SpacePolicy | null;
  /** The agent's membership, which is its owner's. */
  isMember: boolean;
  isOwner: boolean;
  /** The agent is standing somewhere in this space right now. */
  here: boolean;
  /** The space as a whole (rooms that follow it). */
  verdicts: CapabilityVerdicts;
  /** Only rooms that differ from the space, plus the room the agent is in. */
  rooms: EffectiveRoom[];
}

export interface EffectivePermissions {
  agentId: string;
  policy: PermissionPolicy;
  spaces: EffectiveSpace[];
}

export class EffectivePermissionsService {
  constructor(
    private store: GroveStore,
    private identity: IdentityService,
    private campus: CampusService,
  ) {}

  async forOwner(agentId: string, owner: Human): Promise<EffectivePermissions> {
    // 404 for anyone but the owner, identical to a missing agent.
    const agent = await this.identity.requireOwned(agentId, owner);
    const policy = agent.policy;

    const { rows: presenceRows } = await this.store.pg.query(
      `SELECT r.id, r.world_id
         FROM presence p JOIN rooms r ON r.id = p.room_id
        WHERE p.actor_id = $1`,
      [agent.id],
    );
    const here = presenceRows[0]
      ? {
          roomId: String(presenceRows[0].id),
          worldId: String(presenceRows[0].world_id ?? WORLD_ID),
        }
      : null;

    // The owner's own spaces (listForHuman includes the commons first).
    const worlds = (await this.campus.listForHuman(owner.id)).filter((w) => !w.archivedAt);
    const out: EffectiveSpace[] = [];
    const seen = new Set<string>();
    for (const w of worlds) {
      seen.add(w.id);
      out.push(await this.spaceView(w, policy, owner.id, here));
    }
    if (!seen.has(WORLD_ID)) {
      const commons = await this.campus.getWorld(WORLD_ID);
      if (commons) out.unshift(await this.spaceView(commons, policy, owner.id, here));
    }

    // Standing in a space the owner does not belong to: a public space is
    // listed as a visitor; a private one only through an open lobby.
    if (here && !seen.has(here.worldId) && here.worldId !== WORLD_ID) {
      const w = await this.campus.getWorld(here.worldId);
      if (w && !w.archivedAt) {
        if (w.policyPreset !== "private") {
          out.push(await this.spaceView(w, policy, owner.id, here));
        } else {
          const lobby = await this.campus.visitableRoom(w.id, here.roomId);
          if (lobby) {
            const view = await this.spaceView(w, policy, owner.id, here);
            out.push({ ...view, slug: null, name: null, isOwner: false, rooms: view.rooms.filter((r) => r.id === lobby.id) });
          }
        }
      }
    }

    return { agentId: agent.id, policy, spaces: out };
  }

  private async spaceView(
    w: WorldRow,
    policy: PermissionPolicy,
    ownerId: string,
    here: { roomId: string; worldId: string } | null,
  ): Promise<EffectiveSpace> {
    const commons = w.id === WORLD_ID;
    const isMember = commons ? true : await this.campus.isMember(w.id, ownerId);
    const spaceLayers: CeilingLayers | undefined = commons
      ? undefined
      : {
          policy: w.spacePolicy ?? spacePolicyForPreset(w.policyPreset),
          ...(w.memberPolicy ? { memberPolicy: w.memberPolicy } : {}),
        };
    const rooms: EffectiveRoom[] = [];
    if (commons) {
      // The commons narrows nothing; only the room the agent stands in is worth
      // naming. Read by id, not by listing every room of the civic core (every
      // person's lounge lives there too).
      if (here?.worldId === WORLD_ID) {
        const { rows } = await this.store.pg.query(
          `SELECT id, slug, name, kind, owner_human_id FROM rooms WHERE id = $1`,
          [here.roomId],
        );
        const r = rows[0];
        // Someone else's lounge is never named, even if the agent stood in one.
        if (r && !(r.kind === "owner_lounge" && r.owner_human_id !== ownerId)) {
          rooms.push({
            id: String(r.id),
            slug: String(r.slug),
            name: String(r.name),
            roomPreset: null,
            memberPolicy: null,
            here: true,
            verdicts: explainCapabilities(policy, undefined, true),
          });
        }
      }
    } else {
      for (const r of await this.campus.roomsOf(w.id)) {
        const isHere = here?.roomId === r.id;
        const differs = r.roomPreset !== null || r.memberPolicy !== null;
        if (!isHere && !differs) continue;
        // A room with a closed door is not named to someone outside the space.
        if (!isHere && !isMember && !r.admitsNonMembers) continue;
        rooms.push({
          id: r.id,
          slug: r.slug,
          name: r.name,
          roomPreset: r.roomPreset,
          memberPolicy: r.memberPolicy,
          here: isHere,
          verdicts: explainCapabilities(policy, await this.campus.ceilingLayersForRoom(r.id), isMember),
        });
      }
    }
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      commons,
      preset: commons ? "public_write" : w.policyPreset,
      memberPolicy: commons ? null : w.memberPolicy,
      isMember,
      isOwner: !commons && w.ownerHumanId === ownerId,
      here: here?.worldId === w.id,
      verdicts: explainCapabilities(policy, spaceLayers, isMember),
      rooms,
    };
  }
}
