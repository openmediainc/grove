/**
 * Postcard: the map as it is on screen, saved to this device as a PNG with a
 * caption strip underneath.
 *
 * Nothing is posted anywhere. The PNG is composed in the browser from the
 * canvas the viewer is already looking at (canvas.toBlob) and handed to the
 * browser's own download, so a postcard can never show more than the screen
 * did: a private plot's name is not on the canvas, and the caption never adds
 * one — it speaks only of the world, the hour, and the one body the viewer is
 * following or has in the middle of the frame, in civic-region words.
 *
 * The caption text is pure and tested; the canvas composition is thin.
 */
import { VERB_LABEL, type AgentVerb } from "./agent-verbs";
import type { ThemeLexicon, ThemePalette } from "./themes/types";
import { skyAt } from "../components/skyClock";

/** The body a postcard is about, straight off the map's actor. */
export interface PostcardSubject {
  name: string;
  kind: "human" | "agent" | "paperclip";
  /** A map region id; only the six civic regions are named in the caption. */
  region: string;
  verb: AgentVerb;
  detail?: string | null;
  /** True when the viewer is following it; false when it is simply mid-frame. */
  followed: boolean;
}

export interface PostcardInput {
  lex: ThemeLexicon;
  /** The hour the picture shows: now, or the replay playhead. Epoch ms. */
  at: number;
  replay?: boolean;
  subject?: PostcardSubject | null;
  /**
   * Names of private plots the map knows about. The server should never send
   * them, but if a reported detail happens to spell one, the detail is dropped
   * rather than printed.
   */
  privateNames?: readonly string[];
}

export interface PostcardCaption {
  title: string;
  when: string;
  subject: string | null;
}

const MAX_DETAIL = 80;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-09-13 14:05 UTC". The world is one place, so the time is UTC and says so. */
export function postcardClock(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function civicTitle(lex: ThemeLexicon, region: string): string | null {
  return (lex.regions as Record<string, { title: string } | undefined>)[region]?.title ?? null;
}

function cleanDetail(detail: string | null | undefined, verbLabel: string, privateNames: readonly string[]): string | null {
  const d = (detail ?? "").replace(/\s+/g, " ").trim();
  if (!d || d === verbLabel) return null;
  const lower = d.toLowerCase();
  for (const name of privateNames) {
    const n = name.trim().toLowerCase();
    if (n && lower.includes(n)) return null;
  }
  return d.length > MAX_DETAIL ? `${d.slice(0, MAX_DETAIL - 1)}…` : d;
}

export function postcardCaption(input: PostcardInput): PostcardCaption {
  const { lex, at, subject } = input;
  const words = lex.postcard;
  const title = `${words.greeting} ${words.world}`;
  const when = `${input.replay ? `${words.replay} · ` : ""}${postcardClock(at)} · ${skyAt(at).label} ${lex.skyPlace}`;
  if (!subject) return { title, when, subject: null };

  const verbLabel = VERB_LABEL[subject.verb] ?? subject.verb;
  const detail = cleanDetail(subject.detail, verbLabel, input.privateNames ?? []);
  const noun = subject.kind === "human" ? lex.aHuman : lex.anAgent;
  const region = civicTitle(lex, subject.region);
  const lead = subject.followed ? `${lex.controls.following} ${subject.name}` : subject.name;
  const parts = [lead, noun, detail ? `${verbLabel}: ${detail}` : verbLabel];
  if (region) parts.push(region);
  return { title, when, subject: parts.join(" · ") };
}

/** "grove-postcard-20260913-1405Z.png". */
export function postcardFilename(at: number): string {
  const d = new Date(at);
  return `grove-postcard-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z.png`;
}

/** Shorten a line with an ellipsis until `measure` says it fits. */
export function fitLine(text: string, maxW: number, measure: (s: string) => number): string {
  if (measure(text) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid)}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo).trimEnd()}…`;
}

/** The body nearest the middle of the frame, within `maxR` screen px, or null. */
export function nearestToCentre<T extends { x: number; y: number }>(
  points: readonly T[],
  cx: number,
  cy: number,
  maxR: number,
): T | null {
  let best: T | null = null;
  let bestD = maxR * maxR;
  for (const p of points) {
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Draw the canvas and its caption strip onto a new canvas and encode a PNG. */
export function composePostcard(
  source: HTMLCanvasElement,
  caption: PostcardCaption,
  palette: ThemePalette,
): Promise<Blob | null> {
  const scale = source.clientWidth > 0 ? source.width / source.clientWidth : 1;
  const W = source.width;
  const pad = Math.round(16 * scale);
  const titlePx = Math.round(22 * scale);
  const linePx = Math.round(13 * scale);
  const gap = Math.round(6 * scale);
  const lines = caption.subject ? 2 : 1;
  const stripH = pad * 2 + titlePx + (linePx + gap) * lines;

  const out = document.createElement("canvas");
  out.width = W;
  out.height = source.height + stripH;
  const ctx = out.getContext("2d");
  if (!ctx) return Promise.resolve(null);

  const rgb = (t: string, a = 1) => `rgba(${t.split(" ").join(",")},${a})`;
  ctx.fillStyle = rgb(palette.chrome.dusk950);
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  ctx.fillStyle = rgb(palette.chrome.lantern400, 0.35);
  ctx.fillRect(0, source.height, W, Math.max(1, Math.round(scale)));

  const maxW = W - pad * 2;
  let y = source.height + pad;
  ctx.textBaseline = "top";
  ctx.fillStyle = rgb(palette.chrome.lantern300);
  ctx.font = `${titlePx}px ${palette.displayFont}`;
  ctx.fillText(fitLine(caption.title, maxW, (s) => ctx.measureText(s).width), pad, y);
  y += titlePx + gap;
  ctx.font = `${linePx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fillText(fitLine(caption.when, maxW, (s) => ctx.measureText(s).width), pad, y);
  if (caption.subject) {
    y += linePx + gap;
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fillText(fitLine(caption.subject, maxW, (s) => ctx.measureText(s).width), pad, y);
  }
  return new Promise((resolve) => out.toBlob((b) => resolve(b), "image/png"));
}

/** Hand a blob to the browser's own download. Local only. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
