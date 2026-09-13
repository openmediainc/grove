/**
 * Space — an orbital station on a rock in the dark.
 *
 * Deck plating for the civic core, regolith beyond it, stars behind
 * everything. Crew in pressure suits; agents are service robots. Satellites
 * drift where the sheep graze. Access levels: a SEALED module (no windows,
 * airlock shut and barred, padlock), a VIEWPORT module (glass wall, hatch shut),
 * an OPEN DOCK (a platform with a docking arch and no walls at all).
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
  drawEstateFence,
  drawEstateSign,
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
  speckle,
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
  type EstateStyle,
  type SignStyle,
} from "./kit";
import type { AmbientPose, Theme, ThemeArt, ThemeLexicon, ThemePalette } from "./types";

const HULL = "#8a94a8";
const HULL_DARK = "#4b5468";
const PANEL = "#2a3246";
const GLASS = "rgba(125,211,252,0.55)";
const LIGHT = "#e0f2fe";
const CYAN = "#67e8f9";
const WARN = "#fbbf24";
const RED_LOCK = "#ef4444";

/* ---- ground ------------------------------------------------------------ */

const DECK: Record<Exclude<MapRegion, "wild">, string> = {
  plaza: "#3a4458",
  library: "#2e3a5c",
  workshop: "#44423e",
  stage: "#3e3652",
  garden: "#2f4638",
  board: "#46363c",
};

const groundB = bakery<string>((key) => {
  const [region, variant] = key.split(":") as [MapRegion, string];
  const v = Number(variant);
  return bakeTile((g) => {
    if (region === "wild") {
      tileFill(g, v ? "#2a2724" : "#26231f");
      speckle(g, 11 + v, 26, ["#3a3530", "#1a1816", "#443e37"], 2);
      if (v) {
        groundEllipse(g, 0.55, 0.45, 0.16, 0, "#1c1a17", "#3d3833");
      }
      return;
    }
    const base = DECK[region];
    tileFill(g, base);
    // Plate seams on a half-tile grid, rivets at the crossings.
    tileLine(g, 0.5, 0, 0.5, 1, "rgba(0,0,0,0.35)");
    tileLine(g, 0, 0.5, 1, 0.5, "rgba(0,0,0,0.35)");
    tileLine(g, 0, 0, 1, 0, "rgba(255,255,255,0.08)");
    tileLine(g, 0, 0, 0, 1, "rgba(255,255,255,0.06)");
    if (region === "workshop" && v) {
      for (let i = 0; i < 4; i++) tileRect(g, 0.05 + i * 0.25, 0.82, 0.17 + i * 0.25, 0.95, "rgba(251,191,36,0.55)");
    }
    if (region === "garden") {
      tileRect(g, 0.12, 0.12, 0.38, 0.38, "rgba(74,222,128,0.28)");
      tileRect(g, 0.62, 0.62, 0.88, 0.88, "rgba(74,222,128,0.28)");
    }
    speckle(g, 97 + v * 13 + base.length, 6, ["rgba(255,255,255,0.12)", "rgba(0,0,0,0.25)"], 1);
  });
});

const pathB = bakery<number>((mask) =>
  bakePath(mask, "#1b2130", CYAN, 0.46, (g) => {
    // Guide lights down the middle of the walkway.
    const [sx, sy] = P(0.5, 0.5);
    g.fillStyle = "rgba(103,232,249,0.85)";
    g.fillRect(sx - 1, sy - 1, 2, 2);
  }),
);

const scatterB = bakery<ScatterKey>((key) =>
  bakeTile((g) => {
    const r = rng(key.length * 31 + key.charCodeAt(0));
    const at = () => P(0.2 + r() * 0.6, 0.2 + r() * 0.6);
    if (key === "pebbles" || key === "leaves") {
      for (let i = 0; i < 4; i++) {
        const [x, y] = at();
        g.fillStyle = key === "pebbles" ? "#5b6275" : "#3b3530";
        g.fillRect(x, y, 2, 2);
      }
    } else if (key === "tuft") {
      const [x, y] = at();
      g.strokeStyle = "rgba(15,23,42,0.8)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x - 6, y);
      g.quadraticCurveTo(x, y - 5, x + 6, y + 1);
      g.stroke();
    } else if (key === "flowers") {
      for (let i = 0; i < 3; i++) {
        const [x, y] = at();
        g.fillStyle = i % 2 ? "#4ade80" : "#67e8f9";
        g.fillRect(x, y, 1, 1);
      }
    } else if (key === "crack") {
      tileLine(g, 0.2, 0.3, 0.7, 0.35, "rgba(0,0,0,0.45)");
    } else if (key === "puddle") {
      groundEllipse(g, 0.5, 0.5, 0.14, 0, "rgba(56,189,248,0.35)");
    }
  }),
);

/* ---- landmarks --------------------------------------------------------- */

const hull = faces(HULL);
const hullDark = faces(HULL_DARK);
const panel = faces(PANEL, 0.25, -0.3);
const lit = (i: number) => (i % 3 === 0 ? "#fde68a" : i % 5 === 1 ? "#1e293b" : "#bae6fd");

function pad(g: Ctx, n: number): void {
  shadow(g, 0.2, 0.2, n - 0.4, n - 0.4);
  prism(g, 0.15, 0.15, n - 0.3, n - 0.3, 0, 6, faces("#3b4252"));
  // Landing marks round the pad edge.
  for (let i = 0; i < n * 2; i++) {
    const u = 0.3 + (i * (n - 0.6)) / (n * 2 - 1);
    const [a, b] = P(u, n - 0.2, 6);
    g.fillStyle = i % 2 ? WARN : "#1f2937";
    g.fillRect(a - 2, b - 1, 4, 2);
  }
}

const LANDMARK: Record<CivicRoom, (g: Ctx) => void> = {
  // The Bridge: a command module under a glass dome, antenna ring on top.
  plaza(g) {
    pad(g, 4);
    prism(g, 0.7, 0.7, 2.6, 2.6, 6, 38, hull);
    windows(g, 0.7, 0.7, 2.6, 2.6, 6, 38, 2, 2.2, lit);
    prism(g, 1.1, 1.1, 1.8, 1.8, 44, 10, hullDark);
    dome(g, 2, 2, 0.85, 54, 34, { top: "#e0f2fe", left: "#7dd3fc", right: "#0369a1" }, 0.85);
    pole(g, 2, 2, 100, 40, LIGHT, 2);
    const [ax, ay] = P(2, 2, 140);
    g.strokeStyle = CYAN;
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(ax, ay + 8, 16, 6, 0, 0, Math.PI * 2);
    g.stroke();
    glow(g, ax, ay, 8, "rgba(248,113,113,0.9)");
  },
  // The Data Core: a tall server stack with light strips.
  library(g) {
    pad(g, 4);
    prism(g, 1.0, 1.0, 2.0, 2.0, 6, 150, panel);
    for (let k = 0; k < 9; k++) {
      const z = 20 + k * 15;
      wallQuad(g, "left", 1, 1, 2, 2, 0.15, 1.85, z, z + 3, k % 2 ? "#60a5fa" : CYAN);
      wallQuad(g, "right", 1, 1, 2, 2, 0.15, 1.85, z, z + 3, k % 3 ? "#1d4ed8" : "#38bdf8");
    }
    prism(g, 0.7, 0.7, 2.6, 2.6, 6, 22, hull);
    door(g, "left", 0.7, 0.7, 2.6, 2.6, 6, 1.3, 0.5, 16, "open", { frame: HULL_DARK, leaf: HULL, dark: "#0b1020", bar: WARN });
    prism(g, 1.2, 1.2, 1.6, 1.6, 156, 8, hullDark);
    const [tx, ty] = P(2, 2, 172);
    glow(g, tx, ty, 14, "rgba(103,232,249,0.8)");
  },
  // Fabrication Bay: a wide hangar, open bay door, a crane arm.
  workshop(g) {
    pad(g, 4);
    prism(g, 0.4, 0.8, 3.2, 2.6, 6, 56, hull);
    // Hangar roof, a low arch approximated by two slopes.
    prism(g, 0.5, 1.2, 3.0, 1.8, 62, 12, hullDark);
    wallQuad(g, "left", 0.4, 0.8, 3.2, 2.6, 0.6, 2.6, 6, 50, "#0c111c");
    for (let i = 0; i < 6; i++) wallQuad(g, "left", 0.4, 0.8, 3.2, 2.6, 0.6 + i * 0.34, 0.74 + i * 0.34, 50, 56, i % 2 ? WARN : "#111827");
    windows(g, 0.4, 0.8, 3.2, 0.001, 6, 56, 1, 0.1, "#fde68a");
    pole(g, 3.4, 0.9, 6, 110, WARN, 3);
    seg(g, [3.4, 0.9, 116], [1.6, 0.9, 116], WARN, 3);
    seg(g, [1.8, 0.9, 116], [1.8, 0.9, 84], "#e5e7eb", 1);
    prism(g, 1.65, 0.8, 0.3, 0.3, 74, 10, faces("#f59e0b"));
  },
  // Comms Array: a big dish on a mast.
  stage(g) {
    pad(g, 4);
    prism(g, 1.2, 1.2, 1.6, 1.6, 6, 30, hull);
    windows(g, 1.2, 1.2, 1.6, 1.6, 6, 30, 1, 2, "#bae6fd");
    pole(g, 2, 2, 36, 60, "#cbd5e1", 4);
    const [dx, dy] = P(2, 2, 110);
    g.save();
    g.translate(dx, dy);
    g.rotate(-0.5);
    g.fillStyle = "#e2e8f0";
    g.beginPath();
    g.ellipse(0, 0, 54, 22, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#94a3b8";
    g.beginPath();
    g.ellipse(4, 3, 44, 16, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#475569";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-18, -34);
    g.stroke();
    g.restore();
    glow(g, dx - 18, dy - 34, 10, "rgba(248,113,113,0.9)");
  },
  // Hydroponics: a glass dome over green.
  garden(g) {
    pad(g, 4);
    groundEllipse(g, 2, 2, 1.55, 6, "#14532d");
    for (let i = 0; i < 14; i++) {
      const r = rng(i + 3);
      const [x, y] = P(1.1 + r() * 1.8, 1.1 + r() * 1.8, 6);
      g.fillStyle = i % 3 ? "#4ade80" : "#86efac";
      g.fillRect(x - 3, y - 10, 6, 10);
      g.fillStyle = "#166534";
      g.fillRect(x - 1, y - 4, 2, 4);
    }
    dome(g, 2, 2, 1.55, 6, 70, { top: "rgba(224,242,254,0.55)", left: "rgba(125,211,252,0.28)", right: "rgba(14,116,144,0.35)" }, 0.9);
    const [hx, hy] = P(2, 2, 80);
    g.strokeStyle = "rgba(224,242,254,0.6)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(hx - 70, hy + 70);
    g.quadraticCurveTo(hx, hy - 50, hx + 70, hy + 70);
    g.stroke();
  },
  // Mission Board: a console module with a wall of status screens.
  board(g) {
    pad(g, 4);
    prism(g, 0.6, 1.4, 2.8, 1.6, 6, 26, hull);
    prism(g, 0.8, 1.2, 2.4, 0.3, 32, 64, panel);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const colour = (r + c) % 4 === 0 ? "#fbbf24" : (r * c) % 3 === 1 ? "#34d399" : "#38bdf8";
        wallQuad(g, "left", 0.8, 1.2, 2.4, 0.3, 0.15 + c * 0.56, 0.6 + c * 0.56, 38 + r * 19, 52 + r * 19, colour);
      }
    }
    pole(g, 0.9, 1.5, 96, 16, "#cbd5e1", 2);
    pole(g, 3.1, 1.5, 96, 16, "#cbd5e1", 2);
  },
};

const landmarkB = bakery<CivicRoom>((room) => bakeAnchored(4, 4, 220, LANDMARK[room]));

/* ---- access-level modules -------------------------------------------- */

const DOOR = { frame: HULL_DARK, leaf: "#64748b", dark: "#05070d", bar: WARN };

const BUILDING: Record<AccessLevel, (g: Ctx) => void> = {
  // SEALED: blank hull, airlock shut and cross-barred, a padlock over it.
  private(g) {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    prism(g, 0.4, 0.4, 2.2, 2.2, 0, 64, faces("#6b7280"));
    for (let k = 0; k < 3; k++) wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, 0.1, 2.1, 14 + k * 18, 16 + k * 18, "rgba(0,0,0,0.25)");
    door(g, "left", 0.4, 0.4, 2.2, 2.2, 0, 1.1, 0.6, 30, "sealed", { ...DOOR, bar: RED_LOCK });
    prism(g, 0.8, 0.8, 1.4, 1.4, 64, 8, hullDark);
    const [lx, ly] = P(1.5, 2.6, 46);
    lockMark(g, lx, ly, RED_LOCK, "#f8fafc");
  },
  // VIEWPORT: a glass wall you can see the lit interior through; hatch shut.
  public_view(g) {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    prism(g, 0.4, 0.4, 2.2, 2.2, 0, 60, faces("#94a3b8"));
    wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, 0.15, 2.05, 36, 56, "#fde68a");
    wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, 0.15, 2.05, 36, 56, GLASS);
    wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, 0.15, 2.05, 36, 56, "#fcd34d");
    wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, 0.15, 2.05, 36, 56, GLASS);
    for (let i = 1; i < 4; i++) wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, i * 0.52, i * 0.52 + 0.04, 36, 56, HULL_DARK);
    door(g, "left", 0.4, 0.4, 2.2, 2.2, 0, 1.1, 0.5, 28, "shut", DOOR);
    prism(g, 0.7, 0.7, 1.6, 1.6, 60, 6, hullDark);
  },
  // OPEN DOCK: a deck, a docking arch, landing lights. Nothing to keep you out.
  public_write(g) {
    shadow(g, 0.2, 0.2, 2.6, 2.6);
    prism(g, 0.2, 0.2, 2.6, 2.6, 0, 6, faces("#475569"));
    for (let i = 0; i < 6; i++) {
      const [x, y] = P(0.3 + i * 0.48, 2.7, 6);
      g.fillStyle = i % 2 ? "#4ade80" : "#bbf7d0";
      g.fillRect(x - 2, y - 1, 3, 2);
    }
    pole(g, 0.7, 2.3, 6, 58, "#cbd5e1", 4);
    pole(g, 2.3, 2.3, 6, 58, "#cbd5e1", 4);
    seg(g, [0.7, 2.3, 64], [2.3, 2.3, 64], "#cbd5e1", 4);
    pole(g, 2.3, 0.7, 6, 58, "#94a3b8", 3);
    seg(g, [2.3, 0.7, 64], [2.3, 2.3, 64], "#94a3b8", 3);
    const [gx, gy] = P(1.5, 2.3, 64);
    glow(g, gx, gy, 12, "rgba(74,222,128,0.9)");
    prism(g, 1.1, 0.8, 0.6, 0.5, 6, 10, faces("#64748b"));
  },
};

const buildingB = bakery<AccessLevel>((a) => bakeAnchored(3, 3, 130, BUILDING[a]));

const scaffoldB = bakery<ScaffoldStage>((stage) =>
  bakeAnchored(3, 3, 130, (g) => {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    slab(g, 0.4, 0.4, 2.2, 2.2, 0, "#334155", "rgba(251,191,36,0.6)");
    const h = stage === 1 ? 24 : stage === 2 ? 44 : 60;
    if (stage >= 2) prism(g, 0.5, 0.5, 2.0, 2.0, 0, h * 0.55, faces("#6b7280"));
    if (stage === 3) prism(g, 0.5, 0.5, 2.0, 2.0, h * 0.55, h * 0.3, faces("#94a3b8"));
    wireBox(g, 0.4, 0.4, 2.2, 2.2, 0, h, WARN, 2);
    if (stage >= 2) seg(g, [0.4, 2.6, 0], [2.6, 2.6, h], WARN, 1);
    pole(g, 2.8, 0.5, 0, h + 40, "#e5e7eb", 2);
    seg(g, [2.8, 0.5, h + 40], [1.5, 0.5, h + 40], "#e5e7eb", 2);
  }),
);

/* ---- props -------------------------------------------------------------- */

const PROP_ART: Record<PropKey, (g: Ctx) => void> = {
  lantern(g) {
    // A beacon pole: the light source.
    prism(g, 0.42, 0.42, 0.16, 0.16, 0, 4, faces("#475569"));
    pole(g, 0.5, 0.5, 4, 42, "#94a3b8", 3);
    const [x, y] = P(0.5, 0.5, 50);
    g.fillStyle = "#e0f2fe";
    g.fillRect(x - 3, y - 3, 6, 6);
    glow(g, x, y, 9, "rgba(186,230,253,0.8)");
  },
  bench(g) {
    prism(g, 0.2, 0.35, 0.6, 0.3, 0, 8, faces("#64748b"));
    prism(g, 0.2, 0.3, 0.6, 0.08, 8, 10, faces("#475569"));
  },
  planter(g) {
    cylinder(g, 0.5, 0.5, 0.22, 0, 14, faces("#64748b"));
    groundEllipse(g, 0.5, 0.5, 0.18, 14, "#22c55e");
    const [x, y] = P(0.5, 0.5, 14);
    g.fillStyle = "#86efac";
    g.fillRect(x - 3, y - 12, 2, 10);
    g.fillRect(x + 2, y - 9, 2, 7);
  },
  crates(g) {
    prism(g, 0.15, 0.2, 0.45, 0.45, 0, 20, faces("#d97706"));
    prism(g, 0.55, 0.45, 0.35, 0.35, 0, 14, faces("#475569"));
    wallQuad(g, "left", 0.15, 0.2, 0.45, 0.45, 0.05, 0.4, 8, 11, "#111827");
  },
  signpost(g) {
    // A nav antenna with a status panel.
    pole(g, 0.5, 0.5, 0, 52, "#cbd5e1", 2);
    prism(g, 0.3, 0.46, 0.4, 0.06, 30, 16, faces("#0f172a"));
    wallQuad(g, "left", 0.3, 0.46, 0.4, 0.06, 0.05, 0.35, 34, 42, CYAN);
    const [x, y] = P(0.5, 0.5, 54);
    glow(g, x, y, 5, "rgba(248,113,113,0.9)");
  },
  brazier(g) {
    // A reactor vent: the heat source.
    cylinder(g, 0.5, 0.5, 0.28, 0, 16, faces("#52525b"));
    groundEllipse(g, 0.5, 0.5, 0.2, 16, "#fb923c");
    const [x, y] = P(0.5, 0.5, 18);
    glow(g, x, y - 4, 16, "rgba(251,146,60,0.75)");
  },
  wellstone(g) {
    // A coolant tank: the water feature.
    cylinder(g, 0.5, 0.5, 0.32, 0, 18, faces("#94a3b8"));
    groundEllipse(g, 0.5, 0.5, 0.26, 18, "#0ea5e9");
    groundEllipse(g, 0.45, 0.45, 0.1, 18, "rgba(224,242,254,0.6)");
  },
  rubble(g) {
    // Asteroid debris.
    const r = rng(7);
    for (let i = 0; i < 4; i++) {
      const [x, y] = P(0.25 + r() * 0.5, 0.25 + r() * 0.5);
      g.fillStyle = i % 2 ? "#57534e" : "#78716c";
      g.beginPath();
      g.ellipse(x, y - 3, 6 - i, 4 - i * 0.5, 0.3, 0, Math.PI * 2);
      g.fill();
    }
  },
};

const propB = bakery<PropKey>((k) => bakeAnchored(1, 1, 70, PROP_ART[k]));

/* ---- bodies, critters, items ------------------------------------------ */

const ASTRONAUT: FigureSpec = {
  skin: "#f1f5f9",
  head: "helmet",
  headColour: "#f8fafc",
  visor: "#f59e0b",
  torso: "#e2e8f0",
  legs: "#cbd5e1",
  accent: "#f59e0b",
  shoulders: "#f59e0b",
};

const ROBOT: FigureSpec = {
  skin: "#a78bfa",
  head: "box",
  headColour: "#8b5cf6",
  torso: "#6d28d9",
  legs: "#4c1d95",
  accent: CYAN,
  eyes: CYAN,
  antenna: CYAN,
};

const bodyB = bakery<CharKey>((k) => bakeFigure(k.startsWith("human") ? ASTRONAUT : ROBOT, stanceOf(k)));

/** A satellite: body, two solar panels, a blinking light. */
const ambientB = bakery<AmbientPose>((pose) =>
  bakeGrid(20, 20, 2, 20, 20, (px) => {
    const tilt = pose === "walk-a" ? -1 : pose === "walk-b" ? 1 : 0;
    const folded = pose === "graze";
    px(8, 7, 4, 5, "#e2e8f0");
    px(8, 11, 4, 1, "#94a3b8");
    px(9, 5, 1, 2, "#cbd5e1");
    if (folded) {
      px(5, 8, 3, 3, "#1d4ed8");
      px(12, 8, 3, 3, "#1d4ed8");
    } else {
      px(1, 8 + tilt, 7, 3, "#2563eb");
      px(12, 8 - tilt, 7, 3, "#2563eb");
      px(1, 9 + tilt, 7, 1, "#60a5fa");
      px(12, 9 - tilt, 7, 1, "#60a5fa");
    }
    px(10, 4, 1, 1, pose === "idle" ? "#f87171" : "#fecaca");
    px(8, 17, 4, 1, "rgba(0,0,0,0.25)");
  }),
);

const ITEM_ART: Record<ItemKey, Parameters<typeof bakeGrid>[5]> = {
  // datapad
  document(px) {
    px(3, 2, 7, 9, "#0f172a");
    px(4, 3, 5, 6, "#38bdf8");
    px(5, 4, 3, 1, "#e0f2fe");
    px(5, 6, 2, 1, "#e0f2fe");
  },
  // spanner
  tool(px) {
    px(2, 2, 3, 3, "#cbd5e1");
    px(3, 3, 1, 1, "#0f172a");
    px(4, 4, 2, 2, "#94a3b8");
    px(6, 6, 2, 2, "#94a3b8");
    px(8, 8, 2, 2, "#fbbf24");
  },
  // light orb
  lamp(px) {
    px(4, 3, 5, 5, "#a78bfa");
    px(5, 4, 3, 3, "#ede9fe");
    px(5, 8, 3, 2, "#475569");
  },
  // sample vial with a sprout
  seedling(px) {
    px(4, 5, 4, 6, "#e0f2fe");
    px(5, 7, 2, 3, "#4ade80");
    px(5, 2, 1, 3, "#22c55e");
    px(6, 3, 2, 1, "#86efac");
  },
};

const itemB = bakery<ItemKey>((k) => bakeGrid(12, 12, 2, 12, 12, ITEM_ART[k]));

/* ---- backdrop ----------------------------------------------------------- */

let starfield: { c: HTMLCanvasElement; w: number; h: number } | null = null;

function starsFor(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const W = Math.ceil(w / 256) * 256;
  const H = Math.ceil(h / 256) * 256;
  if (starfield && starfield.w === W && starfield.h === H) return starfield.c;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#02030a");
    grad.addColorStop(1, "#0a0f24");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const r = rng(4242);
    const n = Math.round((W * H) / 2600);
    for (let i = 0; i < n; i++) {
      const b = r();
      g.fillStyle = b > 0.93 ? "#fde68a" : b > 0.8 ? "#bae6fd" : "rgba(255,255,255,0.55)";
      const s = b > 0.97 ? 2 : 1;
      g.fillRect(Math.floor(r() * W), Math.floor(r() * H), s, s);
    }
    // A far nebula smear, once.
    const neb = g.createRadialGradient(W * 0.78, H * 0.22, 0, W * 0.78, H * 0.22, Math.max(W, H) * 0.35);
    neb.addColorStop(0, "rgba(124,58,237,0.16)");
    neb.addColorStop(1, "rgba(124,58,237,0)");
    g.fillStyle = neb;
    g.fillRect(0, 0, W, H);
  }
  starfield = { c, w: W, h: H };
  return c;
}

/* ---- the art ------------------------------------------------------------ */

function stampOr(ctx: Ctx, b: Baked | null, x: number, y: number): boolean {
  if (!b) return false;
  stamp(ctx, b, x, y);
  return true;
}

/** Speech: the look is the theme's; a whisper keeps violet and a dashed edge in every theme. */
const SPEECH_STYLE = { bg: "rgba(2,6,23,0.92)", fg: "#a5f3fc", border: "rgba(103,232,249,0.55)", radius: 2, whisperBg: "rgba(30,16,56,0.94)", whisperFg: "#e9d5ff", whisperBorder: "rgba(216,180,254,0.9)" } as const;

/**
 * A hull placard on a short strut, rivets in the corners and the mission
 * colour as a patch down its left edge. Held: a blast-shutter grey with a padlock.
 */
export const SIGN_STYLE: SignStyle = {
  board: "rgba(15,23,42,0.94)",
  edge: "rgba(103,232,249,0.6)",
  title: "#a5f3fc",
  detail: "rgba(203,213,225,0.8)",
  heldBoard: "rgba(42,50,70,0.96)",
  heldTitle: "rgba(203,213,225,0.7)",
  lock: { body: HULL_DARK, shackle: "#e2e8f0" },
  radius: 0,
  mark: { plate: "#1e3a5f", rim: "rgba(103,232,249,0.8)", glyph: "#e0f2fe", shape: "round" },
  tintAt: "left",
  fixings(ctx, x0, y0, w) {
    ctx.fillStyle = HULL_DARK;
    ctx.fillRect(x0 + Math.round(w / 2) - 1, y0 - 6, 3, 6);
    ctx.fillRect(x0 + Math.round(w / 2) - 5, y0 - 7, 11, 2);
  },
  trim(ctx, x0, y0, w, h, held) {
    ctx.fillStyle = held ? "rgba(148,163,184,0.5)" : "rgba(103,232,249,0.7)";
    ctx.fillRect(x0 + 5, y0 + 2, 1, 1);
    ctx.fillRect(x0 + w - 3, y0 + 2, 1, 1);
    ctx.fillRect(x0 + 5, y0 + h - 3, 1, 1);
    ctx.fillRect(x0 + w - 3, y0 + h - 3, 1, 1);
    if (held) {
      ctx.fillStyle = "rgba(7,8,20,0.35)";
      for (let y = y0 + 3; y < y0 + h - 2; y += 3) ctx.fillRect(x0 + 2, y, w - 4, 1);
    }
  },
};

/**
 * An estate: a station, modules docked together. A hull mount with a mission
 * banner crest; a lit perimeter walkway of beacons.
 */
export const ESTATE_STYLE: EstateStyle = {
  frame: "rgba(30,41,59,0.96)",
  frameEdge: "rgba(103,232,249,0.7)",
  crest: "#a5f3fc",
  crestShape: "chevron",
  fence: { rail: "rgba(103,232,249,0.75)", post: "#e0f2fe", width: 2, dash: [6, 4] },
};

const art: ThemeArt = {
  async prepare() {
    /* Procedural: everything bakes on first use. */
  },
  backdrop(ctx, w, h) {
    const c = starsFor(w, h);
    if (c) ctx.drawImage(c, 0, 0);
  },
  ground(ctx, region, x, y, tx, ty) {
    const v = region === "wild" ? (tx * 7 + ty * 13) % 5 === 0 : (tx + ty) % 2 === 0;
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
    // Satellites drift rather than walk: a slow bob, lifted off the ground.
    const bob = Math.sin(t / 700 + x * 0.05) * 3 - 8;
    ctx.save();
    ctx.translate(x, y + bob);
    if (flip) ctx.scale(-1, 1);
    stamp(ctx, b, 0, 0);
    ctx.restore();
  },
  carry(ctx, item, x, y) {
    return stampOr(ctx, itemB(item), x, y);
  },
  glyph: drawVerbGlyph,
  pennant(ctx, colour, x, y) {
    // A mission beacon: an antenna with a square patch in the org colour.
    ctx.save();
    ctx.translate(x - 22, y - 4);
    ctx.fillStyle = "rgba(7,8,20,0.8)";
    ctx.fillRect(-1.5, -22, 3, 22);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillRect(-0.5, -22, 1, 22);
    ctx.fillStyle = "rgba(7,8,20,0.85)";
    ctx.fillRect(-12, -22, 11, 9);
    ctx.fillStyle = colour;
    ctx.fillRect(-11, -21, 9, 7);
    ctx.restore();
  },
  hazard: drawHazardTriangle,
  speech(ctx, bubble) {
    drawSpeechBubble(ctx, bubble, SPEECH_STYLE);
  },
  speechPip(ctx, sx, sy, whisper) {
    drawSpeechPip(ctx, sx, sy, whisper, { fg: "rgba(165,243,252,0.8)", whisperFg: SPEECH_STYLE.whisperFg });
  },
  signboard(ctx, board) {
    drawSignboard(ctx, board, SIGN_STYLE);
  },
  estateSign(ctx, board) {
    drawEstateSign(ctx, board, SIGN_STYLE, ESTATE_STYLE);
  },
  estateFence(ctx, segments, accent) {
    drawEstateFence(ctx, segments, accent, ESTATE_STYLE);
  },
};

export const SPACE_LEXICON: ThemeLexicon = {
  name: "Space",
  blurb: "An orbital station on a rock. Crew in suits, robots, drifting satellites.",
  resource: { name: "credits", coin: "#67e8f9", rim: "#155e75" },
  eyebrow: "Glasshouse Station",
  headline: "The station grows as they do.",
  subline: "Idle crew hold station. Awake ones compute, fabricate, wait, or transmit.",
  skyPlace: "on station time",
  aHuman: "Crew (a person)",
  anAgent: "Service unit (an agent)",
  bodies: "crew",
  regions: {
    plaza: { title: "Bridge", bookmark: "Bridge — where the station talks" },
    library: { title: "Data Core", bookmark: "Data Core — where crew read" },
    workshop: { title: "Fabrication Bay", bookmark: "Fabrication Bay — where the tools run" },
    stage: { title: "Comms Array", bookmark: "Comms Array — what is on" },
    garden: { title: "Hydroponics", bookmark: "Hydroponics — where idle crew go" },
    board: { title: "Mission Board", bookmark: "Mission Board — faults and notices" },
  },
  access: {
    private: { label: "sealed", blurb: "Sealed airlock. The station says the module is taken, and nothing else." },
    public_view: { label: "viewport", blurb: "Viewport only. Anyone may look in; only its crew transmit here." },
    public_write: { label: "open dock", blurb: "Open dock — anyone with a body may come aboard and speak." },
  },
  accessUnknown: "Somebody holds this module.",
  claimedPlot: "claimed module",
  heldPlot: "Held module",
  resting: "docked, powered down",
  estate: { label: "Station", plots: "modules" },
  inTrial: "on a trial run at the Comms Array",
  construction: "fabricating",
  bell: { faulted: "faulted", stalled: "stalled", fading: "losing signal", idle: "idle crew", allBusy: "all crew at stations" },
  hud: { hereNow: "aboard", watching: "on the feed", awake: "on duty", asleep: "in cryo", fog: "scan", world: "sector", claimed: "modules", quiet: "no transmissions recently" },
  legend: ["fabricate", "compute", "transmit", "wait", "blocked", "fault", "cryo", "fading"],
  card: { workingOn: "Current task", lookingFor: "Seeking", latest: "Last log", links: "Channels", fromToolCalls: "from its tool telemetry", fromPulse: "from its beacon", empty: "No log entries yet.", walkOver: "Plot a course", follow: "Track", following: "Tracking", message: "Send a message" },
  controls: {
    goTo: "set course",
    busiest: "Busiest",
    busiestTitle: "Busiest section right now",
    mySpace: "My module",
    mySpaceTitle: "My module — the one I hold",
    kiosk: "Kiosk",
    tv: "Broadcast",
    onAir: "Transmitting",
    following: "Tracking",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
  postcard: { button: "Postcard", buttonTitle: "Save a still of this view to this device. Nothing is transmitted.", greeting: "Transmission from", world: "Glasshouse Station", replay: "Archive" },
  marks: { heading: "Mission patches", thousand_calls: "A thousand tool calls logged aboard", week_streak: "Seven consecutive days on shift", trial: "A crew member here completed a Comms Array trial" },
};

export const SPACE_PALETTE: ThemePalette = {
  plotTint: {
    private: "rgba(239,68,68,0.22)",
    public_view: "rgba(56,189,248,0.22)",
    public_write: "rgba(74,222,128,0.2)",
  },
  fog: "rgba(0,0,6,0.8)",
  plotEdge: "rgba(103,232,249,0.3)",
  coreGrid: "rgba(103,232,249,0.1)",
  plotName: "#a5f3fc",
  nameFill: "#e0f2fe",
  paperclipNameFill: "#c4b5fd",
  departRing: "rgba(186,230,253,0.85)",
  placeholder: { human: "#f59e0b", agent: "#8b5cf6" },
  glow: ["rgba(207,250,254,0.85)", "rgba(103,232,249,0.3)", "rgba(34,211,238,0)"],
  daylight: "rgb(96,110,140)",
  card: { bg: "rgba(2,6,23,0.95)", title: "#a5f3fc", text: "rgba(224,242,254,0.8)" },
  chrome: {
    dusk950: "2 4 12",
    dusk900: "8 13 28",
    dusk800: "15 23 42",
    dusk700: "30 41 59",
    lantern300: "165 243 252",
    lantern400: "103 232 249",
    lantern500: "34 211 238",
  },
  displayFont: '"Space Grotesk", "Source Sans 3", ui-sans-serif, system-ui, sans-serif',
};

export const space = {
  id: "space",
  lexicon: SPACE_LEXICON,
  palette: SPACE_PALETTE,
  art,
} satisfies Theme;

