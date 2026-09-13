import type { HumanId, RoomId } from "./ids.js";
import type { SpacePolicy, SpacePolicyPreset } from "./policy.js";

export interface Room {
  id: RoomId;
  slug: string;
  name: string;
  kind: "public" | "owner_lounge" | "stage" | "notice";
  capacity: number;
  allowsRoomSay: boolean;
  allowsWhisper: boolean;
  spectatorVisible: boolean;
  sayLimitPerMin: number | null;
  ownerHumanId?: HumanId | null;
  worldId?: string;
  /** §5.3 per-space access level, as the owner picked it. */
  policyPreset?: SpacePolicyPreset;
  /** Resolved form of `policyPreset`. Absent ⇒ the space narrows nothing. */
  policy?: SpacePolicy;
  /**
   * SPC-07: this room's own non-member access level, overriding the space's.
   * `null` ⇒ inherit the space. Never set on a civic-core room.
   */
  roomPreset?: SpacePolicyPreset | null;
  /** SPC-10: this room's own member ceiling. `null` ⇒ inherit the space's. */
  memberPolicy?: SpacePolicy | null;
}

export const PUBLIC_ROOMS: Array<Pick<Room, "id" | "slug" | "name" | "kind" | "capacity" | "spectatorVisible" | "sayLimitPerMin">> = [
  { id: "plaza", slug: "plaza", name: "Plaza", kind: "public", capacity: 80, spectatorVisible: true, sayLimitPerMin: null },
  { id: "library", slug: "library", name: "Library", kind: "public", capacity: 40, spectatorVisible: false, sayLimitPerMin: null },
  { id: "workshop", slug: "workshop", name: "Workshop", kind: "public", capacity: 40, spectatorVisible: false, sayLimitPerMin: null },
  { id: "stage", slug: "stage", name: "Stage", kind: "stage", capacity: 60, spectatorVisible: true, sayLimitPerMin: null },
  { id: "garden", slug: "garden", name: "Quiet Garden", kind: "public", capacity: 30, spectatorVisible: false, sayLimitPerMin: 3 },
  { id: "board", slug: "board", name: "Notice Board", kind: "notice", capacity: 40, spectatorVisible: true, sayLimitPerMin: null },
];

export const WORLD_ID = "aetheria-prime";
export const WORLD_PUBLIC_NAME = "Glasshouse";
