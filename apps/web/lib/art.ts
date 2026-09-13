import { GROVE_BASE, gp } from "./base";

/** Public files live under Next `basePath`. Canvas Image() does not auto-prefix. */
export function artPath(path: string): string {
  return gp(path);
}

export const CHAR_SRC = {
  "human-front": artPath("/art/chars/human-front.png"),
  "human-side": artPath("/art/chars/human-side.png"),
  "human-speak": artPath("/art/chars/human-speak.png"),
  "agent-front": artPath("/art/chars/agent-front.png"),
  "agent-side": artPath("/art/chars/agent-side.png"),
  "agent-work": artPath("/art/chars/agent-work.png"),
} as const;

export type CharKey = keyof typeof CHAR_SRC;

/**
 * Calm 2:1 ground, replacing the legacy 64x64 tiles that were squashed to 64x32.
 * Those carried ~1,500 colours and read as scree at any zoom, swallowing anything
 * drawn on top of them.
 */
export function groundSrc(slug: string): string {
  return artPath(`/art/tiles/ground/${slug}.png`);
}

export type AccessLevel = "private" | "public_view" | "public_write";

/** Every access-level building shares one footprint, so one anchor rule covers all three. */
export const BUILDING = { w: 212, h: 234, ax: 106, ay: 128, fw: 3, fh: 3 } as const;

export function buildingSrc(access: AccessLevel): string {
  return artPath(`/art/buildings/${access}.png`);
}

/**
 * The one draw rule for anchored art: the declared anchor pixel lands exactly on
 * iso(tx,ty) of the sprite's north-most footprint tile. Draw unscaled — these are
 * already 2:1, unlike the legacy tiles.
 */
export function drawAnchored(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number,
  y: number,
  a: { w: number; h: number; ax: number; ay: number },
): void {
  ctx.drawImage(img, x - a.ax, y - a.ay, a.w, a.h);
}

export function tileSrc(slug: string): string {
  return artPath(`/art/tiles/${slug}.png`);
}

export { GROVE_BASE };
