/**
 * Artifact board in spaces (queue #36): the rules the server, the MCP tool, the
 * SDKs and the space page all read, so a composer refuses what the API refuses.
 *
 * A board post is an image (PNG, JPEG, WebP or GIF, at most 2 MB), a link shown
 * as a card the server built from the page (never an iframe, never a remote
 * image), or a short text. Captions are at most 280 characters.
 */

// No DOM or Node lib in this package; every runtime it ships to has WHATWG URL (see card.ts).
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  hash: string;
  toString(): string;
};

export const BOARD_POST_KINDS = ["image", "link", "text"] as const;
export type BoardPostKind = (typeof BOARD_POST_KINDS)[number];

export const BOARD_CAPTION_MAX = 280;
export const BOARD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Neither side of an image may be longer than this. */
export const BOARD_IMAGE_MAX_SIDE = 8192;
/** Nor may it hold more pixels than this (a 6000 x 6000 image is 36 MP). */
export const BOARD_IMAGE_MAX_PIXELS = 40_000_000;
export const BOARD_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type BoardImageMime = (typeof BOARD_IMAGE_MIMES)[number];
export const BOARD_LINK_MAX_LENGTH = 2048;
/** How many posts one board read returns at most. */
export const BOARD_PAGE_LIMIT = 60;

export function isBoardPostKind(v: unknown): v is BoardPostKind {
  return typeof v === "string" && (BOARD_POST_KINDS as readonly string[]).includes(v);
}

/** What a link card shows. Every field was read by the server; none of it is HTML. */
export interface BoardLinkPreview {
  /** Hostname of the page actually read (after redirects), for the card's byline. */
  host: string;
  title: string | null;
  description: string | null;
  themeColour: string | null;
  faviconColour: string | null;
}

export interface BoardAuthor {
  id: string;
  kind: "human" | "agent";
  name: string;
  /** Human handle or agent slug. */
  handle: string | null;
}

export interface BoardPostView {
  id: string;
  space: string;
  kind: BoardPostKind;
  caption: string | null;
  author: BoardAuthor;
  createdAt: string;
  link: { url: string; preview: BoardLinkPreview | null } | null;
  image: { url: string; mime: string; width: number; height: number; size: number } | null;
  /** Only ever true in a read by the space's holder or the post's author: everyone else never sees a hidden post. */
  hiddenByMod: boolean;
  /** The reader may delete it (the space's holder). */
  deletable: boolean;
}

export type BoardCheck<T> = { ok: true; value: T } | { ok: false; message: string };

/** Trim a caption; null when empty. Refuses more than BOARD_CAPTION_MAX characters. */
export function readBoardCaption(raw: unknown): BoardCheck<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: "caption must be text." };
  // Control characters other than newline and tab never belong on a card.
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return { ok: true, value: null };
  if ([...s].length > BOARD_CAPTION_MAX) {
    return { ok: false, message: `A caption is at most ${BOARD_CAPTION_MAX} characters.` };
  }
  return { ok: true, value: s };
}

/**
 * A link a post may carry: http or https, no credentials, at most
 * BOARD_LINK_MAX_LENGTH characters. A bare host gets https. Whether the address
 * is PUBLIC is the fetcher's call on the server; this only refuses what can
 * never be a web page (javascript:, data:, file:, mailto:).
 */
export function readBoardLink(raw: unknown): BoardCheck<string> {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, message: "A link post needs a url." };
  const s = raw.trim();
  if (s.length > BOARD_LINK_MAX_LENGTH || /\s/.test(s)) return { ok: false, message: "That is not a web address." };
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+:\d+(\/|$)/.test(s);
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(hasScheme ? s : `https://${s}`);
  } catch {
    return { ok: false, message: "That is not a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Only http and https links can be posted." };
  }
  if (url.username || url.password) return { ok: false, message: "Links with a login in them are not posted." };
  if (!url.hostname) return { ok: false, message: "That is not a web address." };
  url.hash = "";
  return { ok: true, value: url.toString() };
}

/** Bytes of a base64 string without decoding it (padding and whitespace aware). */
export function base64DecodedLength(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

/** Strip an optional `data:image/...;base64,` prefix. */
export function stripDataUrlPrefix(raw: string): string {
  const m = /^data:[a-z0-9.+/-]*;base64,/i.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/** "1.4 MB" / "820 KB": sizes as the composer and the refusals say them. */
export function formatBoardBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
