/**
 * Pixel room art (#58): the inside of a room as the room drawer's pixel mode
 * draws it — floor, wall, seat, table and lamp — drawn in code (no image
 * files) and baked once per theme.
 *
 * The SHAPE of each piece is shared, so a seat reads as a seat in every skin;
 * a theme supplies a `RoomStyle` (its materials) and the `material` adds its
 * own finish: planks and lanterns (aoe), deck plates and beacons (space),
 * stone tiles, brick and a street lamp (city), a lit grid and neon pylons
 * (scifi). Every piece is drawn into a 64 x 64 box, front-on, and stamped into
 * whatever box the room grid hands the slot.
 *
 * Rules (THEMES.md): never the hazard colours, never a permission, a count or
 * an org colour. The furniture dresses a room; it never says who may hear it.
 */
import { bake, bakery, type Baked } from "./kit";
import type { Ctx, RoomPiece } from "./types";

export const ROOM_PIECES: readonly RoomPiece[] = ["floor", "wall", "seat", "table", "lamp"];

/** The native size every piece is drawn at, before the stamp scales it. */
export const ROOM_ART_SIZE = 64;

export type RoomStyle = {
  /** timber (aoe), hull (space), civic (city), holo (scifi). */
  material: "timber" | "hull" | "civic" | "holo";
  /** Floor base and its alternate (planks, plates, tiles, grid cells). */
  floor: string;
  floorAlt: string;
  /** Seams, grout, rivets, grid lines. */
  floorLine: string;
  wall: string;
  /** The skirting / trim band along the wall's foot. */
  wallTrim: string;
  /** Beams, bolts, mortar, scanlines. */
  wallDetail: string;
  seat: string;
  seatTop: string;
  table: string;
  tableTop: string;
  /** Lamp body, its light, and the halo round it. */
  lamp: string;
  lampLight: string;
  lampGlow: string;
};

type Drawer = (g: Ctx, s: RoomStyle) => void;

function rect(g: Ctx, x: number, y: number, w: number, h: number, fill: string): void {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
}

function halo(g: Ctx, cx: number, cy: number, r: number, colour: string): void {
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, colour);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
}

const FLOOR: Record<RoomStyle["material"], Drawer> = {
  timber(g, s) {
    // Four courses of planks, seams offset course to course.
    for (let row = 0; row < 4; row++) {
      const y = row * 16;
      rect(g, 0, y, 64, 16, row % 2 ? s.floorAlt : s.floor);
      rect(g, 0, y + 14, 64, 2, s.floorLine);
      const off = row % 2 ? 20 : 40;
      rect(g, off, y, 2, 14, s.floorLine);
      rect(g, (off + 6) % 64, y + 6, 8, 2, s.floorAlt);
    }
  },
  hull(g, s) {
    // Four deck plates with rivets in their corners.
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const x = c * 32;
        const y = r * 32;
        rect(g, x, y, 32, 32, (r + c) % 2 ? s.floorAlt : s.floor);
        rect(g, x, y, 32, 2, s.floorLine);
        rect(g, x, y, 2, 32, s.floorLine);
        for (const [dx, dy] of [
          [6, 6],
          [24, 6],
          [6, 24],
          [24, 24],
        ] as const) {
          rect(g, x + dx, y + dy, 2, 2, s.floorLine);
        }
      }
    }
  },
  civic(g, s) {
    // Checkered stone tiles with grout.
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        rect(g, c * 32, r * 32, 32, 32, (r + c) % 2 ? s.floorAlt : s.floor);
      }
    }
    rect(g, 0, 0, 64, 2, s.floorLine);
    rect(g, 0, 32, 64, 2, s.floorLine);
    rect(g, 0, 0, 2, 64, s.floorLine);
    rect(g, 32, 0, 2, 64, s.floorLine);
  },
  holo(g, s) {
    // A dark deck with a lit grid and a glint where the lines cross.
    rect(g, 0, 0, 64, 64, s.floor);
    for (let i = 0; i < 64; i += 16) {
      rect(g, i, 0, 1, 64, s.floorLine);
      rect(g, 0, i, 64, 1, s.floorLine);
    }
    rect(g, 31, 31, 3, 3, s.floorAlt);
  },
};

const WALL: Record<RoomStyle["material"], Drawer> = {
  timber(g, s) {
    // Upright boards, a beam across, a skirting board at the foot.
    rect(g, 0, 0, 64, 64, s.wall);
    for (let x = 0; x < 64; x += 16) rect(g, x, 0, 2, 52, s.wallDetail);
    rect(g, 0, 18, 64, 6, s.wallDetail);
    rect(g, 0, 52, 64, 12, s.wallTrim);
    rect(g, 0, 52, 64, 2, s.wallDetail);
  },
  hull(g, s) {
    // Bulkhead panels, a lit strip, bolts, a kick plate.
    rect(g, 0, 0, 64, 64, s.wall);
    rect(g, 0, 0, 2, 52, s.wallDetail);
    rect(g, 32, 0, 2, 52, s.wallDetail);
    rect(g, 0, 22, 64, 4, s.lampLight);
    for (const x of [8, 24, 40, 56]) {
      rect(g, x, 6, 2, 2, s.wallDetail);
      rect(g, x, 42, 2, 2, s.wallDetail);
    }
    rect(g, 0, 52, 64, 12, s.wallTrim);
  },
  civic(g, s) {
    // Brick courses, offset every other row, over a stone plinth.
    rect(g, 0, 0, 64, 64, s.wall);
    for (let row = 0; row < 7; row++) {
      const y = row * 8;
      rect(g, 0, y + 6, 64, 2, s.wallDetail);
      const off = row % 2 ? 8 : 0;
      for (let x = off; x < 64; x += 16) rect(g, x, y, 2, 6, s.wallDetail);
    }
    rect(g, 0, 54, 64, 10, s.wallTrim);
  },
  holo(g, s) {
    // A dark panel with faint scanlines and a lit edge at the foot.
    rect(g, 0, 0, 64, 64, s.wall);
    for (let y = 2; y < 52; y += 6) rect(g, 0, y, 64, 1, s.wallDetail);
    rect(g, 0, 52, 64, 12, s.wallTrim);
    rect(g, 0, 52, 64, 2, s.lampLight);
  },
};

const SEAT: Record<RoomStyle["material"], Drawer> = {
  timber(g, s) {
    // A stool: round-ish top, three legs.
    rect(g, 16, 46, 32, 6, s.seatTop);
    rect(g, 18, 52, 4, 10, s.seat);
    rect(g, 30, 52, 4, 10, s.seat);
    rect(g, 42, 52, 4, 10, s.seat);
    rect(g, 16, 50, 32, 2, s.seat);
  },
  hull(g, s) {
    // A seat module: padded top on a pedestal with a base plate.
    rect(g, 14, 44, 36, 8, s.seatTop);
    rect(g, 14, 50, 36, 2, s.seat);
    rect(g, 28, 52, 8, 8, s.seat);
    rect(g, 20, 60, 24, 4, s.seat);
  },
  civic(g, s) {
    // A chair: back slats behind, seat, two legs.
    rect(g, 16, 30, 4, 22, s.seat);
    rect(g, 44, 30, 4, 22, s.seat);
    rect(g, 16, 32, 32, 3, s.seatTop);
    rect(g, 16, 38, 32, 3, s.seatTop);
    rect(g, 14, 46, 36, 6, s.seatTop);
    rect(g, 16, 52, 4, 12, s.seat);
    rect(g, 44, 52, 4, 12, s.seat);
  },
  holo(g, s) {
    // A hover disc: a lit rim over a soft shadow, no legs.
    rect(g, 18, 60, 28, 3, "rgba(0,0,0,0.35)");
    rect(g, 14, 46, 36, 6, s.seat);
    rect(g, 14, 46, 36, 2, s.seatTop);
    rect(g, 20, 54, 24, 1, s.lampLight);
  },
};

const TABLE: Record<RoomStyle["material"], Drawer> = {
  timber(g, s) {
    rect(g, 6, 34, 52, 8, s.tableTop);
    rect(g, 6, 40, 52, 3, s.table);
    rect(g, 10, 43, 5, 21, s.table);
    rect(g, 49, 43, 5, 21, s.table);
    rect(g, 26, 28, 10, 6, s.lampLight); // a candle-lit book on it
  },
  hull(g, s) {
    // A console: a slab with a lit screen, on a solid base.
    rect(g, 8, 32, 48, 10, s.tableTop);
    rect(g, 14, 34, 22, 5, s.lampLight);
    rect(g, 40, 35, 4, 3, s.lampGlow);
    rect(g, 16, 42, 32, 22, s.table);
  },
  civic(g, s) {
    // A café table: round top, one post, a foot.
    rect(g, 10, 34, 44, 6, s.tableTop);
    rect(g, 12, 40, 40, 2, s.table);
    rect(g, 30, 42, 4, 18, s.table);
    rect(g, 20, 60, 24, 4, s.table);
    rect(g, 24, 28, 6, 6, s.lampLight); // a cup
  },
  holo(g, s) {
    // A holo table: a dark slab projecting lines above it.
    rect(g, 8, 38, 48, 6, s.table);
    rect(g, 8, 38, 48, 1, s.tableTop);
    rect(g, 22, 44, 20, 20, s.table);
    g.strokeStyle = s.lampLight;
    g.lineWidth = 1;
    g.strokeRect(20.5, 22.5, 23, 12);
    rect(g, 30, 26, 4, 4, s.tableTop);
  },
};

const LAMP: Record<RoomStyle["material"], Drawer> = {
  timber(g, s) {
    // A lantern hung from a bracket.
    halo(g, 32, 30, 22, s.lampGlow);
    rect(g, 20, 8, 24, 3, s.lamp);
    rect(g, 31, 10, 2, 10, s.lamp);
    rect(g, 24, 20, 16, 4, s.lamp);
    rect(g, 26, 24, 12, 14, s.lampLight);
    rect(g, 31, 24, 2, 14, s.lamp);
    rect(g, 24, 38, 16, 4, s.lamp);
  },
  hull(g, s) {
    // A beacon on a short mast.
    halo(g, 32, 24, 20, s.lampGlow);
    rect(g, 26, 16, 12, 16, s.lampLight);
    rect(g, 26, 16, 12, 3, s.lamp);
    rect(g, 30, 32, 4, 20, s.lamp);
    rect(g, 22, 52, 20, 4, s.lamp);
  },
  civic(g, s) {
    // A street lamp: a post with a curved head.
    halo(g, 40, 22, 20, s.lampGlow);
    rect(g, 22, 10, 4, 50, s.lamp);
    rect(g, 22, 10, 20, 4, s.lamp);
    rect(g, 34, 14, 12, 4, s.lamp);
    rect(g, 36, 18, 8, 6, s.lampLight);
    rect(g, 16, 58, 16, 6, s.lamp);
  },
  holo(g, s) {
    // A neon pylon: a thin bar of light in a frame.
    halo(g, 32, 32, 22, s.lampGlow);
    rect(g, 26, 8, 12, 48, s.lamp);
    rect(g, 30, 12, 4, 40, s.lampLight);
    rect(g, 22, 56, 20, 4, s.lamp);
  },
};

const DRAW: Record<RoomPiece, Record<RoomStyle["material"], Drawer>> = {
  floor: FLOOR,
  wall: WALL,
  seat: SEAT,
  table: TABLE,
  lamp: LAMP,
};

/** Draw one piece straight onto `g` in its 64 x 64 box (no bake). For tests and previews. */
export function drawRoomPiece(g: Ctx, piece: RoomPiece, style: RoomStyle): void {
  DRAW[piece][style.material](g, style);
}

/** One theme's `room` slot: bakes each piece once, stamps it into the box from then on. */
export function makeRoomArt(style: RoomStyle): (ctx: Ctx, piece: RoomPiece, x: number, y: number, w: number, h: number) => void {
  const baked = bakery<RoomPiece>((k): Baked => bake(ROOM_ART_SIZE, ROOM_ART_SIZE, 0, 0, (g) => drawRoomPiece(g, k, style)));
  return (ctx, piece, x, y, w, h) => {
    const b = baked(piece);
    if (b) ctx.drawImage(b.c, x, y, w, h);
  };
}
