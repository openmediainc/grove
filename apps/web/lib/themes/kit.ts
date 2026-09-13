/**
 * Shared drawing kit for themes.
 *
 * Two halves:
 *
 *  1. The marks every theme must keep recognisable — the hazard triangle and
 *     the abstract verb glyphs. Themes call these rather than re-implement
 *     them, so a fault is the same shape in every skin.
 *  2. A small procedural pixel-art toolkit for themes that have no PNG set:
 *     isometric prisms, roofs, cylinders and a 20x20 pixel figure, all BAKED
 *     once into an offscreen canvas and stamped from then on. Per-frame cost is
 *     one drawImage per thing, the same as the PNG theme — see
 *     docs/MINIMAP-PERF.md for why the draw loop must not allocate.
 *
 * Geometry is the PNG set's: tile space x runs tile-east, y tile-south, z up in
 * PIXELS, and P(x, y, z) = ((x - y) * 32, (x + y) * 16 - z). The origin of a
 * baked structure is the north vertex of its footprint.
 */

import { VERB_RING, type AgentVerb } from "@/lib/agent-verbs";
import type { BrandEmblem } from "@grove/protocol";
import { HAZARD_COLOUR, type Ctx, type HazardTone, type SignMark, type Signboard, type SpeechBubble } from "./types";

export type { Ctx } from "./types";

/* ------------------------------------------------------------------ *
 * 1. The marks that do not change between themes.
 * ------------------------------------------------------------------ */

/** A pulsing warning triangle, drawn at a fixed size in SCREEN space. */
export function drawHazardTriangle(ctx: Ctx, sx: number, sy: number, tone: HazardTone, t: number): void {
  const pulse = 0.55 + 0.45 * Math.sin(t / 240);
  ctx.save();
  ctx.translate(Math.round(sx), Math.round(sy));
  ctx.globalAlpha = 0.55 + 0.45 * pulse;
  // Dark backing first: these land on bright paving as often as on grass.
  ctx.fillStyle = "rgba(7,8,20,0.88)";
  ctx.beginPath();
  ctx.moveTo(0, -14);
  ctx.lineTo(9, 3);
  ctx.lineTo(-9, 3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = HAZARD_COLOUR[tone];
  ctx.beginPath();
  ctx.moveTo(0, -11);
  ctx.lineTo(6.5, 1.5);
  ctx.lineTo(-6.5, 1.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#0a0a18";
  ctx.fillRect(-1, -7, 2, 5);
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

/** The abstract verb mark beside a body, in the verb's own ring colour. */
export function drawVerbGlyph(ctx: Ctx, verb: AgentVerb, x: number, y: number, t: number): void {
  ctx.save();
  ctx.translate(x + 16, y - 18);
  ctx.fillStyle = VERB_RING[verb];
  ctx.strokeStyle = VERB_RING[verb];
  ctx.lineWidth = 1.5;
  if (verb === "tool") {
    for (let i = 0; i < 4; i++) {
      const a = t / 140 + (i * Math.PI) / 2;
      ctx.fillRect(Math.cos(a) * 7 - 1.5, Math.sin(a) * 7 - 1.5, 3, 3);
    }
  } else if (verb === "think") {
    ctx.beginPath();
    ctx.arc(0, 0, 5 + Math.sin(t / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillRect(-1, -8, 2, 2);
    ctx.fillRect(4, -6, 2, 2);
  } else if (verb === "wait") {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("?", 0, 4);
  } else if (verb === "error") {
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("!", 0, 4);
  } else if (verb === "blocked") {
    ctx.fillRect(-4, -4, 8, 8);
  } else if (verb === "read") {
    ctx.strokeRect(-6, -4, 12, 8);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(0, 4);
    ctx.stroke();
  } else if (verb === "say") {
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 5, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (verb === "offline") {
    // Not in the verb's own ring colour: at 0.45 alpha under a body already
    // down at 0.4 it would be invisible, which is the problem.
    ctx.fillStyle = "rgba(148,163,184,0.8)";
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("z", 0, 4);
  }
  ctx.restore();
}

/**
 * A laid-out speech bubble, SCREEN space. The shape rules every theme keeps:
 * a tail to the head when the bubble sits over it and a leader line when it
 * does not, "+N" on the corner when lines nearby were squeezed out, and a
 * whisper drawn with a dashed edge and italic text so it never reads as
 * something said to the room.
 */
export function drawSpeechBubble(
  ctx: Ctx,
  b: SpeechBubble,
  style: {
    bg: string;
    fg: string;
    border?: string;
    whisperBg: string;
    whisperFg: string;
    whisperBorder: string;
    /** CSS font-family; must match the theme's `speechFont`. */
    font?: string;
    radius?: number;
  },
): void {
  const family = style.font ?? "ui-sans-serif, system-ui, sans-serif";
  const bg = b.whisper ? style.whisperBg : style.bg;
  const border = b.whisper ? style.whisperBorder : style.border;
  const x0 = Math.round(b.x0);
  const y0 = Math.round(b.y0);
  const w = Math.round(b.x1 - b.x0);
  const h = Math.round(b.y1 - b.y0);
  const radius = style.radius ?? 4;
  ctx.save();
  if (b.leader) {
    const lx = Math.min(Math.max(b.ax, b.x0 + 4), b.x1 - 4);
    const ly = b.ay < b.y0 ? b.y0 : b.y1;
    ctx.strokeStyle = border ?? bg;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(b.ax, b.ay);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = border ?? bg;
    ctx.beginPath();
    ctx.arc(b.ax, b.ay, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, radius);
  if (!b.leader) {
    // The tail: a notch from the bottom edge toward the head.
    const tx = Math.min(Math.max(b.ax, x0 + 6), x0 + w - 6);
    ctx.moveTo(tx - 4, y0 + h);
    ctx.lineTo(tx, Math.min(b.ay, y0 + h + 6));
    ctx.lineTo(tx + 4, y0 + h);
  }
  ctx.fill();
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    if (b.whisper) ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, radius);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = b.whisper ? style.whisperFg : style.fg;
  ctx.font = `${b.whisper ? "italic " : ""}${b.fontPx}px ${family}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  b.lines.forEach((line, i) => {
    ctx.fillText(line, x0 + b.padX, y0 + b.padY + b.lineH * (i + 0.5), w - b.padX * 2 + 1);
  });
  if (b.overflow > 0) {
    const label = `+${b.overflow}`;
    ctx.font = `600 9px ${family}`;
    const lw = ctx.measureText(label).width + 6;
    ctx.fillStyle = border ?? style.fg;
    ctx.beginPath();
    ctx.roundRect(x0 + w - lw / 2 - 2, y0 - 6, lw, 11, 5);
    ctx.fill();
    ctx.fillStyle = bg;
    ctx.textAlign = "center";
    ctx.fillText(label, x0 + w - 2, y0 - 0.5);
  }
  ctx.restore();
}

/**
 * The far-zoom speech mark: a 9px speech glyph with a dark backing, drawn in
 * SCREEN space. Deliberately smaller, lower and steadier than the hazard
 * triangle (18px, pulsing) so that from across the world a fault still reads
 * first.
 */
export function drawSpeechPip(
  ctx: Ctx,
  sx: number,
  sy: number,
  whisper: boolean,
  style: { fg: string; whisperFg: string },
): void {
  ctx.save();
  ctx.translate(Math.round(sx), Math.round(sy));
  ctx.fillStyle = "rgba(7,8,20,0.82)";
  ctx.beginPath();
  ctx.roundRect(-6, -5, 12, 9, 3);
  ctx.fill();
  ctx.fillStyle = whisper ? style.whisperFg : style.fg;
  ctx.beginPath();
  ctx.roundRect(-4.5, -3.5, 9, 6, 2);
  ctx.moveTo(-2, 2.5);
  ctx.lineTo(-3.5, 5.5);
  ctx.lineTo(0.5, 2.5);
  ctx.fill();
  ctx.fillStyle = "rgba(7,8,20,0.9)";
  for (const dx of [-2.5, 0, 2.5]) ctx.fillRect(dx - 0.5, -1, 1, 1);
  ctx.restore();
}

/**
 * How a theme dresses a plot signboard. The box and the words come from
 * lib/signboard; a style only says what the board is made of.
 */
export type SignStyle = {
  board: string;
  edge: string;
  title: string;
  detail: string;
  /** A held (private) board is darker and quieter, and carries a padlock. */
  heldBoard: string;
  heldTitle: string;
  lock: { body: string; shackle: string };
  /** CSS font-family; the layout measured with the sans default, so keep widths close. */
  font?: string;
  radius?: number;
  /** Where the org tint goes: a band along the top or bottom, a patch on the left, or a line under the title. */
  tintAt: "top" | "bottom" | "left" | "underline";
  /** Behind the board: ropes, struts, brackets. SCREEN px. */
  fixings?: (ctx: Ctx, x0: number, y0: number, w: number, h: number) => void;
  /** Over the board, under the text: rivets, corner marks. */
  trim?: (ctx: Ctx, x0: number, y0: number, w: number, h: number, held: boolean) => void;
  /**
   * What an achievement-mark medallion is made of. The glyph's SHAPE is not the
   * theme's: a thousand calls is always a four-point star, a week streak always
   * a ring of seven studs (see drawSignMark). Never the hazard colours.
   */
  mark: SignMarkStyle;
};

export type SignMarkStyle = {
  plate: string;
  rim: string;
  glyph: string;
  /** Round coin, square rivet plate, shield, or hexagon chip. */
  shape: "round" | "square" | "shield" | "hex";
};

/**
 * One achievement-mark medallion, SCREEN space. The outline is the theme's; the
 * glyph inside says which mark it is by shape alone, the same in every theme:
 *   thousand_calls  a four-point star (much work, lifetime)
 *   week_streak     seven studs in a ring (seven days running)
 */
export function drawSignMark(ctx: Ctx, m: SignMark, style: SignMarkStyle): void {
  const { x, y, r } = m;
  ctx.save();
  ctx.beginPath();
  if (style.shape === "round") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (style.shape === "square") {
    ctx.rect(x - r + 0.5, y - r + 0.5, r * 2 - 1, r * 2 - 1);
  } else if (style.shape === "shield") {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x + r, y + r * 0.2);
    ctx.lineTo(x, y + r * 1.15);
    ctx.lineTo(x - r, y + r * 0.2);
    ctx.closePath();
  } else {
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.fillStyle = "rgba(7,8,20,0.55)";
  ctx.save();
  ctx.translate(0, 1.5);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = style.plate;
  ctx.fill();
  ctx.strokeStyle = style.rim;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = style.glyph;
  if (m.key === "thousand_calls") {
    const o = r * 0.72;
    const i = r * 0.22;
    ctx.beginPath();
    ctx.moveTo(x, y - o);
    ctx.lineTo(x + i, y - i);
    ctx.lineTo(x + o, y);
    ctx.lineTo(x + i, y + i);
    ctx.lineTo(x, y + o);
    ctx.lineTo(x - i, y + i);
    ctx.lineTo(x - o, y);
    ctx.lineTo(x - i, y - i);
    ctx.closePath();
    ctx.fill();
  } else {
    const ring = r * 0.58;
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + (k * Math.PI * 2) / 7;
      ctx.fillRect(Math.round(x + Math.cos(a) * ring) - 0.5, Math.round(y + Math.sin(a) * ring) - 0.5, 1.5, 1.5);
    }
  }
  ctx.restore();
}

/**
 * A plot signboard, SCREEN space. Shape rules every theme keeps: the text is
 * drawn exactly as laid out, a held board never shows a tint and always shows
 * the padlock, and nothing here uses the hazard colours.
 */
export function drawSignboard(ctx: Ctx, b: Signboard, style: SignStyle): void {
  const family = style.font ?? "ui-sans-serif, system-ui, sans-serif";
  const x0 = Math.round(b.x0);
  const y0 = Math.round(b.y0);
  const w = Math.round(b.x1 - b.x0);
  const h = Math.round(b.y1 - b.y0);
  const radius = style.radius ?? 2;
  ctx.save();
  style.fixings?.(ctx, x0, y0, w, h);
  ctx.fillStyle = "rgba(7,8,20,0.55)";
  ctx.fillRect(x0 + 1, y0 + h, w - 1, 2);
  ctx.fillStyle = b.held ? style.heldBoard : style.board;
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, radius);
  ctx.fill();
  const tint = b.held ? null : b.tint;
  if (tint) {
    ctx.fillStyle = tint;
    if (style.tintAt === "top") ctx.fillRect(x0 + 2, y0 + 1, w - 4, 2);
    else if (style.tintAt === "bottom") ctx.fillRect(x0 + 2, y0 + h - 3, w - 4, 2);
    else if (style.tintAt === "left") ctx.fillRect(x0 + 1, y0 + 2, 3, h - 4);
  }
  // The org, when an owner accent took the stripe: a short second stripe in the
  // corner opposite the primary one, so both read and neither covers the text.
  const second = b.held ? null : b.secondaryTint;
  if (second) {
    ctx.fillStyle = second;
    if (style.tintAt === "top") ctx.fillRect(x0 + w - 12, y0 + h - 3, 9, 2);
    else ctx.fillRect(x0 + w - 12, y0 + 1, 9, 2);
  }
  style.trim?.(ctx, x0, y0, w, h, b.held);
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1, radius);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = b.held ? x0 + w / 2 : b.tx;
  const orgInk = second ?? tint;
  const textW = b.emblem && !b.held ? w - 6 - (b.tx - (x0 + w / 2)) * 2 : w - 6;
  for (const line of b.lines) {
    const title = line.role === "title";
    ctx.font = `${title ? "600 " : line.role === "tagline" ? "italic " : ""}${line.fontPx}px ${family}`;
    ctx.fillStyle = title ? (b.held ? style.heldTitle : style.title) : line.role === "org" && orgInk ? orgInk : style.detail;
    ctx.fillText(line.text, cx, line.y, textW);
    if (title && tint && style.tintAt === "underline") {
      const tw = Math.min(w - 8, ctx.measureText(line.text).width);
      ctx.fillStyle = tint;
      ctx.fillRect(Math.round(cx - tw / 2), Math.round(line.y + line.fontPx / 2 + 1), Math.round(tw), 1);
    }
  }
  if (!b.held && b.emblem) drawBrandEmblem(ctx, b.emblem.key, b.emblem.cx, b.emblem.cy, b.emblem.size, b.emblem.colour ?? style.title);
  if (b.held) lockMark(ctx, x0 + w - 3, y0 + 1, style.lock.body, style.lock.shackle);
  // A held board never carries a mark, whatever the layout was handed.
  else for (const m of b.marks) drawSignMark(ctx, m, style.mark);
  ctx.restore();
}

/**
 * How a theme dresses an estate (#37): its one shared sign and the fence round
 * its outer edge. The words and box come from lib/signboard; the fence segments
 * from lib/estates. A style only says what they are made of.
 */
export type EstateStyle = {
  /** The mount behind the shared board, a few px proud of it on every side. */
  frame: string;
  frameEdge: string;
  /** Ink for the crest above the board when the estate has no accent. */
  crest: string;
  /** roof: a gable; chevron: a banner point; arch: a dome; bracket: a holo brace. */
  crestShape: "roof" | "chevron" | "arch" | "bracket";
  fence: {
    /** Rail colour when the estate has no accent. */
    rail: string;
    /** Posts (or bollards, pylons) along the rail. */
    post: string;
    width: number;
    dash?: readonly number[];
  };
};

/** Mount margin round an estate board, SCREEN px. */
export const ESTATE_FRAME = 3;

/**
 * An estate's shared sign, SCREEN space: a frame a little proud of the theme's
 * own board, the board itself (so it reads as the same family), and a crest on
 * top in the estate's accent. Never held, never the hazard colours.
 */
export function drawEstateSign(ctx: Ctx, b: Signboard, sign: SignStyle, estate: EstateStyle): void {
  const p = ESTATE_FRAME;
  const x0 = Math.round(b.x0) - p;
  const y0 = Math.round(b.y0) - p;
  const w = Math.round(b.x1 - b.x0) + p * 2;
  const h = Math.round(b.y1 - b.y0) + p * 2;
  ctx.save();
  ctx.fillStyle = "rgba(7,8,20,0.55)";
  ctx.fillRect(x0 + 2, y0 + h, w - 2, 2);
  ctx.fillStyle = estate.frame;
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, (sign.radius ?? 2) + 1);
  ctx.fill();
  ctx.strokeStyle = estate.frameEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  drawSignboard(ctx, { ...b, held: false, marks: [], emblem: null }, sign);
  const ink = b.tint ?? estate.crest;
  const cx = Math.round(x0 + w / 2);
  ctx.save();
  ctx.fillStyle = ink;
  ctx.strokeStyle = estate.frameEdge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (estate.crestShape === "roof") {
    ctx.moveTo(cx - 9, y0);
    ctx.lineTo(cx, y0 - 7);
    ctx.lineTo(cx + 9, y0);
    ctx.closePath();
  } else if (estate.crestShape === "chevron") {
    ctx.rect(cx - 7, y0 - 6, 14, 6);
  } else if (estate.crestShape === "arch") {
    ctx.arc(cx, y0, 7, Math.PI, 0);
    ctx.closePath();
  } else {
    ctx.rect(cx - 10, y0 - 3, 20, 2);
    ctx.rect(cx - 10, y0 - 6, 2, 5);
    ctx.rect(cx + 8, y0 - 6, 2, 5);
  }
  ctx.fill();
  if (estate.crestShape !== "bracket") ctx.stroke();
  ctx.restore();
}

/**
 * An estate's fence, LAYOUT space: one rail round the outer edge in the
 * estate's accent (else the theme's rail colour), posts at each tile corner.
 * One path, one stroke.
 */
export function drawEstateFence(
  ctx: Ctx,
  segments: ReadonlyArray<readonly [number, number, number, number]>,
  accent: string | null,
  style: EstateStyle,
): void {
  if (!segments.length) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [ax, ay, bx, by] of segments) {
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.strokeStyle = "rgba(7,8,20,0.45)";
  ctx.lineWidth = style.fence.width + 2;
  ctx.stroke();
  ctx.strokeStyle = accent ?? style.fence.rail;
  ctx.lineWidth = style.fence.width;
  if (style.fence.dash) ctx.setLineDash([...style.fence.dash]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = style.fence.post;
  for (const [ax, ay] of segments) ctx.fillRect(Math.round(ax) - 1.5, Math.round(ay) - 3, 3, 4);
  ctx.restore();
}

/**
 * An owner's emblem (035), SCREEN space, centred on (cx, cy) in a `size` px box.
 * Sixteen original glyphs drawn from paths, the same shape in every theme (like
 * the mark glyphs): a theme's board and the owner's accent change the look,
 * never which emblem it is. One colour, no gradients, nothing in the hazard
 * triangle's shape.
 */
export function drawBrandEmblem(ctx: Ctx, key: BrandEmblem, cx: number, cy: number, size: number, colour: string): void {
  const u = size / 12;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(u, u);
  ctx.fillStyle = colour;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const P = Math.PI;
  ctx.beginPath();
  switch (key) {
    case "leaf":
      ctx.moveTo(-4.5, 4.5);
      ctx.quadraticCurveTo(-5, -4.5, 4.5, -4.5);
      ctx.quadraticCurveTo(4.5, 5, -4.5, 4.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(7,8,20,0.55)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-3.5, 3.5);
      ctx.lineTo(3, -3);
      ctx.stroke();
      break;
    case "star":
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 2.3 : 5.5;
        const a = -P / 2 + (i * P) / 5;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      break;
    case "moon":
      ctx.arc(0, 0, 5, P * 0.3, P * 1.7, false);
      ctx.arc(2.2, -0.6, 3.9, P * 1.45, P * 0.62, true);
      ctx.closePath();
      ctx.fill();
      break;
    case "sun":
      ctx.arc(0, 0, 2.6, 0, P * 2);
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * P) / 4;
        ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
        ctx.lineTo(Math.cos(a) * 5.6, Math.sin(a) * 5.6);
      }
      ctx.stroke();
      break;
    case "wave":
      for (const dy of [-2.2, 2.2]) {
        ctx.moveTo(-5.5, dy);
        ctx.bezierCurveTo(-3.5, dy - 2.5, -1.5, dy + 2.5, 0, dy);
        ctx.bezierCurveTo(1.5, dy - 2.5, 3.5, dy + 2.5, 5.5, dy);
      }
      ctx.stroke();
      break;
    case "peak":
      ctx.moveTo(-5.5, 4.5);
      ctx.lineTo(-1.5, -4.5);
      ctx.lineTo(1, 0);
      ctx.lineTo(2.5, -2);
      ctx.lineTo(5.5, 4.5);
      ctx.closePath();
      ctx.fill();
      break;
    case "key":
      ctx.arc(-2.8, 0, 2.6, 0, P * 2);
      ctx.moveTo(-0.2, 0);
      ctx.lineTo(5.2, 0);
      ctx.moveTo(3.2, 0);
      ctx.lineTo(3.2, 2.4);
      ctx.moveTo(5, 0);
      ctx.lineTo(5, 2);
      ctx.stroke();
      break;
    case "book":
      ctx.moveTo(0, -3.2);
      ctx.lineTo(-5.2, -4.4);
      ctx.lineTo(-5.2, 3.8);
      ctx.lineTo(0, 5);
      ctx.lineTo(5.2, 3.8);
      ctx.lineTo(5.2, -4.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(7,8,20,0.55)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, -3);
      ctx.lineTo(0, 4.6);
      ctx.stroke();
      break;
    case "gear":
      for (let i = 0; i < 16; i++) {
        const r = i % 4 < 2 ? 5.6 : 4.1;
        const a = (i * P) / 8;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.moveTo(1.7, 0);
      ctx.arc(0, 0, 1.7, 0, P * 2, true);
      ctx.fill("evenodd");
      break;
    case "feather":
      ctx.moveTo(-4.8, 5.2);
      ctx.quadraticCurveTo(-3.5, -2, 4.8, -5.2);
      ctx.quadraticCurveTo(3.4, 2.8, -3.2, 3.4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-5.4, 5.8);
      ctx.lineTo(-2.6, 2.6);
      ctx.stroke();
      break;
    case "heart":
      ctx.moveTo(0, 5);
      ctx.bezierCurveTo(-7, 0, -4.5, -6.5, 0, -2.4);
      ctx.bezierCurveTo(4.5, -6.5, 7, 0, 0, 5);
      ctx.fill();
      break;
    case "anchor":
      ctx.arc(0, -4, 1.4, 0, P * 2);
      ctx.moveTo(0, -2.6);
      ctx.lineTo(0, 5);
      ctx.moveTo(-3, -1);
      ctx.lineTo(3, -1);
      ctx.moveTo(-4.8, 1.6);
      ctx.quadraticCurveTo(-4, 5, 0, 5);
      ctx.quadraticCurveTo(4, 5, 4.8, 1.6);
      ctx.stroke();
      break;
    case "diamond":
      ctx.moveTo(0, -5.6);
      ctx.lineTo(4.4, 0);
      ctx.lineTo(0, 5.6);
      ctx.lineTo(-4.4, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(7,8,20,0.5)";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-4.4, 0);
      ctx.lineTo(4.4, 0);
      ctx.stroke();
      break;
    case "compass":
      ctx.arc(0, 0, 5, 0, P * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(1.4, 0);
      ctx.lineTo(0, 4);
      ctx.lineTo(-1.4, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case "flower":
      for (let i = 0; i < 5; i++) {
        const a = -P / 2 + (i * 2 * P) / 5;
        ctx.moveTo(Math.cos(a) * 3.2 + 2.2, Math.sin(a) * 3.2);
        ctx.arc(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 2.2, 0, P * 2);
      }
      ctx.fill();
      ctx.fillStyle = "rgba(7,8,20,0.55)";
      ctx.beginPath();
      ctx.arc(0, 0, 1.3, 0, P * 2);
      ctx.fill();
      break;
    case "tree":
      // Two round tiers of canopy on a trunk: nothing like the hazard triangle.
      ctx.arc(0, -2.6, 3.2, 0, P * 2);
      ctx.moveTo(4.6, 0.8);
      ctx.arc(0, 0.8, 4.6, 0, P);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-0.9, 1.5, 1.8, 4.2);
      break;
  }
  ctx.restore();
}

/** A pennant on a pole to the body's left: the AoE shape, reused by default. */
export function drawPennantFlag(ctx: Ctx, colour: string, x: number, y: number): void {
  ctx.save();
  ctx.translate(x - 22, y - 4);
  ctx.strokeStyle = "rgba(7,8,20,0.75)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -20);
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -20);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.75, -20);
  ctx.lineTo(-11, -16.5);
  ctx.lineTo(-0.75, -13);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.strokeStyle = "rgba(7,8,20,0.75)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * 2. Procedural pixel art.
 * ------------------------------------------------------------------ */

export function P(x: number, y: number, z = 0): [number, number] {
  return [(x - y) * 32, (x + y) * 16 - z];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lighten (k > 0) or darken (k < 0) a hex colour by a fraction. */
export function shade(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** Face colours for a base: top lit, left mid, right in shadow. */
export type Faces = { top: string; left: string; right: string };
export function faces(base: string, light = 0.18, dark = -0.28): Faces {
  return { top: shade(base, light), left: base, right: shade(base, dark) };
}

function poly(g: Ctx, pts: Array<[number, number]>, fill: string, stroke?: string): void {
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = 1.5;
    g.stroke();
  }
}

export const OUTLINE = "rgba(8,8,16,0.55)";

/**
 * A box on the footprint [x, x+w] x [y, y+d], from z to z+h pixels. Only the
 * three faces a camera looking north-west can see are drawn.
 */
export function prism(
  g: Ctx,
  x: number,
  y: number,
  w: number,
  d: number,
  z: number,
  h: number,
  f: Faces,
  stroke: string | undefined = OUTLINE,
): void {
  const zt = z + h;
  // left face: the south side (y = y + d)
  poly(g, [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, zt), P(x, y + d, zt)], f.left, stroke);
  // right face: the east side (x = x + w)
  poly(g, [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, zt), P(x + w, y, zt)], f.right, stroke);
  poly(g, [P(x, y, zt), P(x + w, y, zt), P(x + w, y + d, zt), P(x, y + d, zt)], f.top, stroke);
}

/** A flat diamond on the ground (or at height z). */
export function slab(g: Ctx, x: number, y: number, w: number, d: number, z: number, fill: string, stroke?: string): void {
  poly(g, [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)], fill, stroke);
}

/** A hip roof rising to a ridge/apex. */
export function pyramid(g: Ctx, x: number, y: number, w: number, d: number, z: number, h: number, f: Faces): void {
  const ax = x + w / 2;
  const ay = y + d / 2;
  const apex = P(ax, ay, z + h);
  poly(g, [P(x, y + d, z), P(x + w, y + d, z), apex], f.left, OUTLINE);
  poly(g, [P(x + w, y, z), P(x + w, y + d, z), apex], f.right, OUTLINE);
}

/** A gable roof whose ridge runs along x. */
export function gableX(g: Ctx, x: number, y: number, w: number, d: number, z: number, h: number, f: Faces): void {
  const r0 = P(x, y + d / 2, z + h);
  const r1 = P(x + w, y + d / 2, z + h);
  // south slope
  poly(g, [P(x, y + d, z), P(x + w, y + d, z), r1, r0], f.left, OUTLINE);
  // east gable end
  poly(g, [P(x + w, y, z), P(x + w, y + d, z), r1], f.right, OUTLINE);
  // north slope, partly visible above the ridge
  poly(g, [P(x, y, z), P(x + w, y, z), r1, r0], f.top, OUTLINE);
}

/** A vertical cylinder centred at tile (cx, cy), radius r in tiles. */
export function cylinder(g: Ctx, cx: number, cy: number, r: number, z: number, h: number, f: Faces): void {
  const [sx, sy0] = P(cx, cy, z);
  const sy1 = sy0 - h;
  const rx = r * 32 * Math.SQRT2;
  const ry = r * 16 * Math.SQRT2;
  const grad = g.createLinearGradient(sx - rx, 0, sx + rx, 0);
  grad.addColorStop(0, f.left);
  grad.addColorStop(1, f.right);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(sx, sy0, rx, ry, 0, 0, Math.PI);
  g.lineTo(sx - rx, sy1);
  g.ellipse(sx, sy1, rx, ry, 0, Math.PI, 0, true);
  g.closePath();
  g.fill();
  g.strokeStyle = OUTLINE;
  g.lineWidth = 1;
  g.stroke();
  g.beginPath();
  g.ellipse(sx, sy1, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = f.top;
  g.fill();
  g.stroke();
}

/** A dome (half ellipsoid) on a circle of radius r tiles at height z. */
export function dome(g: Ctx, cx: number, cy: number, r: number, z: number, h: number, f: Faces, alpha = 1): void {
  const [sx, sy] = P(cx, cy, z);
  const rx = r * 32 * Math.SQRT2;
  const ry = r * 16 * Math.SQRT2;
  g.save();
  g.globalAlpha = alpha;
  const grad = g.createRadialGradient(sx - rx * 0.35, sy - h * 0.7, 2, sx, sy - h * 0.3, rx * 1.1);
  grad.addColorStop(0, f.top);
  grad.addColorStop(0.6, f.left);
  grad.addColorStop(1, f.right);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(sx, sy, rx, ry, 0, 0, Math.PI);
  g.bezierCurveTo(sx - rx, sy - h * 1.3, sx + rx, sy - h * 1.3, sx + rx, sy);
  g.closePath();
  g.fill();
  g.restore();
  g.strokeStyle = OUTLINE;
  g.lineWidth = 1;
  g.stroke();
}

/**
 * Quads on a visible wall. `side` "left" is the south face (runs along x),
 * "right" the east face (runs along y). `u` is along the wall in tiles, `v` up
 * in pixels.
 */
export function wallQuad(
  g: Ctx,
  side: "left" | "right",
  x: number,
  y: number,
  w: number,
  d: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  fill: string,
): void {
  const at = (u: number, v: number): [number, number] =>
    side === "left" ? P(x + u, y + d, v) : P(x + w, y + u, v);
  poly(g, [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], fill);
}

/** Evenly spaced windows on both visible walls of a box. */
export function windows(
  g: Ctx,
  x: number,
  y: number,
  w: number,
  d: number,
  z: number,
  h: number,
  rows: number,
  perTile: number,
  fill: string | ((i: number) => string),
): void {
  let i = 0;
  const band = h / rows;
  for (const side of ["left", "right"] as const) {
    const len = side === "left" ? w : d;
    const n = Math.max(1, Math.round(len * perTile));
    const step = len / n;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < n; c++) {
        const f = typeof fill === "function" ? fill(i++) : fill;
        wallQuad(g, side, x, y, w, d, c * step + step * 0.25, c * step + step * 0.75, z + r * band + band * 0.3, z + r * band + band * 0.75, f);
      }
    }
  }
}

/** A thin vertical pole at tile (x, y) from z to z + h. */
export function pole(g: Ctx, x: number, y: number, z: number, h: number, colour: string, width = 2): void {
  const [sx, sy] = P(x, y, z);
  g.fillStyle = colour;
  g.fillRect(Math.round(sx - width / 2), Math.round(sy - h), width, h);
}

/** A soft glow dot. */
export function glow(g: Ctx, sx: number, sy: number, r: number, colour: string): void {
  const grad = g.createRadialGradient(sx, sy, 0, sx, sy, r);
  grad.addColorStop(0, colour);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(sx - r, sy - r, r * 2, r * 2);
}

/** Ground shadow under a footprint. */
export function shadow(g: Ctx, x: number, y: number, w: number, d: number): void {
  slab(g, x - 0.05, y + 0.1, w + 0.15, d + 0.1, 0, "rgba(0,0,0,0.28)");
}

/* ---- baking ---------------------------------------------------------- */

export type Baked = { c: HTMLCanvasElement; w: number; h: number; ax: number; ay: number };

/**
 * Render once into an offscreen canvas at `res` resolution; the stamp scales it
 * back up with smoothing off, which is what makes a procedural building read
 * as pixel art rather than as a vector diagram.
 */
export function bake(w: number, h: number, ax: number, ay: number, fn: (g: Ctx) => void, res = 0.5): Baked {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * res));
  c.height = Math.max(1, Math.ceil(h * res));
  const g = c.getContext("2d");
  if (g) {
    g.scale(res, res);
    g.translate(ax, ay);
    fn(g);
  }
  return { c, w, h, ax, ay };
}

export function stamp(ctx: Ctx, b: Baked, px: number, py: number): void {
  ctx.drawImage(b.c, px - b.ax, py - b.ay, b.w, b.h);
}

/** Lazy, keyed cache of baked sprites. Never bakes on the server. */
export function bakery<K extends string | number>(make: (key: K) => Baked): (key: K) => Baked | null {
  const cache = new Map<K, Baked>();
  return (key: K) => {
    if (typeof document === "undefined") return null;
    let b = cache.get(key);
    if (!b) {
      b = make(key);
      cache.set(key, b);
    }
    return b;
  };
}

/** Standard canvases for the fixed footprints. Room above for tall art. */
export function bakeAnchored(fw: number, fh: number, tall: number, fn: (g: Ctx) => void, res = 0.5): Baked {
  const w = (fw + fh) * 32 + 8;
  const ax = fh * 32 + 4;
  const ay = tall;
  const h = tall + (fw + fh) * 16 + 8;
  return bake(w, h, ax, ay, fn, res);
}

/** A 64x32 ground tile canvas; (0,0) of `fn` is the north vertex. */
export function bakeTile(fn: (g: Ctx) => void): Baked {
  return bake(64, 32, 32, 0, (g) => {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(32, 16);
    g.lineTo(0, 32);
    g.lineTo(-32, 16);
    g.closePath();
    g.clip();
    fn(g);
  }, 1);
}

/** Deterministic tiny PRNG so a baked tile has the same speckle every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** Speckle a tile with pixels. */
export function speckle(g: Ctx, seed: number, n: number, colours: readonly string[], size = 2): void {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colours[Math.floor(r() * colours.length)]!;
    g.fillRect(Math.round(r() * 64 - 32), Math.round(r() * 32), size, size);
  }
}

/** A paved band from the tile centre toward each connected edge midpoint. */
export function bakePath(mask: number, fill: string, edge: string, width = 0.42, detail?: (g: Ctx) => void): Baked {
  return bakeTile((g) => {
    const half = width / 2;
    // Tile-space rects, projected. The tile spans [0,1] x [0,1].
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      poly(g, [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], fill);
    };
    const lo = 0.5 - half;
    const hi = 0.5 + half;
    rect(lo, lo, hi, hi);
    if (mask & 1) rect(lo, 0, hi, hi); // n: ty-1 → y toward 0
    if (mask & 2) rect(lo, lo, 1, hi); // e: tx+1 → x toward 1
    if (mask & 4) rect(lo, lo, hi, 1); // s
    if (mask & 8) rect(0, lo, hi, hi); // w
    g.strokeStyle = edge;
    g.lineWidth = 1;
    const line = (a: [number, number], b: [number, number]) => {
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.stroke();
    };
    // Kerbs on the sides that do not continue.
    if (!(mask & 1)) line(P(lo, lo), P(hi, lo));
    if (!(mask & 4)) line(P(lo, hi), P(hi, hi));
    if (!(mask & 8)) line(P(lo, lo), P(lo, hi));
    if (!(mask & 2)) line(P(hi, lo), P(hi, hi));
    detail?.(g);
  });
}

/* ---- figures --------------------------------------------------------- */

/**
 * A 20x20 pixel figure, drawn at 2x into the 40x40 body box. Parametric, so
 * one function draws an astronaut, a citizen, a robot or a courier; the pose
 * comes from the semantic sprite key.
 */
export type FigureSpec = {
  skin: string;
  head: "round" | "box" | "helmet" | "dome" | "cap";
  headColour: string;
  visor?: string;
  torso: string;
  legs: string;
  accent: string;
  antenna?: string;
  /** Glowing eye(s) instead of a face. */
  eyes?: string;
  shoulders?: string;
  outline?: string;
};

export type Stance = "front" | "side" | "work" | "speak";

export function stanceOf(sprite: string): Stance {
  if (sprite.endsWith("-side")) return "side";
  if (sprite.endsWith("-work")) return "work";
  if (sprite.endsWith("-speak")) return "speak";
  return "front";
}

export function bakeFigure(spec: FigureSpec, stance: Stance): Baked {
  return bake(40, 40, 20, 20, (g) => {
    g.translate(-20, -20);
    g.scale(2, 2);
    const px = (x: number, y: number, w: number, h: number, c: string) => {
      g.fillStyle = c;
      g.fillRect(x, y, w, h);
    };
    const O = spec.outline ?? "rgba(10,10,20,0.85)";
    const side = stance === "side";
    // shadow
    px(6, 18, 8, 1, "rgba(0,0,0,0.3)");
    // legs
    px(side ? 8 : 7, 14, 2, 4, spec.legs);
    px(side ? 10 : 11, 14, 2, 4, shade(spec.legs.startsWith("#") ? spec.legs : "#333333", -0.2));
    // torso outline + body
    px(6, 8, 8, 7, O);
    px(7, 8, 6, 6, spec.torso);
    px(7, 12, 6, 1, spec.accent);
    if (spec.shoulders) {
      px(6, 8, 2, 2, spec.shoulders);
      px(12, 8, 2, 2, spec.shoulders);
    }
    // arms
    if (stance === "work") {
      px(13, 5, 2, 5, spec.torso);
      px(13, 4, 2, 1, spec.skin);
      px(5, 9, 2, 4, spec.torso);
    } else if (stance === "speak") {
      px(14, 8, 3, 2, spec.torso);
      px(17, 8, 1, 2, spec.skin);
      px(5, 9, 2, 4, spec.torso);
    } else if (side) {
      px(9, 9, 2, 5, shade(spec.torso.startsWith("#") ? spec.torso : "#555555", -0.2));
    } else {
      px(5, 9, 2, 4, spec.torso);
      px(13, 9, 2, 4, spec.torso);
      px(5, 13, 2, 1, spec.skin);
      px(13, 13, 2, 1, spec.skin);
    }
    // head
    const hx = side ? 7 : 6;
    if (spec.head === "box") {
      px(hx, 1, 8, 7, O);
      px(hx + 1, 2, 6, 5, spec.headColour);
      if (spec.eyes) {
        if (side) px(hx + 5, 4, 2, 1, spec.eyes);
        else {
          px(hx + 2, 4, 1, 1, spec.eyes);
          px(hx + 5, 4, 1, 1, spec.eyes);
        }
      }
    } else if (spec.head === "dome") {
      px(hx + 1, 1, 6, 1, O);
      px(hx, 2, 8, 6, O);
      px(hx + 1, 2, 6, 5, spec.headColour);
      if (spec.eyes) px(side ? hx + 4 : hx + 2, 4, side ? 3 : 4, 1, spec.eyes);
    } else if (spec.head === "helmet") {
      px(hx, 0, 8, 8, O);
      px(hx + 1, 1, 6, 6, spec.headColour);
      px(side ? hx + 3 : hx + 2, 2, side ? 4 : 4, 3, spec.visor ?? "#7dd3fc");
      px(side ? hx + 4 : hx + 2, 2, 1, 1, "rgba(255,255,255,0.8)");
    } else {
      // round / cap: a face
      px(hx + 1, 1, 6, 7, O);
      px(hx, 2, 8, 5, O);
      px(hx + 1, 2, 6, 5, spec.skin);
      px(hx + 1, 1, 6, 2, spec.headColour);
      if (spec.head === "cap") px(side ? hx + 5 : hx, 2, side ? 3 : 8, 1, spec.headColour);
      if (side) px(hx + 5, 4, 1, 1, O);
      else {
        px(hx + 2, 4, 1, 1, O);
        px(hx + 5, 4, 1, 1, O);
      }
      if (stance === "speak") px(side ? hx + 5 : hx + 3, 6, 2, 1, O);
    }
    if (spec.antenna) {
      px(hx + 3, -2 + 2, 1, 1, spec.antenna);
      px(hx + 3, 0, 1, 1, spec.antenna);
    }
  }, 1);
}

/* ---- small pixel sprites ------------------------------------------------ */

export type Px = (x: number, y: number, w: number, h: number, c: string) => void;

/**
 * A pixel grid of cols x rows drawn at `scale`, anchored so that (ax, ay) in
 * OUTPUT pixels is the sprite's origin. Items are 12x12 at 2x anchored at the
 * grip (12, 12); critters are 20x20 at 2x anchored at the centre (20, 20).
 */
export function bakeGrid(cols: number, rows: number, scale: number, ax: number, ay: number, fn: (px: Px) => void): Baked {
  return bake(cols * scale, rows * scale, ax, ay, (g) => {
    g.translate(-ax, -ay);
    g.scale(scale, scale);
    fn((x, y, w, h, c) => {
      g.fillStyle = c;
      g.fillRect(x, y, w, h);
    });
  }, 1);
}

/** Fill a whole ground tile (the caller's clip keeps it a diamond). */
export function tileFill(g: Ctx, colour: string): void {
  g.fillStyle = colour;
  g.fillRect(-32, 0, 64, 32);
}

/** A line in tile-local coordinates, (0,0)..(1,1) spanning the tile. */
export function tileLine(g: Ctx, x0: number, y0: number, x1: number, y1: number, colour: string, width = 1): void {
  const a = P(x0, y0);
  const b = P(x1, y1);
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
}

/** A filled diamond in tile-local coordinates. */
export function tileRect(g: Ctx, x0: number, y0: number, x1: number, y1: number, colour: string): void {
  poly(g, [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], colour);
}

/** An iso ellipse lying on the ground plane (a pool, a ring, a pad). */
export function groundEllipse(g: Ctx, cx: number, cy: number, r: number, z: number, fill: string | null, stroke?: string, width = 1): void {
  const [sx, sy] = P(cx, cy, z);
  g.beginPath();
  g.ellipse(sx, sy, r * 32 * Math.SQRT2, r * 16 * Math.SQRT2, 0, 0, Math.PI * 2);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.stroke();
  }
}

/** A line segment in tile space with height. */
export function seg(g: Ctx, a: [number, number, number], b: [number, number, number], colour: string, width = 1): void {
  const p = P(a[0], a[1], a[2]);
  const q = P(b[0], b[1], b[2]);
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(p[0], p[1]);
  g.lineTo(q[0], q[1]);
  g.stroke();
}

/** The 12 edges of a box, as a wireframe. */
export function wireBox(g: Ctx, x: number, y: number, w: number, d: number, z: number, h: number, colour: string, width = 1): void {
  const c = (i: number, j: number, k: number): [number, number, number] => [x + i * w, y + j * d, z + k * h];
  const edges: Array<[[number, number, number], [number, number, number]]> = [
    [c(0, 0, 0), c(1, 0, 0)], [c(1, 0, 0), c(1, 1, 0)], [c(1, 1, 0), c(0, 1, 0)], [c(0, 1, 0), c(0, 0, 0)],
    [c(0, 0, 1), c(1, 0, 1)], [c(1, 0, 1), c(1, 1, 1)], [c(1, 1, 1), c(0, 1, 1)], [c(0, 1, 1), c(0, 0, 1)],
    [c(0, 0, 0), c(0, 0, 1)], [c(1, 0, 0), c(1, 0, 1)], [c(1, 1, 0), c(1, 1, 1)], [c(0, 1, 0), c(0, 1, 1)],
  ];
  for (const [a, b] of edges) seg(g, a, b, colour, width);
}

/** A doorway on a wall. `open` leaves it dark; closed draws a shut leaf with a bar. */
export function door(
  g: Ctx,
  side: "left" | "right",
  x: number,
  y: number,
  w: number,
  d: number,
  z: number,
  at: number,
  width: number,
  height: number,
  state: "open" | "shut" | "sealed",
  colours: { frame: string; leaf: string; dark: string; bar: string },
): void {
  const u0 = at - width / 2;
  const u1 = at + width / 2;
  wallQuad(g, side, x, y, w, d, u0 - 0.04, u1 + 0.04, z, z + height + 3, colours.frame);
  if (state === "open") {
    wallQuad(g, side, x, y, w, d, u0, u1, z, z + height, colours.dark);
    return;
  }
  wallQuad(g, side, x, y, w, d, u0, u1, z, z + height, colours.leaf);
  // A horizontal bar across a shut door; two crossed bars across a sealed one.
  wallQuad(g, side, x, y, w, d, u0, u1, z + height * 0.45, z + height * 0.58, colours.bar);
  if (state === "sealed") {
    wallQuad(g, side, x, y, w, d, (u0 + u1) / 2 - 0.03, (u0 + u1) / 2 + 0.03, z, z + height, colours.bar);
  }
}

/** A padlock mark, in screen pixels around (sx, sy). The universal "closed". */
export function lockMark(g: Ctx, sx: number, sy: number, body: string, shackle: string): void {
  g.strokeStyle = shackle;
  g.lineWidth = 2;
  g.beginPath();
  g.arc(sx, sy - 4, 4, Math.PI, 0);
  g.stroke();
  g.fillStyle = body;
  g.fillRect(sx - 6, sy - 4, 12, 9);
  g.fillStyle = shackle;
  g.fillRect(sx - 1, sy - 1, 2, 3);
}
