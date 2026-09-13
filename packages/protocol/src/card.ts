/**
 * A card for every space and body: working on / looking for / latest / links.
 *
 * Who writes which field is the whole design:
 *
 *   space  — the owner writes all four.
 *   agent  — working on and latest FILL THEMSELVES from pulses and tool-call
 *            spans; the owner writes only looking for and links. An owner can
 *            never type "working on" for an agent, because then the card would
 *            be a claim rather than a reading.
 *   human  — the person writes all four about themselves.
 *
 * Everything here is pure so the server, the web editor and the tests agree on
 * one set of limits. What a viewer may SEE is decided in the domain
 * (CardService), never here.
 */
import { sanitiseCaption } from "./tool-calls.js";

// This package compiles with no DOM or Node lib, but every runtime it ships to
// (Node, the browser) has WHATWG URL. Module-scoped, so it shadows nothing.
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  host: string;
  toString(): string;
};

export const CARD_TEXT_MAX = 140;
export const CARD_LINKS_MAX = 4;
export const CARD_LINK_LABEL_MAX = 40;
export const CARD_URL_MAX = 300;

export type CardSubject = "space" | "agent" | "human";
export type CardField = "workingOn" | "lookingFor" | "latest" | "links";

export interface CardLink {
  label: string;
  url: string;
}

export interface CardFields {
  workingOn: string | null;
  lookingFor: string | null;
  latest: string | null;
  links: CardLink[];
}

export const EMPTY_CARD: CardFields = { workingOn: null, lookingFor: null, latest: null, links: [] };

/** Fields a subject's owner may write. Agents' working-on and latest are read, not written. */
export const CARD_EDITABLE: Record<CardSubject, readonly CardField[]> = {
  space: ["workingOn", "lookingFor", "latest", "links"],
  agent: ["lookingFor", "links"],
  human: ["workingOn", "lookingFor", "latest", "links"],
};

/**
 * One link, or null when it is not a link we will publish: http(s) only, no
 * credentials in the authority, capped. A label defaults to the host.
 */
export function normaliseCardLink(raw: unknown): CardLink | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.url === "string" ? o.url.trim() : "";
  if (!text || text.length > CARD_URL_MAX) return null;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const label = sanitiseCaption(o.label, CARD_LINK_LABEL_MAX) ?? u.host;
  return { label, url: u.toString() };
}

export type CardPatchResult =
  | { ok: true; patch: Partial<CardFields> }
  | { ok: false; message: string };

/**
 * Read a write off the wire for one subject. Absent keys are left alone; a
 * null or empty string clears a text field; `links` replaces the whole list.
 * A field the subject may not write is refused by name rather than dropped, so
 * an owner is told why "working on" did not stick.
 */
export function normaliseCardPatch(raw: unknown, subject: CardSubject): CardPatchResult {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const allowed = CARD_EDITABLE[subject];
  const patch: Partial<CardFields> = {};
  const keys: CardField[] = ["workingOn", "lookingFor", "latest", "links"];
  for (const key of keys) {
    if (!(key in o) || o[key] === undefined) continue;
    if (!allowed.includes(key)) {
      return {
        ok: false,
        message:
          subject === "agent"
            ? "An agent's working_on and latest fill themselves from its pulses and tool calls; set looking_for and links."
            : `${key} cannot be set here.`,
      };
    }
    if (key === "links") {
      const list = o.links;
      if (list === null) {
        patch.links = [];
        continue;
      }
      if (!Array.isArray(list)) return { ok: false, message: "links must be a list of { label, url }." };
      if (list.length > CARD_LINKS_MAX) return { ok: false, message: `At most ${CARD_LINKS_MAX} links.` };
      const links: CardLink[] = [];
      for (const item of list) {
        const link = normaliseCardLink(item);
        if (!link) return { ok: false, message: "Each link needs an http(s) url with no credentials in it." };
        links.push(link);
      }
      patch.links = links;
      continue;
    }
    const value = o[key];
    if (value !== null && typeof value !== "string") return { ok: false, message: `${key} must be text.` };
    patch[key] = sanitiseCaption(value, CARD_TEXT_MAX);
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: `Nothing to change: send ${allowed.map(snake).join(", ")}.` };
  }
  return { ok: true, patch };
}

/** A stored card (JSONB, either spelling) back into shape. Anything malformed reads as empty. */
export function readStoredCard(raw: unknown): CardFields {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CARD, links: [] };
  const o = raw as Record<string, unknown>;
  const text = (a: string, b: string) => {
    const v = o[a] ?? o[b];
    return typeof v === "string" && v ? v : null;
  };
  const links = Array.isArray(o.links)
    ? o.links.map(normaliseCardLink).filter((l): l is CardLink => l !== null).slice(0, CARD_LINKS_MAX)
    : [];
  return {
    workingOn: text("workingOn", "working_on"),
    lookingFor: text("lookingFor", "looking_for"),
    latest: text("latest", "latest"),
    links,
  };
}

export function mergeCard(stored: CardFields, patch: Partial<CardFields>): CardFields {
  return { ...stored, ...patch, links: patch.links ?? stored.links };
}

/** True when a card has nothing to say. */
export function isEmptyCard(card: CardFields): boolean {
  return !card.workingOn && !card.lookingFor && !card.latest && card.links.length === 0;
}

function snake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
