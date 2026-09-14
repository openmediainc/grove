/**
 * Server-side, signed-out reads for share cards (queue #76).
 *
 * Every request goes out with NO cookie, NO authorization header and NO
 * forwarded client headers, so the API answers exactly what a stranger may
 * see: a private space is a 404 here even when the person sharing the link is
 * a member. Any failure (404, timeout, bad JSON, API down) is `null`, which the
 * share builders turn into the generic card.
 */
import { GROVE_BASE } from "@/lib/base";
import {
  agentShare,
  personShare,
  spaceShare,
  type PublicAgent,
  type PublicPerson,
  type PublicSpace,
  type ShareCard,
} from "@/lib/og/share";

/** Where the API is, from the web server's point of view. */
export function apiOrigin(env: Record<string, string | undefined> = process.env): string {
  if (env.GROVE_SHARE_API_ORIGIN) return env.GROVE_SHARE_API_ORIGIN.replace(/\/+$/, "");
  if (env.VERCEL) {
    // Vercel routes /api/* on the same host to the api service.
    if (env.VERCEL_ENV === "production") return siteOrigin(env);
    if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  }
  // Mini / local: the API listens on loopback without the /grove base path.
  return (env.GROVE_API_ORIGIN ?? "http://127.0.0.1:3511").replace(/\/+$/, "");
}

/**
 * The absolute site the metadata is written against (og:image must be absolute).
 * Prefer the configured public URL; on Vercel fall back to the production host.
 */
export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  const pub = env.GROVE_PUBLIC_URL?.replace(/\/+$/, "");
  if (pub) {
    try {
      return new URL(pub).origin;
    } catch {
      /* fall through */
    }
  }
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL) return "https://glasshouse.rendrr.app";
  return "http://127.0.0.1:3510";
}

const TIMEOUT_MS = 2500;

async function strangerGet<T>(path: string): Promise<T | null> {
  const origin = apiOrigin();
  // On Vercel the api is at the site root; locally the api has no base path either.
  const url = `${origin}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as T & { ok?: boolean };
    return json && json.ok !== false ? json : null;
  } catch {
    return null;
  }
}

const seg = (s: string) => encodeURIComponent(s);
const segs = (s: string) => s.split("/").filter(Boolean).map(encodeURIComponent).join("/");

type CardWire = { card?: { card?: { working_on?: string | null; looking_for?: string | null; latest?: string | null } } };

export async function spaceShareFor(slug: string): Promise<ShareCard> {
  const [space, card] = await Promise.all([
    strangerGet<PublicSpace>(`/api/v1/worlds/${seg(slug)}`),
    strangerGet<CardWire>(`/api/v1/cards/spaces/${seg(slug)}`),
  ]);
  return spaceShare(space, card?.card?.card ?? null);
}

export async function agentShareFor(slug: string): Promise<ShareCard> {
  const [agent, card] = await Promise.all([
    strangerGet<PublicAgent>(`/api/v1/a/${segs(slug)}`),
    strangerGet<CardWire>(`/api/v1/cards/agents/${segs(slug)}`),
  ]);
  return agentShare(agent, card?.card?.card ?? null);
}

export async function personShareFor(handle: string): Promise<ShareCard> {
  const [person, card] = await Promise.all([
    strangerGet<PublicPerson>(`/api/v1/u/${seg(handle)}`),
    strangerGet<CardWire>(`/api/v1/cards/humans/${seg(handle)}`),
  ]);
  return personShare(person, card?.card?.card ?? null);
}

/** The share image URL for a page, base-path aware (Mini serves under /grove). */
export function shareImagePath(kind: "space" | "agent" | "person", ref: string): string {
  const r = kind === "agent" ? segs(ref) : seg(ref);
  return `${GROVE_BASE}/og/${kind}/${r}`;
}

/** Route params may arrive encoded or not; never throw on a stray `%`. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
