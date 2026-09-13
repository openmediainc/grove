/**
 * The card on every space and body: working on / looking for / latest / links,
 * plus Walk over, Follow and Copy link.
 *
 * Pure, so what the card asks for, what it shows and where Walk over goes can be
 * tested without a browser. Visibility is the server's: a private space's card
 * answers 404 to a non-member and the map never asks for one it drew redacted.
 */
import { CARD_EDITABLE, CARD_LINKS_MAX, type CardField, type CardLink, type CardSubject } from "@grove/protocol";
import type { ThemeLexicon } from "./themes/types";

export type CardTarget =
  | { subject: "agent"; slug: string }
  | { subject: "human"; slug: string }
  | { subject: "space"; ref: string };

/** A card as the API sends it (snake_case off the wire). */
export type WireCard = {
  subject: CardSubject;
  slug: string;
  name: string;
  card: { working_on: string | null; looking_for: string | null; latest: string | null; links: CardLink[] };
  sources: { working_on: CardSourceWire; latest: CardSourceWire };
  latest_at: string | null;
  editable: CardField[];
};

export type CardSourceWire = "owner" | "span" | "pulse" | null;

/** Path segments encoded one at a time, so a slug can never climb out of its route. */
function enc(s: string): string {
  return s.split("/").map(encodeURIComponent).join("/");
}

export function cardApiPath(t: CardTarget): string {
  if (t.subject === "space") return `/api/v1/cards/spaces/${encodeURIComponent(t.ref)}`;
  if (t.subject === "agent") return `/api/v1/cards/agents/${enc(t.slug)}`;
  return `/api/v1/cards/humans/${encodeURIComponent(t.slug)}`;
}

/** Where the owner's edit goes. Agents are addressed by id, people by session. */
export function cardSavePath(subject: CardSubject, id: string): string {
  if (subject === "space") return `/api/v1/worlds/${encodeURIComponent(id)}/card`;
  if (subject === "agent") return `/api/v1/agents/${encodeURIComponent(id)}/card`;
  return "/api/v1/humans/me/card";
}

export type CardRow = { field: Exclude<CardField, "links">; label: string; value: string; hint: string | null };

/**
 * The rows a card shows, in a fixed order, skipping empty ones. A derived row
 * says where it came from, so a reader can tell a reading from a claim.
 */
export function cardRows(w: WireCard, lex: ThemeLexicon["card"]): CardRow[] {
  const rows: CardRow[] = [];
  const hint = (s: CardSourceWire) => (s === "span" ? lex.fromToolCalls : s === "pulse" ? lex.fromPulse : null);
  if (w.card.working_on) rows.push({ field: "workingOn", label: lex.workingOn, value: w.card.working_on, hint: hint(w.sources.working_on) });
  if (w.card.looking_for) rows.push({ field: "lookingFor", label: lex.lookingFor, value: w.card.looking_for, hint: null });
  if (w.card.latest) rows.push({ field: "latest", label: lex.latest, value: w.card.latest, hint: hint(w.sources.latest) });
  return rows;
}

/**
 * Walk over. A body: into the room it stands in (a spectator is asked to sign in
 * first, told why). A space: to its page, where its own door decides Enter or
 * Visit. Never a redacted plot: the caller has no slug for one.
 */
export function walkOverTarget(
  t: { kind: "body"; room: string } | { kind: "space"; slug: string },
  signedIn: boolean | null,
): { path: string; needsLogin: boolean } {
  const path = t.kind === "body" ? `/w/${encodeURIComponent(t.room)}` : `/spaces/${encodeURIComponent(t.slug)}`;
  return { path, needsLogin: t.kind === "body" && signedIn === false };
}

/** An edit form's state, and the body a save sends. Only fields this subject writes. */
export type CardDraft = { workingOn: string; lookingFor: string; latest: string; links: Array<{ label: string; url: string }> };

export function draftFrom(w: WireCard | null): CardDraft {
  return {
    workingOn: w?.card.working_on ?? "",
    lookingFor: w?.card.looking_for ?? "",
    latest: w?.card.latest ?? "",
    links: (w?.card.links ?? []).map((l) => ({ label: l.label, url: l.url })),
  };
}

export function draftToBody(subject: CardSubject, d: CardDraft): Record<string, unknown> {
  const allowed = CARD_EDITABLE[subject];
  const out: Record<string, unknown> = {};
  if (allowed.includes("workingOn")) out.working_on = d.workingOn.trim() || null;
  if (allowed.includes("lookingFor")) out.looking_for = d.lookingFor.trim() || null;
  if (allowed.includes("latest")) out.latest = d.latest.trim() || null;
  if (allowed.includes("links")) {
    out.links = d.links
      .filter((l) => l.url.trim())
      .slice(0, CARD_LINKS_MAX)
      .map((l) => ({ label: l.label.trim() || undefined, url: l.url.trim() }));
  }
  return out;
}
