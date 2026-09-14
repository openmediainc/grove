/**
 * Plot decor art (#45): the eleven small props an owner can place round their
 * plot's building, drawn in code (no image files) and baked once per theme.
 *
 * The SHAPE of each preset is shared, so a desk reads as a desk in every skin;
 * a theme supplies a `DecorStyle` (its materials) and a `material` that adds
 * its own finish: timber pegs and cloth (aoe), hull plates and status lights
 * (space), painted civic metal (city), holo edges (scifi). Anchored 1x1: the
 * origin of every drawer is the north vertex of the slot tile, like `prop()`.
 *
 * Rules (THEMES.md): never the hazard colours, never taller than a body's
 * reach above the tile, and never a permission, a count or an org colour.
 */
import type { DecorPreset } from "@grove/protocol";
import {
  P,
  bakeAnchored,
  bakery,
  cylinder,
  faces,
  glow,
  groundEllipse,
  pole,
  prism,
  seg,
  shadow,
  slab,
  stamp,
  wallQuad,
  wireBox,
  type Ctx,
} from "./kit";

export type DecorStyle = {
  /** timber (aoe), hull (space), civic (city), holo (scifi). */
  material: "timber" | "hull" | "civic" | "holo";
  /** Main structure: planks, panels, painted steel. */
  wood: string;
  /** Poles, frames, fittings. */
  metal: string;
  /** Basins, planter boxes, plinths. */
  stone: string;
  leaf: string;
  bloom: string;
  water: string;
  /** Lamp light and the glow behind it. */
  light: string;
  lightGlow: string;
  /** Banner cloth and its trim. */
  cloth: string;
  trim: string;
  /** Paper, book spines, a screen: small bright details. */
  paper: string;
  /** Book spines, alternating with `paper`. */
  spine: string;
};

type Drawer = (g: Ctx, s: DecorStyle) => void;

/** holo: a thin lit outline round a box, the scifi finish. */
function edge(g: Ctx, s: DecorStyle, x: number, y: number, w: number, d: number, z: number, h: number): void {
  if (s.material === "holo") wireBox(g, x, y, w, d, z, h, s.light, 1);
}

const DRAW: Record<DecorPreset, Drawer> = {
  bench(g, s) {
    shadow(g, 0.2, 0.35, 0.6, 0.3);
    prism(g, 0.22, 0.38, 0.06, 0.24, 0, 7, faces(s.metal));
    prism(g, 0.72, 0.38, 0.06, 0.24, 0, 7, faces(s.metal));
    prism(g, 0.18, 0.35, 0.64, 0.3, 7, 3, faces(s.wood));
    prism(g, 0.18, 0.33, 0.64, 0.06, 10, 10, faces(s.wood));
    edge(g, s, 0.18, 0.35, 0.64, 0.3, 7, 3);
  },
  planter(g, s) {
    shadow(g, 0.25, 0.25, 0.5, 0.5);
    if (s.material === "timber" || s.material === "civic") prism(g, 0.25, 0.25, 0.5, 0.5, 0, 12, faces(s.stone));
    else cylinder(g, 0.5, 0.5, 0.24, 0, 12, faces(s.stone));
    groundEllipse(g, 0.5, 0.5, 0.2, 12, s.leaf);
    const [x, y] = P(0.5, 0.5, 12);
    g.fillStyle = s.leaf;
    g.beginPath();
    g.ellipse(x, y - 8, 9, 8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = s.bloom;
    g.fillRect(x - 5, y - 12, 3, 3);
    g.fillRect(x + 3, y - 8, 3, 3);
    edge(g, s, 0.25, 0.25, 0.5, 0.5, 0, 12);
  },
  lamps(g, s) {
    for (const [tx, ty] of [
      [0.22, 0.62],
      [0.62, 0.22],
    ] as const) {
      prism(g, tx - 0.06, ty - 0.06, 0.12, 0.12, 0, 4, faces(s.stone));
      pole(g, tx, ty, 4, 34, s.metal, 2);
      const [x, y] = P(tx, ty, 40);
      glow(g, x, y, 9, s.lightGlow);
      g.fillStyle = s.material === "timber" ? s.metal : s.light;
      g.fillRect(x - 3, y - 4, 6, 7);
      g.fillStyle = s.light;
      g.fillRect(x - 2, y - 3, 4, 5);
    }
  },
  desk(g, s) {
    shadow(g, 0.2, 0.3, 0.6, 0.4);
    for (const [lx, ly] of [
      [0.22, 0.32],
      [0.74, 0.32],
      [0.22, 0.64],
      [0.74, 0.64],
    ] as const) {
      prism(g, lx, ly, 0.04, 0.04, 0, 11, faces(s.metal), undefined);
    }
    prism(g, 0.2, 0.3, 0.6, 0.4, 11, 3, faces(s.wood));
    edge(g, s, 0.2, 0.3, 0.6, 0.4, 11, 3);
    // Something being worked on: papers, a datapad, a laptop, a holo screen.
    slab(g, 0.3, 0.38, 0.2, 0.16, 14, s.paper);
    if (s.material === "timber") {
      slab(g, 0.55, 0.45, 0.12, 0.1, 14, s.spine);
    } else {
      prism(g, 0.55, 0.36, 0.18, 0.03, 14, 9, faces(s.material === "holo" ? s.light : s.metal));
      wallQuad(g, "left", 0.55, 0.36, 0.18, 0.03, 0.02, 0.16, 16, 22, s.paper);
    }
  },
  bookshelf(g, s) {
    shadow(g, 0.25, 0.4, 0.5, 0.25);
    prism(g, 0.25, 0.4, 0.5, 0.25, 0, 34, faces(s.wood));
    // Rows of spines on the south face.
    for (let r = 0; r < 3; r++) {
      const v0 = 4 + r * 10;
      for (let i = 0; i < 6; i++) {
        const u0 = 0.04 + i * 0.07;
        wallQuad(g, "left", 0.25, 0.4, 0.5, 0.25, u0, u0 + 0.05, v0, v0 + 7 - ((i + r) % 3), (i + r) % 2 ? s.spine : s.paper);
      }
    }
    edge(g, s, 0.25, 0.4, 0.5, 0.25, 0, 34);
  },
  notice_board(g, s) {
    shadow(g, 0.25, 0.45, 0.5, 0.1);
    pole(g, 0.28, 0.5, 0, 30, s.metal, 2);
    pole(g, 0.72, 0.5, 0, 30, s.metal, 2);
    prism(g, 0.24, 0.47, 0.52, 0.04, 12, 20, faces(s.wood));
    wallQuad(g, "left", 0.24, 0.47, 0.52, 0.04, 0.05, 0.2, 16, 27, s.paper);
    wallQuad(g, "left", 0.24, 0.47, 0.52, 0.04, 0.26, 0.46, 20, 29, s.paper);
    wallQuad(g, "left", 0.24, 0.47, 0.52, 0.04, 0.24, 0.36, 14, 18, s.bloom);
    if (s.material === "timber") prism(g, 0.2, 0.45, 0.6, 0.08, 32, 3, faces(s.wood));
    edge(g, s, 0.24, 0.47, 0.52, 0.04, 12, 20);
  },
  crates(g, s) {
    shadow(g, 0.15, 0.2, 0.7, 0.65);
    prism(g, 0.15, 0.2, 0.4, 0.4, 0, 16, faces(s.wood));
    prism(g, 0.5, 0.5, 0.35, 0.35, 0, 12, faces(s.wood));
    prism(g, 0.2, 0.25, 0.3, 0.3, 16, 11, faces(s.stone));
    wallQuad(g, "left", 0.15, 0.2, 0.4, 0.4, 0.05, 0.35, 7, 9, s.metal);
    wallQuad(g, "left", 0.5, 0.5, 0.35, 0.35, 0.05, 0.3, 5, 7, s.metal);
    edge(g, s, 0.15, 0.2, 0.4, 0.4, 0, 16);
  },
  banner(g, s) {
    prism(g, 0.44, 0.44, 0.12, 0.12, 0, 4, faces(s.stone));
    pole(g, 0.5, 0.5, 4, 50, s.metal, 2);
    const [x, y] = P(0.5, 0.5, 52);
    g.fillStyle = s.trim;
    g.fillRect(x - 1, y - 2, 16, 2);
    g.fillStyle = s.cloth;
    g.beginPath();
    g.moveTo(x + 1, y);
    g.lineTo(x + 15, y);
    g.lineTo(x + 15, y + 22);
    g.lineTo(x + 8, y + 17);
    g.lineTo(x + 1, y + 22);
    g.closePath();
    g.fill();
    g.fillStyle = s.trim;
    g.fillRect(x + 5, y + 6, 6, 6);
    if (s.material === "holo") glow(g, x + 8, y + 9, 12, s.lightGlow);
  },
  telescope(g, s) {
    shadow(g, 0.3, 0.3, 0.4, 0.4);
    // Tripod.
    seg(g, [0.5, 0.5, 18], [0.3, 0.4, 0], s.metal, 2);
    seg(g, [0.5, 0.5, 18], [0.66, 0.34, 0], s.metal, 2);
    seg(g, [0.5, 0.5, 18], [0.58, 0.7, 0], s.metal, 2);
    // Tube, pointed at the sky to the north-east.
    const [ax, ay] = P(0.5, 0.5, 18);
    g.save();
    g.translate(ax, ay);
    g.rotate(-0.55);
    g.fillStyle = s.wood;
    g.fillRect(-8, -3.5, 26, 7);
    g.fillStyle = s.trim;
    g.fillRect(14, -4.5, 5, 9);
    g.fillRect(-9, -2.5, 3, 5);
    g.restore();
    if (s.material === "holo") glow(g, ax + 16, ay - 10, 6, s.lightGlow);
  },
  fountain(g, s) {
    shadow(g, 0.12, 0.12, 0.76, 0.76);
    cylinder(g, 0.5, 0.5, 0.34, 0, 8, faces(s.stone));
    groundEllipse(g, 0.5, 0.5, 0.28, 8, s.water);
    cylinder(g, 0.5, 0.5, 0.06, 8, 14, faces(s.stone));
    const [x, y] = P(0.5, 0.5, 24);
    g.fillStyle = s.water;
    g.beginPath();
    g.ellipse(x, y - 2, 4, 6, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = s.paper;
    for (const [dx, dy] of [
      [-9, 8],
      [8, 9],
      [-4, 13],
      [5, 4],
    ] as const) {
      g.fillRect(x + dx, y + dy, 2, 2);
    }
    if (s.material === "holo" || s.material === "hull") groundEllipse(g, 0.5, 0.5, 0.28, 8, null, s.light, 1);
  },
  garden(g, s) {
    slab(g, 0.08, 0.08, 0.84, 0.84, 0, s.stone);
    slab(g, 0.14, 0.14, 0.72, 0.72, 1, "rgba(60,40,24,0.85)");
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const [x, y] = P(0.26 + c * 0.24, 0.26 + r * 0.24, 1);
        g.fillStyle = s.leaf;
        g.fillRect(x - 3, y - 7, 2, 7);
        g.fillRect(x + 1, y - 5, 2, 5);
        if ((r + c) % 2 === 0) {
          g.fillStyle = s.bloom;
          g.fillRect(x - 2, y - 10, 3, 3);
        }
      }
    }
    if (s.material === "holo") slab(g, 0.08, 0.08, 0.84, 0.84, 0, "rgba(0,0,0,0)", s.light);
  },
};

/** One theme's `decor` slot: bakes each preset once, stamps it from then on. */
export function makeDecorArt(style: DecorStyle): (ctx: Ctx, preset: DecorPreset, px: number, py: number) => void {
  const baked = bakery<DecorPreset>((k) => bakeAnchored(1, 1, 70, (g) => DRAW[k](g, style)));
  return (ctx, preset, px, py) => {
    const b = baked(preset);
    if (b) stamp(ctx, b, px, py);
  };
}

/** Draw one preset straight onto `g` (no bake). For tests and previews. */
export function drawDecorPreset(g: Ctx, preset: DecorPreset, style: DecorStyle): void {
  DRAW[preset](g, style);
}
