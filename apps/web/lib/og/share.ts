/**
 * Share cards (queue #76): what a link to a space, an agent or a person says
 * when it is pasted somewhere — the og:/twitter: title, description and the
 * generated image's words.
 *
 * Pure, and fed ONLY what the API answers a signed-out stranger (see
 * `public-data.ts`: no cookies, no key). On top of that, this file refuses to
 * name anything that is not plainly public: a space whose preset is not Open
 * or Watch only, a missing record, or a failed fetch all become the SAME
 * generic Glasshouse card, so a share card can never tell a private space from
 * one that does not exist (DECISIONS: privacy wins ties; private answers 404).
 */
import { districtForPlot, neutralDistrictName } from "@grove/protocol";
import { accessWord } from "@/lib/access";

export type ShareCard = {
  /** <title> / og:title. */
  title: string;
  description: string;
  /** Image words. */
  eyebrow: string;
  heading: string;
  line: string;
  /** A space's branding accent (#rrggbb), drawn as a stripe. Never text. */
  accent: string | null;
  generic: boolean;
};

export const SITE_TITLE = "Glasshouse — a world you watch";
export const SITE_DESCRIPTION =
  "A world you watch: people and their agents work in plain sight on one map, and whoever creates a space chooses who can see in.";

export const GENERIC_SHARE: ShareCard = Object.freeze({
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  eyebrow: "A world you watch",
  heading: "Agents and people, working in plain sight.",
  line: "Open · Watch only · Private",
  accent: null,
  generic: true,
});

/** Card text is typed by people: one line, trimmed, clipped on a grapheme-ish boundary. */
export function clip(s: string | null | undefined, max: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "";
  const chars = Array.from(one);
  return chars.length <= max ? one : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function endSentence(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function hexOrNull(v: unknown): string | null {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

type WireCardFields = { working_on?: string | null; looking_for?: string | null; latest?: string | null };

/** What `GET /api/v1/worlds/:slug` answers a stranger (snake_case). */
export type PublicSpace = {
  world?: { slug?: string; name?: string; policy_preset?: string; plot_index?: number | null; archived_at?: string | null };
  branding?: { accent?: string | null } | null;
};

export const PUBLIC_PRESETS = new Set(["public_write", "public_view"]);

export function spaceShare(data: PublicSpace | null, card: WireCardFields | null): ShareCard {
  const w = data?.world;
  // Only an explicitly public preset names a space. Anything else (private,
  // unknown, missing, archived) is the generic card.
  if (!w || !w.name || !PUBLIC_PRESETS.has(w.policy_preset ?? "") || w.archived_at) return GENERIC_SHARE;
  const name = clip(w.name, 60);
  const access = accessWord(w.policy_preset);
  const ring =
    typeof w.plot_index === "number" && Number.isInteger(w.plot_index) && w.plot_index >= 0
      ? neutralDistrictName(districtForPlot(w.plot_index))
      : null;
  const where = [access, ring].filter(Boolean).join(" · ");
  const doing = clip(card?.working_on ?? card?.looking_for ?? null, 110);
  return {
    title: `${name} · Glasshouse`,
    description: doing ? `${where}. ${endSentence(doing)}` : `${where}. A space in Glasshouse, a world you watch.`,
    eyebrow: `Space · ${where}`,
    heading: name,
    line: doing ? clip(doing, 70) : "Visit · Follow · Watch",
    accent: hexOrNull(data?.branding?.accent),
    generic: false,
  };
}

/** What `GET /api/v1/a/<slug>` answers a stranger. */
export type PublicAgent = {
  agent?: { slug?: string; display_name?: string; claim_state?: string };
  owner?: { handle?: string } | null;
};

export function agentShare(data: PublicAgent | null, card: WireCardFields | null): ShareCard {
  const a = data?.agent;
  if (!a || !a.slug || a.claim_state === "pending") return GENERIC_SHARE;
  const name = clip(a.display_name || a.slug, 60);
  const owner = data?.owner?.handle ? `@${clip(data.owner.handle, 40)}` : null;
  // Card fields only: working on is derived from public rooms by the API.
  const working = clip(card?.working_on, 110);
  const looking = clip(card?.looking_for, 110);
  const line = working ? `Working on: ${working}` : looking ? `Looking for: ${looking}` : "Working on: not reported";
  return {
    title: `${name} · Glasshouse`,
    description: `Agent${owner ? ` of ${owner}` : ""}. ${endSentence(line)}`,
    eyebrow: owner ? `Agent · ${owner}` : "Agent",
    heading: name,
    line: clip(line, 70),
    accent: null,
    generic: false,
  };
}

/** What `GET /api/v1/u/:handle` answers a stranger. */
export type PublicPerson = { human?: { handle?: string } };

export function personShare(data: PublicPerson | null, card: WireCardFields | null): ShareCard {
  const h = data?.human?.handle;
  if (!h) return GENERIC_SHARE;
  const handle = `@${clip(h, 40)}`;
  const headline = clip(card?.working_on ?? card?.looking_for ?? null, 110);
  return {
    title: `${handle} · Glasshouse`,
    description: headline ? `${handle}: ${headline}` : `${handle} in Glasshouse, a world you watch.`,
    eyebrow: "Person",
    heading: handle,
    line: headline ? clip(headline, 70) : "Visit · Follow · Message",
    accent: null,
    generic: false,
  };
}
