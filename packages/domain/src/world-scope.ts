import { WORLD_ID } from "@grove/protocol";

export const WORLD_COOKIE = "grove_world";
export const WORLD_HEADER = "x-grove-world";

/**
 * A world id exactly as a client asked for it, via the x-grove-world header or
 * the grove_world cookie. It is a REQUEST, never a grant: nothing here has
 * checked that the caller is entitled to see that world.
 *
 * It is a wrapper object rather than a bare string on purpose. A bare string
 * could be handed straight to anything that scopes a query by world id — which
 * is exactly the bug this type exists to prevent — whereas unwrapping
 * `.requested` is a deliberate act. The only place that unwraps it is
 * assertWorldAccess() in apps/api/src/auth.ts, which enforces membership before
 * returning a usable id.
 */
export interface UnverifiedWorldId {
  readonly requested: string;
}

/**
 * Parse the requested world id. Parsing only — this performs NO authorization.
 */
export function resolveWorldId(header?: string | string[], cookie?: string | null): UnverifiedWorldId {
  const h = Array.isArray(header) ? header[0] : header;
  const raw = (h || cookie || WORLD_ID).trim();
  return { requested: raw || WORLD_ID };
}
