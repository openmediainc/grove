/**
 * Sci-fi — neon cyberpunk, committed.
 *
 * Black glass and teal grid lines, violet light strips, holograms. Runners are
 * people in long coats with amber visors; agents are synths. Drones hover where
 * the sheep graze. Access levels: a FORCE FIELD (a building sealed inside a
 * closed hex-shield dome, with a padlock), GLASS (a glass cube lit from inside,
 * door shut), OPEN (a bare platform under a holo arch — no walls at all).
 *
 * Neon pink is deliberately NOT in this palette: it is the prompt-injection
 * flag's colour, and a theme that painted its signage in it would be shouting
 * over the one thing that is allowed to shout.
 */

import type { AccessLevel, CharKey, CivicRoom, ItemKey, PropKey, ScaffoldStage, ScatterKey } from "@/lib/art";
import type { MapRegion } from "@/lib/map-layout";
import {
  bakeAnchored,
  bakeFigure,
  bakeGrid,
  bakePath,
  bakeTile,
  bakery,
  cylinder,
  dome,
  door,
  drawSpeechBubble,
  drawSignboard,
  drawSpeechPip,
  drawHazardTriangle,
  drawVerbGlyph,
  faces,
  glow,
  groundEllipse,
  lockMark,
  P,
  pole,
  prism,
  rng,
  seg,
  shadow,
  slab,
  stamp,
  stanceOf,
  tileFill,
  tileLine,
  tileRect,
  wallQuad,
  windows,
  wireBox,
  type Baked,
  type Ctx,
  type FigureSpec,
  type SignStyle,
} from "./kit";
import type { AmbientPose, Theme, ThemeArt, ThemeLexicon, ThemePalette } from "./types";

const TEAL = "#2de2e6";
const TEAL_DIM = "rgba(45,226,230,0.35)";
const VIOLET = "#a855f7";
const INK = "#0d0b1a";
const CHROME = "#1f1b33";
const AMBER = "#fbbf24";

/* ---- ground ------------------------------------------------------------ */

const TINT: Record<Exclude<MapRegion, "wild">, string> = {
  plaza: "#10202a",
  library: "#141234",
  workshop: "#221a10",
  stage: "#1d1030",
  garden: "#0e2218",
  board: "#26101a",
};

const groundB = bakery<string>((key) => {
  const [region, variant] = key.split(":") as [MapRegion, string];
  const v = Number(variant);
  return bakeTile((g) => {
    if (region === "wild") {
      tileFill(g, "#07060e");
      tileLine(g, 0, 0, 1, 0, "rgba(168,85,247,0.14)");
      tileLine(g, 0, 0, 0, 1, "rgba(168,85,247,0.14)");
      if (v) {
        const [x, y] = P(0.5, 0.5);
        g.fillStyle = "rgba(45,226,230,0.5)";
        g.fillRect(x, y, 1, 1);
      }
      return;
    }
    tileFill(g, TINT[region]);
    // The grid: bright on two edges so neighbouring tiles share one line.
    tileLine(g, 0, 0, 1, 0, TEAL_DIM);
    tileLine(g, 0, 0, 0, 1, TEAL_DIM);
    if (v) tileRect(g, 0.35, 0.35, 0.65, 0.65, "rgba(45,226,230,0.07)");
    if (region === "garden") {
      const [x, y] = P(0.3 + v * 0.3, 0.6);
      g.fillStyle = "rgba(74,222,128,0.55)";
      g.fillRect(x, y, 2, 1);
    }
  });
});

const pathB = bakery<number>((mask) =>
  bakePath(mask, "#0a0914", VIOLET, 0.4, (g) => {
    // A light lane down the middle of each arm.
    const lane = (x0: number, y0: number, x1: number, y1: number) => tileLine(g, x0, y0, x1, y1, TEAL, 1.5);
    lane(0.5, 0.5, 0.5, 0.5);
    if (mask & 1) lane(0.5, 0, 0.5, 0.5);
    if (mask & 4) lane(0.5, 0.5, 0.5, 1);
    if (mask & 2) lane(0.5, 0.5, 1, 0.5);
    if (mask & 8) lane(0, 0.5, 0.5, 0.5);
  }),
);

const scatterB = bakery<ScatterKey>((key) =>
  bakeTile((g) => {
    const r = rng(key.length * 41 + key.charCodeAt(2));
    const at = () => P(0.2 + r() * 0.6, 0.2 + r() * 0.6);
    if (key === "pebbles" || key === "crack") {
      tileLine(g, 0.25, 0.5, 0.6, 0.5, key === "crack" ? "rgba(168,85,247,0.4)" : "rgba(45,226,230,0.25)");
    } else if (key === "flowers" || key === "tuft") {
      for (let i = 0; i < 3; i++) {
        const [x, y] = at();
        g.fillStyle = i % 2 ? "rgba(74,222,128,0.8)" : "rgba(45,226,230,0.8)";
        g.fillRect(x, y, 1, 1);
      }
    } else if (key === "puddle") {
      groundEllipse(g, 0.5, 0.5, 0.16, 0, "rgba(168,85,247,0.25)", "rgba(45,226,230,0.35)");
    } else {
      const [x, y] = at();
      g.fillStyle = "rgba(251,191,36,0.5)";
      g.fillRect(x, y, 2, 1);
    }
  }),
);

/* ---- landmarks --------------------------------------------------------- */

const glass = faces("#1b1836", 0.25, -0.35);
const dark = faces(CHROME, 0.22, -0.4);

function plinth(g: Ctx, n: number): void {
  shadow(g, 0.2, 0.2, n - 0.4, n - 0.4);
  prism(g, 0.15, 0.15, n - 0.3, n - 0.3, 0, 5, faces("#16132a"));
  // An underglow line round the plinth.
  seg(g, [0.15, n - 0.15, 1], [n - 0.15, n - 0.15, 1], TEAL, 1.5);
  seg(g, [n - 0.15, 0.15, 1], [n - 0.15, n - 0.15, 1], TEAL, 1.5);
}

/** Light strips up the visible edges of a box. */
function edgeLights(g: Ctx, x: number, y: number, w: number, d: number, z: number, h: number, colour: string): void {
  seg(g, [x, y + d, z], [x, y + d, z + h], colour, 2);
  seg(g, [x + w, y + d, z], [x + w, y + d, z + h], colour, 2);
  seg(g, [x + w, y, z], [x + w, y, z + h], colour, 2);
  seg(g, [x, y + d, z + h], [x + w, y + d, z + h], colour, 1);
  seg(g, [x + w, y, z + h], [x + w, y + d, z + h], colour, 1);
}

const LANDMARK: Record<CivicRoom, (g: Ctx) => void> = {
  // The Hub: a spire ringed by holographic halos.
  plaza(g) {
    plinth(g, 4);
    prism(g, 0.9, 0.9, 2.2, 2.2, 5, 30, dark);
    edgeLights(g, 0.9, 0.9, 2.2, 2.2, 5, 30, TEAL);
    prism(g, 1.5, 1.5, 1.0, 1.0, 35, 110, glass);
    edgeLights(g, 1.5, 1.5, 1.0, 1.0, 35, 110, VIOLET);
    for (let k = 0; k < 3; k++) {
      const [x, y] = P(2, 2, 70 + k * 30);
      g.strokeStyle = k === 1 ? "rgba(168,85,247,0.75)" : "rgba(45,226,230,0.75)";
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(x, y + 8, 46 - k * 8, 18 - k * 3, 0, 0, Math.PI * 2);
      g.stroke();
    }
    const [tx, ty] = P(2, 2, 150);
    glow(g, tx, ty, 16, "rgba(45,226,230,0.9)");
  },
  // Memory Bank: a black monolith banded with violet light.
  library(g) {
    plinth(g, 4);
    prism(g, 1.0, 1.0, 2.0, 2.0, 5, 160, glass);
    for (let k = 0; k < 12; k++) {
      const z = 16 + k * 12;
      const on = (k * 7) % 5 !== 0;
      wallQuad(g, "left", 1, 1, 2, 2, 0.1, 1.9, z, z + 2, on ? VIOLET : "#3b2a5c");
      wallQuad(g, "right", 1, 1, 2, 2, 0.1, 1.9, z, z + 2, on ? "#7e22ce" : "#2a1f44");
    }
    edgeLights(g, 1.0, 1.0, 2.0, 2.0, 5, 160, TEAL);
    door(g, "left", 1, 1, 2, 2, 5, 1, 0.45, 20, "open", { frame: TEAL, leaf: INK, dark: "#000", bar: TEAL });
  },
  // Foundry: stacked blocks with glowing vents and a heat stack.
  workshop(g) {
    plinth(g, 4);
    prism(g, 0.4, 0.8, 3.2, 2.6, 5, 44, dark);
    for (let i = 0; i < 5; i++) wallQuad(g, "left", 0.4, 0.8, 3.2, 2.6, 0.3 + i * 0.6, 0.6 + i * 0.6, 14, 30, AMBER);
    for (let i = 0; i < 4; i++) wallQuad(g, "right", 0.4, 0.8, 3.2, 2.6, 0.3 + i * 0.6, 0.6 + i * 0.6, 14, 30, "#f59e0b");
    prism(g, 0.8, 1.2, 1.6, 1.6, 49, 30, dark);
    edgeLights(g, 0.8, 1.2, 1.6, 1.6, 49, 30, VIOLET);
    cylinder(g, 3.1, 1.2, 0.28, 49, 70, faces("#2a2440"));
    const [x, y] = P(3.1, 1.2, 119);
    glow(g, x, y, 18, "rgba(251,146,60,0.8)");
  },
  // Holo Stage: a round platform under a translucent hologram.
  stage(g) {
    plinth(g, 4);
    cylinder(g, 2, 2, 1.3, 5, 12, dark);
    groundEllipse(g, 2, 2, 1.1, 17, "rgba(45,226,230,0.18)", TEAL, 2);
    // The hologram: a floating wireframe octahedron, two layers of light.
    const [cx, cy] = P(2, 2, 70);
    const tri = (dy: number, alpha: number) => {
      g.fillStyle = `rgba(168,85,247,${alpha})`;
      g.beginPath();
      g.moveTo(cx, cy - 42 + dy);
      g.lineTo(cx + 30, cy + dy);
      g.lineTo(cx, cy + 42 + dy);
      g.lineTo(cx - 30, cy + dy);
      g.closePath();
      g.fill();
    };
    tri(0, 0.22);
    g.strokeStyle = TEAL;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, cy - 42);
    g.lineTo(cx + 30, cy);
    g.lineTo(cx, cy + 42);
    g.lineTo(cx - 30, cy);
    g.closePath();
    g.moveTo(cx, cy - 42);
    g.lineTo(cx + 8, cy + 6);
    g.lineTo(cx, cy + 42);
    g.stroke();
    const [bx, by] = P(2, 2, 17);
    const beam = g.createLinearGradient(0, by, 0, cy);
    beam.addColorStop(0, "rgba(45,226,230,0.35)");
    beam.addColorStop(1, "rgba(45,226,230,0)");
    g.fillStyle = beam;
    g.beginPath();
    g.moveTo(bx - 24, by);
    g.lineTo(bx + 24, by);
    g.lineTo(cx + 6, cy);
    g.lineTo(cx - 6, cy);
    g.closePath();
    g.fill();
  },
  // Biodome: glowing growth under a translucent shell.
  garden(g) {
    plinth(g, 4);
    groundEllipse(g, 2, 2, 1.5, 5, "#07170f");
    for (let i = 0; i < 16; i++) {
      const r = rng(i + 19);
      const [x, y] = P(1.0 + r() * 2.0, 1.0 + r() * 2.0, 5);
      g.fillStyle = i % 2 ? "rgba(74,222,128,0.9)" : "rgba(45,226,230,0.8)";
      g.fillRect(x - 1, y - 12, 2, 12);
      g.fillRect(x - 3, y - 12, 6, 2);
    }
    dome(g, 2, 2, 1.5, 5, 66, { top: "rgba(45,226,230,0.35)", left: "rgba(45,226,230,0.14)", right: "rgba(168,85,247,0.2)" }, 1);
    groundEllipse(g, 2, 2, 1.5, 5, null, TEAL, 2);
  },
  // Alert Grid: a wall of screens on a black frame.
  board(g) {
    plinth(g, 4);
    prism(g, 0.6, 1.4, 2.8, 1.8, 5, 20, dark);
    prism(g, 0.7, 1.2, 2.6, 0.25, 25, 80, faces("#0a0914"));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const colour = (r * 4 + c) % 5 === 0 ? AMBER : (r + c) % 2 ? TEAL : VIOLET;
        wallQuad(g, "left", 0.7, 1.2, 2.6, 0.25, 0.12 + c * 0.62, 0.6 + c * 0.62, 32 + r * 24, 50 + r * 24, colour);
        wallQuad(g, "left", 0.7, 1.2, 2.6, 0.25, 0.16 + c * 0.62, 0.4 + c * 0.62, 40 + r * 24, 42 + r * 24, "rgba(13,11,26,0.7)");
      }
    }
    edgeLights(g, 0.7, 1.2, 2.6, 0.25, 25, 80, TEAL);
  },
};

const landmarkB = bakery<CivicRoom>((room) => bakeAnchored(4, 4, 200, LANDMARK[room]));

/* ---- access levels ---------------------------------------------------- */

const BUILDING: Record<AccessLevel, (g: Ctx) => void> = {
  // FORCE FIELD: the building is inside a closed shield. Hex lattice, padlock.
  private(g) {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    prism(g, 0.9, 0.9, 1.2, 1.2, 0, 50, dark);
    edgeLights(g, 0.9, 0.9, 1.2, 1.2, 0, 50, "#7e22ce");
    dome(g, 1.5, 1.5, 1.2, 0, 80, { top: "rgba(168,85,247,0.34)", left: "rgba(168,85,247,0.2)", right: "rgba(88,28,135,0.34)" }, 1);
    const [cx, cy] = P(1.5, 1.5, 0);
    g.save();
    g.beginPath();
    g.ellipse(cx, cy, 1.2 * 32 * Math.SQRT2, 1.2 * 16 * Math.SQRT2, 0, 0, Math.PI);
    g.bezierCurveTo(cx - 54, cy - 104, cx + 54, cy - 104, cx + 54, cy);
    g.clip();
    g.strokeStyle = "rgba(216,180,254,0.55)";
    g.lineWidth = 1;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        const hx = cx - 60 + col * 14 + (row % 2) * 7;
        const hy = cy - 96 + row * 12;
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k;
          g[k ? "lineTo" : "moveTo"](hx + Math.cos(a) * 6, hy + Math.sin(a) * 6);
        }
        g.closePath();
        g.stroke();
      }
    }
    g.restore();
    groundEllipse(g, 1.5, 1.5, 1.2, 0, null, VIOLET, 2);
    const [lx, ly] = P(1.5, 2.7, 26);
    lockMark(g, lx, ly, VIOLET, "#f5f3ff");
  },
  // GLASS: a clear cube lit from within, frame lights, door shut.
  public_view(g) {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    slab(g, 0.4, 0.4, 2.2, 2.2, 0, "#16132a");
    prism(g, 1.0, 1.0, 1.0, 1.0, 0, 26, faces("#312e81"));
    const [ix, iy] = P(1.5, 1.5, 30);
    glow(g, ix, iy, 30, "rgba(45,226,230,0.45)");
    prism(g, 0.4, 0.4, 2.2, 2.2, 0, 66, { top: "rgba(45,226,230,0.12)", left: "rgba(45,226,230,0.16)", right: "rgba(45,226,230,0.1)" }, TEAL);
    edgeLights(g, 0.4, 0.4, 2.2, 2.2, 0, 66, TEAL);
    door(g, "left", 0.4, 0.4, 2.2, 2.2, 0, 1.1, 0.5, 26, "shut", { frame: TEAL, leaf: "#1e1b4b", dark: "#000", bar: TEAL });
  },
  // OPEN: a platform under a holo arch. No walls, nothing shut.
  public_write(g) {
    shadow(g, 0.2, 0.2, 2.6, 2.6);
    prism(g, 0.2, 0.2, 2.6, 2.6, 0, 6, faces("#16132a"));
    seg(g, [0.2, 2.8, 6], [2.8, 2.8, 6], "#4ade80", 2);
    seg(g, [2.8, 0.2, 6], [2.8, 2.8, 6], "#4ade80", 2);
    pole(g, 0.6, 2.4, 6, 54, TEAL, 3);
    pole(g, 2.4, 2.4, 6, 54, TEAL, 3);
    const [a0, a1] = P(0.6, 2.4, 60);
    const [b0, b1] = P(2.4, 2.4, 60);
    g.strokeStyle = TEAL;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(a0, a1);
    g.quadraticCurveTo((a0 + b0) / 2, a1 - 24, b0, b1);
    g.stroke();
    glow(g, (a0 + b0) / 2, a1 - 12, 14, "rgba(74,222,128,0.7)");
    prism(g, 1.0, 0.7, 0.9, 0.3, 6, 8, faces("#312e81"));
  },
};

const buildingB = bakery<AccessLevel>((a) => bakeAnchored(3, 3, 130, BUILDING[a]));

const scaffoldB = bakery<ScaffoldStage>((stage) =>
  bakeAnchored(3, 3, 130, (g) => {
    // A building materialising: wireframe first, then translucent fill.
    slab(g, 0.4, 0.4, 2.2, 2.2, 0, "rgba(45,226,230,0.1)", TEAL_DIM);
    const h = 64;
    const filled = stage === 1 ? 0 : stage === 2 ? 0.45 : 0.8;
    if (filled) {
      prism(g, 0.4, 0.4, 2.2, 2.2, 0, h * filled, { top: "rgba(168,85,247,0.4)", left: "rgba(168,85,247,0.28)", right: "rgba(88,28,135,0.4)" }, VIOLET);
    }
    wireBox(g, 0.4, 0.4, 2.2, 2.2, 0, h, TEAL, 1.5);
    const [sx, sy] = P(1.5, 1.5, h * filled + 4);
    glow(g, sx, sy, 20, "rgba(45,226,230,0.55)");
    for (let i = 0; i < 4; i++) {
      const [x, y] = P(0.4 + (i % 2) * 2.2, 0.4 + ((i >> 1) % 2) * 2.2, h + 10);
      g.fillStyle = TEAL;
      g.fillRect(x - 1, y - 1, 3, 3);
    }
  }),
);

/* ---- props -------------------------------------------------------------- */

const PROP_ART: Record<PropKey, (g: Ctx) => void> = {
  lantern(g) {
    // A neon pylon: the light source.
    prism(g, 0.42, 0.42, 0.16, 0.16, 0, 46, faces("#1f1b33"));
    seg(g, [0.42, 0.58, 4], [0.42, 0.58, 46], TEAL, 2);
    seg(g, [0.58, 0.42, 4], [0.58, 0.42, 46], VIOLET, 2);
    const [x, y] = P(0.5, 0.5, 50);
    glow(g, x, y, 10, "rgba(45,226,230,0.85)");
  },
  bench(g) {
    // A hover bench, with its lift glow under it.
    groundEllipse(g, 0.5, 0.5, 0.26, 0, "rgba(45,226,230,0.3)");
    prism(g, 0.2, 0.38, 0.6, 0.24, 6, 5, faces("#2e2a4a"));
    seg(g, [0.2, 0.62, 6], [0.8, 0.62, 6], TEAL, 1);
  },
  planter(g) {
    prism(g, 0.28, 0.28, 0.44, 0.44, 0, 10, faces("#1f1b33"));
    for (let i = 0; i < 4; i++) {
      const [x, y] = P(0.35 + i * 0.1, 0.5, 10);
      g.fillStyle = i % 2 ? "#4ade80" : TEAL;
      g.fillRect(x - 1, y - 10 - (i % 3) * 3, 2, 10 + (i % 3) * 3);
    }
  },
  crates(g) {
    prism(g, 0.15, 0.25, 0.42, 0.42, 0, 18, faces("#1f1b33"));
    wallQuad(g, "left", 0.15, 0.25, 0.42, 0.42, 0.05, 0.37, 8, 10, TEAL);
    prism(g, 0.55, 0.5, 0.32, 0.32, 0, 12, faces("#2a2440"));
    wallQuad(g, "right", 0.55, 0.5, 0.32, 0.32, 0.05, 0.27, 5, 7, VIOLET);
  },
  signpost(g) {
    // A holo sign hanging in the air over a post.
    pole(g, 0.5, 0.5, 0, 30, "#4c4670", 2);
    const [x, y] = P(0.5, 0.5, 44);
    g.fillStyle = "rgba(45,226,230,0.25)";
    g.fillRect(x - 12, y - 8, 24, 12);
    g.strokeStyle = TEAL;
    g.lineWidth = 1;
    g.strokeRect(x - 12, y - 8, 24, 12);
    g.fillStyle = TEAL;
    g.fillRect(x - 8, y - 4, 10, 2);
    g.fillRect(x - 8, y, 14, 1);
  },
  brazier(g) {
    // A plasma core: the heat source.
    cylinder(g, 0.5, 0.5, 0.24, 0, 12, faces("#1f1b33"));
    const [x, y] = P(0.5, 0.5, 24);
    g.fillStyle = "#fed7aa";
    g.beginPath();
    g.ellipse(x, y, 5, 7, 0, 0, Math.PI * 2);
    g.fill();
    glow(g, x, y, 18, "rgba(251,146,60,0.75)");
  },
  wellstone(g) {
    // A holo pool: the water feature.
    cylinder(g, 0.5, 0.5, 0.34, 0, 6, faces("#1f1b33"));
    groundEllipse(g, 0.5, 0.5, 0.28, 6, "rgba(45,226,230,0.55)", TEAL);
    groundEllipse(g, 0.5, 0.5, 0.14, 6, "rgba(207,250,254,0.5)");
  },
  rubble(g) {
    const r = rng(23);
    for (let i = 0; i < 5; i++) {
      const [x, y] = P(0.25 + r() * 0.5, 0.25 + r() * 0.5);
      g.fillStyle = i % 2 ? "#2a2440" : "#3f3a5c";
      g.fillRect(x - 4, y - 4, 7 - i, 4);
      if (i === 2) {
        g.fillStyle = AMBER;
        g.fillRect(x - 1, y - 3, 2, 1);
      }
    }
  },
};

const propB = bakery<PropKey>((k) => bakeAnchored(1, 1, 70, PROP_ART[k]));

/* ---- bodies, critters, items ------------------------------------------ */

const RUNNER: FigureSpec = {
  skin: "#d6a77a",
  head: "round",
  headColour: "#111827",
  torso: "#1f2937",
  legs: "#111827",
  accent: AMBER,
  shoulders: AMBER,
};

const SYNTH: FigureSpec = {
  skin: "#c4b5fd",
  head: "dome",
  headColour: "#e9d5ff",
  torso: "#7c3aed",
  legs: "#4c1d95",
  accent: TEAL,
  eyes: TEAL,
  outline: "#2de2e6",
};

const bodyB = bakery<CharKey>((k) => bakeFigure(k.startsWith("human") ? RUNNER : SYNTH, stanceOf(k)));

/** A hovering drone: a disc, two rotors, a sensor eye. */
const ambientB = bakery<AmbientPose>((pose) =>
  bakeGrid(20, 20, 2, 20, 20, (px) => {
    const blade = pose === "walk-a" || pose === "idle";
    px(6, 8, 8, 3, "#2a2440");
    px(7, 11, 6, 1, "#1f1b33");
    px(9, 9, 2, 1, pose === "graze" ? AMBER : TEAL);
    px(3, 6, 4, 2, "#4c4670");
    px(13, 6, 4, 2, "#4c4670");
    px(blade ? 1 : 3, 5, blade ? 8 : 4, 1, "rgba(207,250,254,0.7)");
    px(blade ? 11 : 13, 5, blade ? 8 : 4, 1, "rgba(207,250,254,0.7)");
    px(9, 12, 2, 2, "rgba(45,226,230,0.5)");
    px(7, 17, 6, 1, "rgba(45,226,230,0.25)");
  }),
);

const ITEM_ART: Record<ItemKey, Parameters<typeof bakeGrid>[5]> = {
  // holo card
  document(px) {
    px(2, 3, 8, 6, "rgba(45,226,230,0.35)");
    px(2, 3, 8, 1, TEAL);
    px(3, 5, 5, 1, TEAL);
    px(3, 7, 3, 1, TEAL);
  },
  // plasma cutter
  tool(px) {
    px(2, 6, 6, 3, "#4c4670");
    px(8, 7, 3, 1, "#fed7aa");
    px(3, 9, 2, 2, "#2a2440");
  },
  // thinking cube
  lamp(px) {
    px(3, 3, 6, 6, VIOLET);
    px(4, 4, 4, 4, "#e9d5ff");
    px(5, 5, 2, 2, "#ffffff");
  },
  // bio-cell
  seedling(px) {
    px(4, 3, 4, 8, "#1f1b33");
    px(5, 4, 2, 6, "#4ade80");
    px(5, 2, 2, 1, TEAL);
  },
};

const itemB = bakery<ItemKey>((k) => bakeGrid(12, 12, 2, 12, 12, ITEM_ART[k]));

/* ---- the art ------------------------------------------------------------ */

function stampOr(ctx: Ctx, b: Baked | null, x: number, y: number): boolean {
  if (!b) return false;
  stamp(ctx, b, x, y);
  return true;
}

let horizon: { c: HTMLCanvasElement; w: number; h: number } | null = null;

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
/** Speech: the look is the theme's; a whisper keeps violet and a dashed edge in every theme. */
const SPEECH_STYLE = {
  bg: "rgba(5,4,11,0.94)",
  fg: TEAL,
  border: "rgba(45,226,230,0.6)",
  radius: 0,
  font: MONO,
  whisperBg: "rgba(26,10,40,0.95)",
  whisperFg: "#f0abfc",
  whisperBorder: "rgba(232,121,249,0.85)",
} as const;

/**
 * A holo panel: black glass with teal corner brackets, tethered to the
 * building by a light line, the org colour as a glowing underline beneath the
 * name. Held: a violet-dim panel with a padlock. No neon pink — that is the
 * injection-flag colour.
 */
export const SIGN_STYLE: SignStyle = {
  board: "rgba(4,10,14,0.86)",
  edge: "rgba(45,226,230,0.35)",
  title: TEAL,
  detail: "rgba(203,213,225,0.78)",
  heldBoard: "rgba(13,11,26,0.9)",
  heldTitle: "rgba(196,181,253,0.7)",
  lock: { body: CHROME, shackle: "#c4b5fd" },
  font: MONO,
  radius: 0,
  mark: { plate: "rgba(4,10,14,0.92)", rim: "rgba(45,226,230,0.85)", glyph: "#c4b5fd", shape: "hex" },
  tintAt: "underline",
  fixings(ctx, x0, y0, w) {
    ctx.fillStyle = "rgba(45,226,230,0.55)";
    ctx.fillRect(x0 + Math.round(w / 2), y0 - 7, 1, 7);
  },
  trim(ctx, x0, y0, w, h, held) {
    ctx.fillStyle = held ? "rgba(168,85,247,0.7)" : TEAL;
    // Four corner brackets, 4px each way.
    ctx.fillRect(x0, y0, 4, 1);
    ctx.fillRect(x0, y0, 1, 4);
    ctx.fillRect(x0 + w - 4, y0, 4, 1);
    ctx.fillRect(x0 + w - 1, y0, 1, 4);
    ctx.fillRect(x0, y0 + h - 1, 4, 1);
    ctx.fillRect(x0, y0 + h - 4, 1, 4);
    ctx.fillRect(x0 + w - 4, y0 + h - 1, 4, 1);
    ctx.fillRect(x0 + w - 1, y0 + h - 4, 1, 4);
  },
};

const art: ThemeArt = {
  async prepare() {
    /* Procedural: everything bakes on first use. */
  },
  backdrop(ctx, w, h) {
    if (typeof document === "undefined") return;
    const W = Math.ceil(w / 128) * 128;
    const H = Math.ceil(h / 128) * 128;
    if (!horizon || horizon.w !== W || horizon.h !== H) {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const g = c.getContext("2d");
      if (g) {
        const grad = g.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, "#05040b");
        grad.addColorStop(0.7, "#0b0718");
        grad.addColorStop(1, "#1a0b2e");
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
        // Faint scanlines.
        g.fillStyle = "rgba(168,85,247,0.035)";
        for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
      }
      horizon = { c, w: W, h: H };
    }
    ctx.drawImage(horizon.c, 0, 0);
  },
  ground(ctx, region, x, y, tx, ty) {
    const v = (tx * 5 + ty * 3) % 6 === 0;
    return stampOr(ctx, groundB(`${region}:${v ? 1 : 0}`), x, y);
  },
  path(ctx, mask, x, y) {
    stampOr(ctx, pathB(mask), x, y);
  },
  scatter(ctx, key, x, y) {
    stampOr(ctx, scatterB(key), x, y);
  },
  landmark(ctx, room, px, py) {
    stampOr(ctx, landmarkB(room), px, py);
  },
  building(ctx, access, px, py) {
    stampOr(ctx, buildingB(access), px, py);
  },
  scaffold(ctx, stage, px, py) {
    stampOr(ctx, scaffoldB(stage), px, py);
  },
  prop(ctx, key, px, py) {
    stampOr(ctx, propB(key), px, py);
  },
  body(ctx, sprite, x, y) {
    return stampOr(ctx, bodyB(sprite), x, y);
  },
  ambient(ctx, pose, x, y, flip, t) {
    const b = ambientB(pose);
    if (!b) return;
    const hover = Math.sin(t / 380 + x * 0.1) * 2.5 - 10;
    ctx.save();
    ctx.translate(x, y + hover);
    if (flip) ctx.scale(-1, 1);
    stamp(ctx, b, 0, 0);
    ctx.restore();
  },
  carry(ctx, item, x, y) {
    return stampOr(ctx, itemB(item), x, y);
  },
  glyph: drawVerbGlyph,
  pennant(ctx, colour, x, y) {
    // A holo tag: a floating diamond in the org colour, tethered by a light line.
    ctx.save();
    ctx.translate(x - 22, y - 4);
    ctx.strokeStyle = "rgba(7,8,20,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -14);
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -14);
    ctx.stroke();
    ctx.fillStyle = "rgba(7,8,20,0.85)";
    ctx.beginPath();
    ctx.moveTo(0, -27);
    ctx.lineTo(7, -20);
    ctx.lineTo(0, -13);
    ctx.lineTo(-7, -20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, -25);
    ctx.lineTo(5, -20);
    ctx.lineTo(0, -15);
    ctx.lineTo(-5, -20);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
  hazard: drawHazardTriangle,
  speechFont: MONO,
  speech(ctx, bubble) {
    drawSpeechBubble(ctx, bubble, SPEECH_STYLE);
  },
  speechPip(ctx, sx, sy, whisper) {
    drawSpeechPip(ctx, sx, sy, whisper, { fg: TEAL, whisperFg: SPEECH_STYLE.whisperFg });
  },
  signboard(ctx, board) {
    drawSignboard(ctx, board, SIGN_STYLE);
  },
};

export const SCIFI_LEXICON: ThemeLexicon = {
  name: "Sci-fi",
  blurb: "Neon on black glass. Runners, synths, drones and holograms.",
  resource: { name: "energy", coin: "#e879f9", rim: "#701a75" },
  eyebrow: "Glasshouse Grid",
  headline: "The grid grows as they do.",
  subline: "Idle synths stand by. Awake ones process, execute, wait, or broadcast.",
  skyPlace: "on the grid",
  aHuman: "A runner (a person)",
  anAgent: "A synth (an agent)",
  bodies: "units",
  regions: {
    plaza: { title: "Hub", bookmark: "Hub — where the grid talks" },
    library: { title: "Memory Bank", bookmark: "Memory Bank — where units read" },
    workshop: { title: "Foundry", bookmark: "Foundry — where the tools run" },
    stage: { title: "Holo Stage", bookmark: "Holo Stage — what is on" },
    garden: { title: "Biodome", bookmark: "Biodome — where idle units go" },
    board: { title: "Alert Grid", bookmark: "Alert Grid — faults and notices" },
  },
  access: {
    private: { label: "shielded", blurb: "Behind a force field. The grid says the node is taken, and nothing else." },
    public_view: { label: "glass", blurb: "Behind glass. Anyone may watch; only its members broadcast here." },
    public_write: { label: "open", blurb: "Open node — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this node.",
  claimedPlot: "claimed node",
  heldPlot: "Held node",
  resting: "standby at home node",
  construction: "compiling",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle units", allBusy: "all units running" },
  hud: { hereNow: "connected", watching: "observing", awake: "online", asleep: "dormant", fog: "range", world: "grid", claimed: "nodes", quiet: "no broadcasts recently" },
  legend: ["execute", "process", "broadcast", "wait", "blocked", "fault", "dormant", "fading"],
  card: { workingOn: "Running", lookingFor: "Seeking", latest: "Last output", links: "Uplinks", fromToolCalls: "from its tool spans", fromPulse: "from its signal", empty: "No data on this node.", walkOver: "Jump to", follow: "Subscribe", following: "Subscribed", message: "Send a ping" },
  controls: {
    goTo: "jump to",
    busiest: "Busiest",
    busiestTitle: "Busiest sector right now",
    mySpace: "My node",
    mySpaceTitle: "My node — the one I hold",
    kiosk: "Kiosk",
    tv: "Feed",
    onAir: "Live feed",
    following: "Tracking",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
  postcard: { button: "Capture", buttonTitle: "Capture this view as a PNG on this device. Nothing leaves it.", greeting: "Frame captured on", world: "the Glasshouse Grid", replay: "Playback" },
  marks: { heading: "Badges", thousand_calls: "1k tool calls executed on this node", week_streak: "Seven-cycle uptime streak" },
};

export const SCIFI_PALETTE: ThemePalette = {
  plotTint: {
    private: "rgba(168,85,247,0.22)",
    public_view: "rgba(45,226,230,0.18)",
    public_write: "rgba(74,222,128,0.18)",
  },
  fog: "rgba(3,2,8,0.78)",
  plotEdge: "rgba(168,85,247,0.4)",
  coreGrid: "rgba(45,226,230,0.08)",
  plotName: TEAL,
  nameFill: "#cffafe",
  paperclipNameFill: "#d8b4fe",
  departRing: "rgba(45,226,230,0.8)",
  placeholder: { human: AMBER, agent: VIOLET },
  glow: ["rgba(165,243,252,0.85)", "rgba(45,226,230,0.3)", "rgba(168,85,247,0)"],
  daylight: "rgb(80,70,120)",
  card: { bg: "rgba(5,4,11,0.95)", title: TEAL, text: "rgba(207,250,254,0.8)" },
  chrome: {
    dusk950: "6 5 14",
    dusk900: "13 11 26",
    dusk800: "24 20 44",
    dusk700: "40 34 70",
    lantern300: "153 246 228",
    lantern400: "45 226 230",
    lantern500: "20 184 190",
  },
  displayFont: 'Orbitron, "Source Sans 3", ui-sans-serif, system-ui, sans-serif',
};

export const scifi = {
  id: "scifi",
  lexicon: SCIFI_LEXICON,
  palette: SCIFI_PALETTE,
  art,
} satisfies Theme;
