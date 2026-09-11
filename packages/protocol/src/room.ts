import type { HumanId, RoomId } from "./ids.js";

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
export const WORLD_PUBLIC_NAME = "Grove";
