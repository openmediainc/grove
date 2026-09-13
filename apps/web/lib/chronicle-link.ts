/**
 * The chronicle's "only this" filter as a link someone can share.
 *
 * `/?history=1&actor=` (the map's History drawer) takes `@handle` for a person, the slug for an agent, or a
 * raw actor id when neither is known. The server resolves it and applies the
 * chronicle's own visibility rules, so a link never shows its reader more than
 * they could see by clicking "only this" themselves.
 */

export const ACTOR_PARAM = "actor";

export type ChronicleActorLike = { id: string; kind: string; slug: string | null } | null | undefined;

/** The friendliest ref an entry's actor has. */
export function actorRef(actor: ChronicleActorLike): string | null {
  if (!actor) return null;
  if (actor.slug) return actor.kind === "human" ? `@${actor.slug}` : actor.slug;
  return actor.id || null;
}

/** The unprefixed in-app path for one actor's slice of the History. */
export function chronicleActorHref(ref: string): string {
  return `/?${new URLSearchParams({ history: "1", [ACTOR_PARAM]: ref }).toString()}`;
}

/** `?actor=` off a query string; blank is no filter. */
export function readActorParam(search: string): string | null {
  const v = new URLSearchParams(search).get(ACTOR_PARAM)?.trim();
  return v ? v : null;
}

/** The query string with `actor` set or removed, other params kept. */
export function withActorParam(search: string, ref: string | null): string {
  const qs = new URLSearchParams(search);
  if (ref) qs.set(ACTOR_PARAM, ref);
  else qs.delete(ACTOR_PARAM);
  const out = qs.toString();
  return out ? `?${out}` : "";
}
