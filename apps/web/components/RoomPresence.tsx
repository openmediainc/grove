"use client";

import Link from "next/link";
import { Nameplate, asPermissionBadges } from "@grove/ui";
import type { Nearby } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";

/**
 * §5.5: "who is here" is the screen where "why won't it answer me?" gets asked,
 * so it is the screen that has to answer it. Every row states the CONSEQUENCE of
 * an actor's permissions for the reader, in the shared words from @grove/ui —
 * not the badge names, which name the boolean nobody cares about.
 *
 * `Nameplate` fits as-is: it already owns the kind chip, the owner byline, the
 * badge chips and the sentence, and it already knows the trap — when the SPACE
 * is what refuses, it spells out the recourse rather than leaving "owned by @x"
 * standing as the implied place to complain.
 */

/** The civic core narrows nothing; `campus.spacePolicyForRoom()` short-circuits on it. */
export const CIVIC_CORE_WORLD_ID = "aetheria-prime";

/** The slice of `GET /api/v1/worlds/:id` this needs. */
export type SpaceSilenceSource = {
  world: { id: string; policy_preset: string };
  members: Array<{ handle: string }>;
  is_member: boolean;
};

/**
 * Which actors in this room are stopped by the ROOM rather than by themselves.
 *
 * This cannot come from `badges()` — that only ever sees an actor's own matrix.
 * It is reconstructed from the same three facts the kernel composes:
 *
 *   1. the space's access level (`worlds.policy_preset`, resolved by
 *      SPACE_POLICY_PRESETS: only `public_write` lets a non-member speak),
 *   2. membership of that space, which for an agent is its OWNER's membership,
 *   3. the actor's own matrix, because the space is only the explanation when
 *      the actor still holds the capability themselves. This is the kernel's own
 *      derivation rule for `source: "space"`: "a capability the actor still
 *      holds can only have been removed by the space."
 *
 * Deliberately returns an EMPTY set rather than a guess whenever any of those is
 * unavailable — a wrong "muted here" sends the reader to the wrong door.
 */
export function spaceSilencedActorIds(
  nearby: Nearby[],
  roomWorldId: string | undefined,
  space: SpaceSilenceSource | null,
): Set<string> {
  const out = new Set<string>();
  if (!roomWorldId || roomWorldId === CIVIC_CORE_WORLD_ID) return out;
  if (!space || space.world.id !== roomWorldId) return out;
  // public_write is identical to no space policy at all.
  if (space.world.policy_preset === "public_write") return out;
  // The roster is member-only. Without it we cannot tell a member (who sits at
  // the full ceiling) from a non-member, so we say nothing. In practice we are
  // always a member here: assertWorldAccess() refuses a non-member the room.
  if (!space.is_member) return out;

  const members = new Set(space.members.map((m) => m.handle));
  for (const n of nearby) {
    const memberHandle = n.kind === "human" ? n.slug : n.owner_handle;
    if (memberHandle && members.has(memberHandle)) continue;
    // Humans carry no matrix (§5.1), so their actor half is implicitly all-true
    // and the space is the only thing that can be narrowing them.
    const stillHoldsSpeech =
      n.kind === "human" ? true : asPermissionBadges(n.badges).includes("speaks_to_humans");
    if (stillHoldsSpeech) out.add(n.actor_id);
  }
  return out;
}

export function RoomPresence({
  nearby,
  silencedActorIds,
  meId,
}: {
  nearby: Nearby[];
  silencedActorIds: Set<string>;
  meId?: string;
}) {
  if (nearby.length === 0) {
    return <p className="mt-3 text-sm text-white/40">Nobody is here.</p>;
  }
  return (
    <ul className="mt-3 space-y-3 text-sm">
      {nearby.map((n) => {
        const you = n.actor_id === meId;
        const badges = asPermissionBadges(n.badges);
        const silencedBySpace = silencedActorIds.has(n.actor_id);
        return (
          <li key={n.actor_id} className="flex items-start gap-2">
            <GeoAvatar kind={n.kind} seed={n.actor_id} size={22} label={false} />
            <div className="min-w-0">
              <Link href={n.kind === "agent" ? `/a/${n.slug}` : `/u/${n.slug}`}>
                <Nameplate
                  kind={n.kind}
                  name={n.display_name}
                  slug={n.slug}
                  ownerHandle={n.owner_handle}
                  badges={badges}
                  silencedBySpace={silencedBySpace}
                  you={you}
                />
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
