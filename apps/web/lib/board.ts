/**
 * The artifact board on a space's About tab (queue #36). Pure, so the composer's
 * checks and the card's safe colours are testable. The API re-checks every rule
 * (the bytes are sniffed there, not here); checking here only saves an upload.
 */
import {
  BOARD_CAPTION_MAX,
  BOARD_IMAGE_MAX_BYTES,
  BOARD_IMAGE_MIMES,
  formatBoardBytes,
  readBoardLink,
  type BoardPostKind,
} from "@grove/protocol";

export type WireBoardPost = {
  id: string;
  space: string;
  kind: BoardPostKind;
  caption: string | null;
  author: { id: string; kind: "human" | "agent"; name: string; handle: string | null };
  created_at: string;
  link: {
    url: string;
    preview: { host: string; title: string | null; description: string | null; theme_colour: string | null; favicon_colour: string | null } | null;
  } | null;
  image: { url: string; mime: string; width: number; height: number; size: number } | null;
  hidden_by_mod: boolean;
  deletable: boolean;
};

export type WirePreview = NonNullable<WireBoardPost["link"]>["preview"];

export type WireBoard = { posts: WireBoardPost[]; can_post: boolean; space: { id: string; slug: string } };

export const REPORT_CHOICES = [
  ["spam", "Spam"],
  ["harassment", "Harassment"],
  ["impersonation", "Impersonation"],
  ["illegal", "Illegal content"],
  ["other", "Something else"],
] as const;

/** Why a picked file cannot be posted, or null when it may be sent. */
export function imageFileProblem(file: { size: number; type: string }): string | null {
  if (!(BOARD_IMAGE_MIMES as readonly string[]).includes(file.type)) return "Pick a PNG, JPEG, WebP or GIF image.";
  if (file.size > BOARD_IMAGE_MAX_BYTES) {
    return `Images are at most ${formatBoardBytes(BOARD_IMAGE_MAX_BYTES)}; that one is ${formatBoardBytes(file.size)}.`;
  }
  return null;
}

/** Characters left in a caption (code points, as the server counts). */
export function captionLeft(caption: string): number {
  return BOARD_CAPTION_MAX - [...caption.trim()].length;
}

export type Draft = { kind: BoardPostKind; caption: string; url: string; hasImage: boolean };

/** Whether Post may be pressed, and if not, why (null = go). */
export function draftProblem(d: Draft): string | null {
  if (captionLeft(d.caption) < 0) return `Captions are at most ${BOARD_CAPTION_MAX} characters.`;
  if (d.kind === "text" && !d.caption.trim()) return "Write something to post.";
  if (d.kind === "link") {
    const link = readBoardLink(d.url);
    if (!link.ok) return link.message;
  }
  if (d.kind === "image" && !d.hasImage) return "Pick an image.";
  return null;
}

/** The request body for a draft. `imageBase64` is the file's bytes, already read. */
export function draftBody(d: Draft, imageBase64: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { kind: d.kind };
  if (d.caption.trim()) body.caption = d.caption.trim();
  if (d.kind === "link") body.url = d.url.trim();
  if (d.kind === "image" && imageBase64) body.image_base64 = imageBase64;
  return body;
}

/**
 * The colour a link card is edged with: the page's theme colour, else its
 * favicon colour, else none. Only a strict #rrggbb ever reaches a style
 * attribute, whatever the stored preview holds.
 */
export function cardAccent(preview: WirePreview | null | undefined): string | null {
  for (const c of [preview?.theme_colour, preview?.favicon_colour]) {
    if (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  }
  return null;
}

/** The href a link card opens: only http(s), else nothing clickable. */
export function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" / a date. */
export function postedAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Where an author's name links: a person's page or an agent's page. */
export function authorHref(author: WireBoardPost["author"]): string | null {
  if (!author.handle) return null;
  return author.kind === "agent" ? `/a/${encodeURIComponent(author.handle)}` : `/u/${encodeURIComponent(author.handle)}`;
}

/** Read a File as bare base64 (no data: prefix). Browser only. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}
