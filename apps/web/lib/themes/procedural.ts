/**
 * Procedural pixel-art backend for themes that have no PNG set.
 *
 * Every drawable slot is baked once into an offscreen canvas (see kit.ts) and
 * stamped from then on, so a theme switch is a palette + lexicon change, not a
 * new draw loop. Geometry matches the PNG set's footprints: a theme may be
 * taller or shorter, never wider.
 */

import type {
  AccessLevel,
  CivicRoom,
  ItemKey,
  PropKey,
  ScaffoldStage,
  ScatterKey,
} from "@/lib/art";
import { CIVIC_ROOMS, PROP_KEYS, SCATTER_KEYS } from "@/lib/art";
import type { MapRegion } from "@/lib/map-layout";
import {
  bake,
  bakeAnchored,
  bakeFigure,
  bakePath,
  bakeTile,
  bakery,
  cylinder,
  dome,
  drawBubble,
  drawHazardTriangle,
  drawPennantFlag,
  drawVerbGlyph,
  faces,
  glow,
  P,
  pole,
  prism,
  shade,
  slab,
  speckle,
  stamp,
  stanceOf,
  type Baked,
  type FigureSpec,
} from "./kit";
import type { Ctx } from "./types";
import type { AmbientPose, BodySprite, ThemeArt } from "./types";

export type GroundSpec = { fill: string; speckles: readonly string[] };

export type ProceduralKit = {
  ground: Readonly<Record<MapRegion, GroundSpec>>;
  path: { fill: string; edge: string };
  scatter: Readonly<Record<ScatterKey, string>>;
  /** Closed / see-through / open, by SHAPE. Colour is secondary. */
  building: Readonly<Record<AccessLevel, { body: string; roof: string; glass?: string }>>;
  landmark: Readonly<Record<CivicRoom, { body: string; accent: string }>>;
  scaffold: { timber: string; cloth: string };
  prop: { metal: string; wood: string; plant: string; fire: string; water: string };
  human: FigureSpec;
  agent: FigureSpec;
  /** What idles in the garden. */
  critter: "sheep" | "pigeon" | "satellite" | "drone";
  speech: { bg: string; fg: string; border?: string };
};

const ACCESS: AccessLevel[] = ["private", "public_view", "public_write"];
const STAGES: ScaffoldStage[] = [1, 2, 3];
const POSES: AmbientPose[] = ["graze", "idle", "walk-a", "walk-b"];
const ITEMS: ItemKey[] = ["document", "tool", "lamp", "seedling"];
const SPRITES: BodySprite[] = [
  "human-front",
  "human-side",
  "human-speak",
  "agent-front",
  "agent-side",
  "agent-work",
];

function drawBuilding(g: Ctx, access: AccessLevel, spec: ProceduralKit["building"][AccessLevel]): void {
  const body = faces(spec.body);
  const roof = faces(spec.roof, 0.22, -0.35);
  slab(g, 0, 0, 3, 3, 0, "rgba(0,0,0,0.28)");
  if (access === "private") {
    // Closed compound: solid walls, no windows, hip roof.
    prism(g, 0.25, 0.25, 2.5, 2.5, 0, 36, body);
    prism(g, 1.1, 2.35, 0.4, 0.4, 0, 18, faces(shade(spec.body, -0.25)));
    gableXish(g, 0.15, 0.15, 2.7, 2.7, 36, 22, roof);
  } else if (access === "public_view") {
    // Colonnade / glass: you can see through.
    prism(g, 0.2, 0.2, 2.6, 2.6, 0, 8, body);
    for (const x of [0.4, 1.35, 2.3]) {
      prism(g, x, 0.35, 0.3, 0.3, 8, 28, body);
      prism(g, x, 2.35, 0.3, 0.3, 8, 28, body);
    }
    const glass = spec.glass ?? "rgba(180,220,255,0.35)";
    slab(g, 0.55, 0.55, 1.9, 1.9, 36, glass);
    prism(g, 0.15, 0.15, 2.7, 2.7, 36, 6, roof);
  } else {
    // Open canopy: low walls, no door, roof on posts.
    prism(g, 0.15, 0.15, 2.7, 2.7, 0, 10, body);
    for (const [x, y] of [
      [0.3, 0.3],
      [2.4, 0.3],
      [0.3, 2.4],
      [2.4, 2.4],
    ] as const) {
      prism(g, x, y, 0.28, 0.28, 10, 22, body);
    }
    prism(g, 0.05, 0.05, 2.9, 2.9, 32, 8, roof);
  }
}

function gableXish(
  g: Ctx,
  x: number,
  y: number,
  w: number,
  d: number,
  z: number,
  h: number,
  f: ReturnType<typeof faces>,
): void {
  const r0 = P(x, y + d / 2, z + h);
  const r1 = P(x + w, y + d / 2, z + h);
  const { poly } = { poly: (pts: Array<[number, number]>, fill: string) => {
    g.beginPath();
    g.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = "rgba(8,8,16,0.55)";
    g.lineWidth = 1;
    g.stroke();
  } };
  poly([P(x, y + d, z), P(x + w, y + d, z), r1, r0], f.left);
  poly([P(x + w, y, z), P(x + w, y + d, z), r1], f.right);
  poly([P(x, y, z), P(x + w, y, z), r1, r0], f.top);
}

function drawLandmark(g: Ctx, room: CivicRoom, spec: ProceduralKit["landmark"][CivicRoom]): void {
  const body = faces(spec.body);
  const accent = faces(spec.accent, 0.2, -0.3);
  slab(g, 0, 0, 4, 4, 0, "rgba(0,0,0,0.3)");
  if (room === "plaza") {
    cylinder(g, 2, 2, 0.7, 0, 10, accent);
    prism(g, 0.4, 0.4, 3.2, 3.2, 0, 8, body);
    pole(g, 2, 2, 10, 28, spec.accent, 3);
  } else if (room === "library") {
    prism(g, 0.3, 0.4, 3.4, 3.2, 0, 44, body);
    prism(g, 0.2, 0.3, 3.6, 3.4, 44, 8, accent);
    for (const x of [0.7, 1.7, 2.7]) prism(g, x, 3.2, 0.45, 0.3, 12, 18, faces(spec.accent));
  } else if (room === "workshop") {
    prism(g, 0.2, 0.5, 3.6, 3, 0, 28, body);
    prism(g, 0.1, 0.4, 3.8, 3.2, 28, 14, accent);
    cylinder(g, 3.3, 1.2, 0.28, 28, 22, faces(shade(spec.accent, -0.2)));
  } else if (room === "stage") {
    prism(g, 0.5, 1.2, 3, 2.2, 0, 12, body);
    prism(g, 0.3, 0.4, 3.4, 0.7, 12, 26, accent);
    pole(g, 0.6, 0.7, 38, 16, spec.accent);
    pole(g, 3.4, 0.7, 38, 16, spec.accent);
  } else if (room === "garden") {
    prism(g, 0.6, 0.6, 2.8, 2.8, 0, 6, body);
    cylinder(g, 2, 2, 0.9, 6, 8, faces(spec.accent));
    dome(g, 2, 2, 0.9, 14, 18, accent, 0.85);
  } else {
    prism(g, 0.5, 0.8, 3, 2.4, 0, 18, body);
    prism(g, 1.1, 0.5, 1.8, 0.5, 18, 22, accent);
    slab(g, 0.8, 1.1, 2.4, 1.6, 20, shade(spec.accent, 0.25));
  }
}

function drawScaffold(g: Ctx, stage: ScaffoldStage, spec: ProceduralKit["scaffold"]): void {
  const timber = faces(spec.timber);
  const h = 10 + stage * 12;
  slab(g, 0.1, 0.1, 2.8, 2.8, 0, "rgba(0,0,0,0.25)");
  for (const [x, y] of [
    [0.2, 0.2],
    [2.5, 0.2],
    [0.2, 2.5],
    [2.5, 2.5],
  ] as const) {
    prism(g, x, y, 0.25, 0.25, 0, h, timber);
  }
  prism(g, 0.15, 0.15, 2.7, 2.7, h, 4, faces(spec.cloth, 0.1, -0.2));
  if (stage >= 2) prism(g, 0.6, 0.6, 1.8, 1.8, 4, 10, timber);
  if (stage >= 3) prism(g, 0.8, 0.8, 1.4, 1.4, 14, 12, faces(spec.cloth));
}

function drawProp(g: Ctx, key: PropKey, spec: ProceduralKit["prop"]): void {
  const wood = faces(spec.wood);
  const metal = faces(spec.metal);
  slab(g, 0, 0, 1, 1, 0, "rgba(0,0,0,0.22)");
  if (key === "lantern") {
    pole(g, 0.5, 0.5, 0, 22, spec.metal, 2);
    prism(g, 0.32, 0.32, 0.36, 0.36, 20, 10, faces(spec.fire, 0.3, -0.1));
    const [sx, sy] = P(0.5, 0.5, 28);
    glow(g, sx, sy, 16, spec.fire);
  } else if (key === "bench") {
    prism(g, 0.1, 0.35, 0.8, 0.3, 0, 6, wood);
    prism(g, 0.1, 0.32, 0.8, 0.36, 6, 3, wood);
  } else if (key === "planter") {
    prism(g, 0.2, 0.2, 0.6, 0.6, 0, 8, wood);
    cylinder(g, 0.5, 0.5, 0.22, 8, 10, faces(spec.plant));
  } else if (key === "crates") {
    prism(g, 0.15, 0.2, 0.45, 0.45, 0, 10, wood);
    prism(g, 0.45, 0.35, 0.4, 0.4, 0, 8, wood);
  } else if (key === "signpost") {
    pole(g, 0.5, 0.55, 0, 26, spec.wood, 2);
    prism(g, 0.25, 0.4, 0.55, 0.2, 16, 8, metal);
  } else if (key === "brazier") {
    cylinder(g, 0.5, 0.5, 0.28, 0, 8, metal);
    const [sx, sy] = P(0.5, 0.5, 12);
    glow(g, sx, sy, 14, spec.fire);
  } else if (key === "wellstone") {
    cylinder(g, 0.5, 0.5, 0.35, 0, 8, metal);
    slab(g, 0.25, 0.25, 0.5, 0.5, 8, spec.water);
  } else {
    prism(g, 0.15, 0.25, 0.4, 0.35, 0, 6, wood);
    prism(g, 0.45, 0.35, 0.35, 0.3, 0, 4, metal);
  }
}

function drawCarry(g: Ctx, item: ItemKey): void {
  if (item === "document") {
    g.fillStyle = "#f4e4c1";
    g.fillRect(-6, -8, 12, 14);
    g.strokeStyle = "#3b2a14";
    g.strokeRect(-6, -8, 12, 14);
  } else if (item === "tool") {
    g.fillStyle = "#78716c";
    g.fillRect(-2, -10, 4, 16);
    g.fillStyle = "#a8a29e";
    g.fillRect(-6, -12, 12, 5);
  } else if (item === "lamp") {
    g.fillStyle = "#fbbf24";
    g.beginPath();
    g.arc(0, -2, 6, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillStyle = "#4ade80";
    g.fillRect(-2, -2, 4, 8);
    g.beginPath();
    g.arc(0, -6, 5, 0, Math.PI * 2);
    g.fill();
  }
}

function critterBake(kind: ProceduralKit["critter"], pose: AmbientPose): Baked {
  return bakeFigure(
    kind === "pigeon"
      ? {
          skin: "#d6d3d1",
          head: "round",
          headColour: "#a8a29e",
          torso: "#78716c",
          legs: "#57534e",
          accent: "#e7e5e4",
        }
      : kind === "satellite"
        ? {
            skin: "#94a3b8",
            head: "box",
            headColour: "#cbd5e1",
            torso: "#64748b",
            legs: "#475569",
            accent: "#38bdf8",
            eyes: "#7dd3fc",
            antenna: "#e2e8f0",
          }
        : kind === "drone"
          ? {
              skin: "#22d3ee",
              head: "dome",
              headColour: "#0e7490",
              torso: "#164e63",
              legs: "#083344",
              accent: "#67e8f9",
              eyes: "#a5f3fc",
            }
          : {
              skin: "#e7e5e4",
              head: "round",
              headColour: "#d6d3d1",
              torso: "#a8a29e",
              legs: "#78716c",
              accent: "#f5f5f4",
            },
    pose === "walk-a" || pose === "walk-b" ? "side" : pose === "graze" ? "work" : "front",
  );
}

export function makeProceduralArt(kit: ProceduralKit): ThemeArt {
  const ground = bakery((region: MapRegion) =>
    bakeTile((g) => {
      const spec = kit.ground[region] ?? kit.ground.plaza;
      g.fillStyle = spec.fill;
      g.fillRect(-32, 0, 64, 32);
      speckle(g, region.length * 17 + spec.fill.length, 28, spec.speckles, 2);
    }),
  );
  const paths = bakery((mask: number) => bakePath(mask, kit.path.fill, kit.path.edge));
  const scatter = bakery((key: ScatterKey) =>
    bakeTile((g) => {
      g.fillStyle = kit.scatter[key];
      speckle(g, key.length * 11, 12, [kit.scatter[key], shade(kit.scatter[key], 0.2)], 2);
    }),
  );
  const buildings = bakery((access: AccessLevel) =>
    bakeAnchored(3, 3, 128, (g) => drawBuilding(g, access, kit.building[access])),
  );
  const landmarks = bakery((room: CivicRoom) =>
    bakeAnchored(4, 4, 160, (g) => drawLandmark(g, room, kit.landmark[room])),
  );
  const scaffolds = bakery((stage: ScaffoldStage) =>
    bakeAnchored(3, 3, 100, (g) => drawScaffold(g, stage, kit.scaffold)),
  );
  const props = bakery((key: PropKey) => bakeAnchored(1, 1, 72, (g) => drawProp(g, key, kit.prop)));
  const bodies = bakery((sprite: BodySprite) =>
    bakeFigure(sprite.startsWith("human") ? kit.human : kit.agent, stanceOf(sprite)),
  );
  const critters = bakery((pose: AmbientPose) => critterBake(kit.critter, pose));
  const carried = bakery((item: ItemKey) => bake(24, 24, 12, 12, (g) => drawCarry(g, item), 1));

  const art: ThemeArt = {
    prepare() {
      if (typeof document === "undefined") return Promise.resolve();
      for (const r of [...CIVIC_ROOMS, "wild"] as MapRegion[]) ground(r);
      for (let m = 0; m < 16; m++) paths(m);
      for (const k of SCATTER_KEYS) scatter(k);
      for (const a of ACCESS) buildings(a);
      for (const r of CIVIC_ROOMS) landmarks(r);
      for (const s of STAGES) scaffolds(s);
      for (const k of PROP_KEYS) props(k);
      for (const s of SPRITES) bodies(s);
      for (const p of POSES) critters(p);
      for (const i of ITEMS) carried(i);
      return Promise.resolve();
    },
    backdrop() {},
    ground(ctx, region, x, y) {
      const b = ground(region);
      if (!b) return false;
      stamp(ctx, b, x, y);
      return true;
    },
    path(ctx, mask, x, y) {
      const b = paths(mask);
      if (b) stamp(ctx, b, x, y);
    },
    scatter(ctx, key, x, y) {
      const b = scatter(key);
      if (b) stamp(ctx, b, x, y);
    },
    landmark(ctx, room, px, py) {
      const b = landmarks(room);
      if (b) stamp(ctx, b, px, py);
    },
    building(ctx, access, px, py) {
      const b = buildings(access);
      if (b) stamp(ctx, b, px, py);
    },
    scaffold(ctx, stage, px, py) {
      const b = scaffolds(stage);
      if (b) stamp(ctx, b, px, py);
    },
    prop(ctx, key, px, py) {
      const b = props(key);
      if (b) stamp(ctx, b, px, py);
    },
    body(ctx, sprite, x, y) {
      const b = bodies(sprite);
      if (!b) return false;
      stamp(ctx, b, x, y);
      return true;
    },
    ambient(ctx, pose, x, y, flip) {
      const b = critters(pose);
      if (!b) return;
      ctx.save();
      ctx.translate(x, y);
      if (flip) ctx.scale(-1, 1);
      ctx.drawImage(b.c, -20, -20, 40, 40);
      ctx.restore();
    },
    carry(ctx, item, x, y) {
      const b = carried(item);
      if (!b) return false;
      stamp(ctx, b, x, y);
      return true;
    },
    glyph: drawVerbGlyph,
    pennant: drawPennantFlag,
    hazard: drawHazardTriangle,
    speech(ctx, x, y, text) {
      drawBubble(ctx, x, y, text, kit.speech);
    },
  };
  return art;
}
