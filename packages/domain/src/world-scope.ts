import { WORLD_ID } from "@grove/protocol";

export const WORLD_COOKIE = "grove_world";
export const WORLD_HEADER = "x-grove-world";

export function resolveWorldId(header?: string | string[], cookie?: string | null): string {
  const h = Array.isArray(header) ? header[0] : header;
  const raw = (h || cookie || WORLD_ID).trim();
  return raw || WORLD_ID;
}
