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

/* ------------------------------------------------------------------ *
 * The rest of the art pass.
 *
 * Every table below is the manifest's geometry, transcribed. The manifest
 * is generated from the PNGs (tools/generate_art.py rewrites both), so it
 * cannot drift from the art — but it is a 40 KB JSON the canvas would have
 * to fetch and parse before it could draw a single tile, and the map has to
 * paint immediately. These are the ~20 numbers the renderer actually needs.
 * If an asset is regenerated at a new size, `w`/`h`/`ax`/`ay` here are the
 * one place to change.
 * ------------------------------------------------------------------ */

/** The shape drawAnchored() consumes, plus the footprint that sets draw order. */
export type Anchored = { w: number; h: number; ax: number; ay: number; fw: number; fh: number };

/* ---- civic buildings: one landmark per region -------------------- */

export type CivicRoom = "plaza" | "library" | "workshop" | "stage" | "garden" | "board";

/** All 4x4, all 276 wide; only the height (and so the anchor) differs. */
export const CIVIC: Record<CivicRoom, Anchored> = {
  plaza: { w: 276, h: 284, ax: 138, ay: 146, fw: 4, fh: 4 },
  library: { w: 276, h: 328, ax: 138, ay: 190, fw: 4, fh: 4 },
  workshop: { w: 276, h: 308, ax: 138, ay: 170, fw: 4, fh: 4 },
  stage: { w: 276, h: 313, ax: 138, ay: 175, fw: 4, fh: 4 },
  garden: { w: 276, h: 268, ax: 138, ay: 130, fw: 4, fh: 4 },
  board: { w: 276, h: 298, ax: 138, ay: 160, fw: 4, fh: 4 },
} as const;

export const CIVIC_ROOMS = Object.keys(CIVIC) as CivicRoom[];

export function civicSrc(room: CivicRoom): string {
  return artPath(`/art/civic/${room}.png`);
}

/* ---- scaffolding: work in progress, at three stages -------------- */

export type ScaffoldStage = 1 | 2 | 3;

/** Same footprint and anchor as an access-level building: it becomes one. */
export const SCAFFOLD = { w: 212, h: 234, ax: 106, ay: 128, fw: 3, fh: 3 } as const;

export function scaffoldSrc(stage: ScaffoldStage): string {
  return artPath(`/art/scaffold/stage-${stage}.png`);
}

/* ---- props: the furniture that makes an empty campus inhabited --- */

export type PropKey =
  | "lantern"
  | "bench"
  | "planter"
  | "crates"
  | "signpost"
  | "brazier"
  | "wellstone"
  | "rubble";

/** All 1x1 and 76 wide, so only the height and the anchor's y vary. */
export const PROP: Record<PropKey, Anchored> = {
  lantern: { w: 76, h: 100, ax: 38, ay: 62, fw: 1, fh: 1 },
  bench: { w: 76, h: 74, ax: 38, ay: 36, fw: 1, fh: 1 },
  planter: { w: 76, h: 90, ax: 38, ay: 52, fw: 1, fh: 1 },
  crates: { w: 76, h: 88, ax: 38, ay: 50, fw: 1, fh: 1 },
  signpost: { w: 76, h: 102, ax: 38, ay: 64, fw: 1, fh: 1 },
  brazier: { w: 76, h: 96, ax: 38, ay: 58, fw: 1, fh: 1 },
  wellstone: { w: 76, h: 78, ax: 38, ay: 40, fw: 1, fh: 1 },
  rubble: { w: 76, h: 74, ax: 38, ay: 36, fw: 1, fh: 1 },
};

export const PROP_KEYS = Object.keys(PROP) as PropKey[];

export function propSrc(key: PropKey): string {
  return artPath(`/art/props/${key}.png`);
}

/* ---- paths: a 16-piece N/E/S/W bitmask set ----------------------- */

/**
 * Bit order is the manifest's file-name order: a tile connecting north and
 * west is `path-nw.png`, never `path-wn.png`. n = ty-1 (screen up-right),
 * e = tx+1 (down-right), s = ty+1 (down-left), w = tx-1 (up-left).
 */
export const PATH_N = 1;
export const PATH_E = 2;
export const PATH_S = 4;
export const PATH_W = 8;

/** mask (0..15) -> manifest key. Index 0 is the lone paving slab, "o". */
export const PATH_KEYS: readonly string[] = (() => {
  const out: string[] = [];
  for (let m = 0; m < 16; m++) {
    const name =
      (m & PATH_N ? "n" : "") + (m & PATH_E ? "e" : "") + (m & PATH_S ? "s" : "") + (m & PATH_W ? "w" : "");
    out.push(name || "o");
  }
  return out;
})();

/** Paths are ground: 64x32, anchor [32,0], drawn exactly like a ground tile. */
export function pathSrc(mask: number): string {
  return artPath(`/art/tiles/paths/path-${PATH_KEYS[mask & 15]!}.png`);
}

/* ---- scatter: transparent ground overlays ------------------------ */

export type ScatterKey = "pebbles" | "tuft" | "flowers" | "crack" | "puddle" | "leaves";

export const SCATTER_KEYS: readonly ScatterKey[] = ["pebbles", "tuft", "flowers", "crack", "puddle", "leaves"];

export function scatterSrc(key: ScatterKey): string {
  return artPath(`/art/tiles/scatter/${key}.png`);
}

/* ---- items: what a body is holding ------------------------------- */

export type ItemKey = "document" | "tool" | "lamp" | "seedling";

export const ITEM_KEYS: readonly ItemKey[] = ["document", "tool", "lamp", "seedling"];
/** 24x24, anchor [12,12] — the GRIP point, placed at a hand, never on a tile. */
export const ITEM = { w: 24, h: 24, ax: 12, ay: 12 } as const;

export function itemSrc(key: ItemKey): string {
  return artPath(`/art/items/${key}.png`);
}

/* ---- animals ----------------------------------------------------- */

export type AnimalKey = "sheep-graze" | "sheep-idle" | "sheep-walk-a" | "sheep-walk-b";

export const ANIMAL_KEYS: readonly AnimalKey[] = ["sheep-graze", "sheep-idle", "sheep-walk-a", "sheep-walk-b"];

export function animalSrc(key: AnimalKey): string {
  return artPath(`/art/animals/${key}.png`);
}
