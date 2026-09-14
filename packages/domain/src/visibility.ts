/**
 * Who may see what happens in a place. ONE predicate, as SQL, shared by every
 * reader that reports activity (queue #50).
 *
 * Before this file each reader carried its own copy of the rule — the chronicle
 * applied the world gate type by type and forgot it for `notice`; the tool-call
 * history, the directory, the minimap's plots, search and the AWN agent list
 * each wrote (or skipped) their own. A reader that forgets a copy is a leak, so
 * the rule now lives here and a reader composes it rather than restating it.
 *
 * THE RULE. What happens in room `r` of space `w` is visible to a viewer when:
 *   - `r` is an owner's lounge: only to that owner. Nobody else, operators
 *     included — the lounge is the owner↔agent leash.
 *   - otherwise: the space is not `private` AND the room's own door is not
 *     `private` (migration 023) — or the viewer is inside the space (owner or
 *     member). A room opened as a lobby on a private plot does not widen the
 *     history of the space around it: the stricter of the two doors wins.
 * No operator bypass anywhere: the chronicle must not become the back door into
 * a space the front door refuses (assertWorldAccess gives operators none).
 *
 * `viewer` is an SQL expression for the viewer's human id (an agent reads as its
 * owner, a guest or a signed-out visitor as NULL), e.g. `$1` or `NULL`.
 * `world` may be NULL (a LEFT JOIN on a commons room with no world row): that
 * reads as a non-private space that nobody is inside.
 */

/** SQL: the viewer owns or is a member of space `world`. */
export function insideSpaceSql(world: string, viewer: string): string {
  return `(${viewer}::text IS NOT NULL AND ${world}.id IS NOT NULL AND (
    ${world}.owner_human_id = ${viewer}::text
    OR EXISTS (SELECT 1 FROM world_members vis_m
                WHERE vis_m.world_id = ${world}.id AND vis_m.human_id = ${viewer}::text)))`;
}

/**
 * SQL: the viewer may see what is posted in space `world` as a whole (queue #36,
 * the artifact board): exactly the space page's own door — a `private` space to
 * people inside it, anything else to anyone. No operator bypass: moderators read
 * a reported post through /mod, not through the board. Never NULL.
 */
export function spaceVisibleSql(world: string, viewer: string): string {
  return `COALESCE((${world}.policy_preset IS DISTINCT FROM 'private' OR ${insideSpaceSql(world, viewer)}), FALSE)`;
}

/** SQL: the viewer may see activity in room `room` of space `world`. Never NULL. */
export function roomActivityVisibleSql(room: string, world: string, viewer: string): string {
  return `COALESCE(CASE
    WHEN ${room}.kind = 'owner_lounge'
      THEN ${viewer}::text IS NOT NULL AND ${room}.owner_human_id = ${viewer}::text
    ELSE (${world}.policy_preset IS DISTINCT FROM 'private' AND ${room}.room_preset IS DISTINCT FROM 'private')
      OR ${insideSpaceSql(world, viewer)}
  END, FALSE)`;
}

/**
 * SQL: how many bodies stand in space `world` where this viewer could see them.
 * A private plot you are not inside counts zero — a headcount is activity, and
 * activity behind a closed door is not published (its public lobbies carry their
 * own counts in `open_rooms`).
 */
export function visibleOccupancySql(world: string, viewer: string): string {
  return `(SELECT count(*)::int FROM presence occ_p
             JOIN rooms occ_r ON occ_r.id = occ_p.room_id
            WHERE occ_r.world_id = ${world}.id
              AND ${roomActivityVisibleSql("occ_r", world, viewer)})`;
}
