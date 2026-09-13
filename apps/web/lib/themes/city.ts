/**
 * City — a downtown block at dusk.
 *
 * Pavers, brick and asphalt in the core, empty lots beyond it. Citizens walk
 * the streets; agents are courier bots. Pigeons peck where the sheep graze.
 * Access levels: a GATED LOT (a wall, a shut gate, a padlock, a building with
 * no ground-floor windows behind it), a GLASS LOBBY (a glass-fronted office you
 * can see into, doors shut), an OPEN PARK (a pavilion roof on posts, no walls).
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
  door,
  drawSpeechBubble,
  drawSignboard,
  drawSpeechPip,
  drawHazardTriangle,
  drawVerbGlyph,
  faces,
  gableX,
  glow,
  groundEllipse,
  lockMark,
  P,
  pole,
  prism,
  pyramid,
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
  type SignStyle,
} from "./kit";
import type { AmbientPose, Theme, ThemeArt, ThemeLexicon, ThemePalette } from "./types";

const TAXI = "#facc15";
const LIT = (i: number) => (i % 4 === 1 ? "#1f2937" : i % 3 === 0 ? "#fde68a" : "#fef3c7");

/* ---- ground ------------------------------------------------------------ */

const groundB = bakery<string>((key) => {
  const [region, variant] = key.split(":") as [MapRegion, string];
  const v = Number(variant);
  return bakeTile((g) => {
    switch (region) {
      case "plaza": // light square pavers
        tileFill(g, v ? "#8b8680" : "#85807a");
        tileLine(g, 0.5, 0, 0.5, 1, "rgba(0,0,0,0.18)");
        tileLine(g, 0, 0.5, 1, 0.5, "rgba(0,0,0,0.18)");
        break;
      case "library": // warm brick paving
        tileFill(g, "#7a4a3a");
        for (let i = 1; i < 4; i++) tileLine(g, 0, i / 4, 1, i / 4, "rgba(0,0,0,0.22)");
        for (let i = 0; i < 4; i++) tileLine(g, (i + (v ? 0.5 : 0)) / 2, i / 4, (i + (v ? 0.5 : 0)) / 2, (i + 1) / 4, "rgba(0,0,0,0.18)");
        break;
      case "workshop": // asphalt yard with a painted bay line
        tileFill(g, "#3a3b3f");
        speckle(g, 5 + v, 14, ["#4b4d52", "#2d2e31"], 1);
        if (v) tileLine(g, 0.1, 0.9, 0.9, 0.9, "rgba(250,204,21,0.7)", 2);
        break;
      case "stage": // theatre-district red tile
        tileFill(g, "#6b2f3a");
        tileLine(g, 0.5, 0, 0.5, 1, "rgba(0,0,0,0.2)");
        tileLine(g, 0, 0.5, 1, 0.5, "rgba(0,0,0,0.2)");
        break;
      case "garden": // mown park grass
        tileFill(g, v ? "#3f7a3a" : "#3b7336");
        speckle(g, 17 + v, 12, ["#4e8f45", "#34652f"], 2);
        break;
      case "board": // concrete
        tileFill(g, "#6b6e73");
        speckle(g, 23 + v, 10, ["#7a7d82", "#5c5f63"], 1);
        tileLine(g, 0, 0, 1, 0, "rgba(0,0,0,0.2)");
        break;
      default: // empty lots: patchy grass and dirt
        tileFill(g, v ? "#4a5a36" : "#465433");
        speckle(g, 29 + v, 16, ["#5a6b40", "#6b5a3e", "#3b472b"], 2);
        tileLine(g, 0, 0, 1, 0, "rgba(255,255,255,0.05)");
    }
  });
});

const pathB = bakery<number>((mask) =>
  bakePath(mask, "#2b2c30", "#9ca3af", 0.52, (g) => {
    // Lane markings: a dash along each arm that continues.
    const dash = (x0: number, y0: number, x1: number, y1: number) => tileLine(g, x0, y0, x1, y1, "rgba(250,250,250,0.7)", 1);
    if (mask & 1) dash(0.5, 0.05, 0.5, 0.3);
    if (mask & 4) dash(0.5, 0.7, 0.5, 0.95);
    if (mask & 2) dash(0.7, 0.5, 0.95, 0.5);
    if (mask & 8) dash(0.05, 0.5, 0.3, 0.5);
  }),
);

const scatterB = bakery<ScatterKey>((key) =>
  bakeTile((g) => {
    const r = rng(key.length * 17 + key.charCodeAt(1));
    const at = () => P(0.2 + r() * 0.6, 0.2 + r() * 0.6);
    if (key === "pebbles") {
      for (let i = 0; i < 3; i++) {
        const [x, y] = at();
        g.fillStyle = "#d4d4d8";
        g.fillRect(x, y, 2, 1);
      }
    } else if (key === "leaves") {
      for (let i = 0; i < 4; i++) {
        const [x, y] = at();
        g.fillStyle = i % 2 ? "#b45309" : "#d97706";
        g.fillRect(x, y, 2, 2);
      }
    } else if (key === "tuft") {
      const [x, y] = at();
      g.fillStyle = "#4d7c0f";
      g.fillRect(x - 2, y - 3, 1, 3);
      g.fillRect(x, y - 4, 1, 4);
      g.fillRect(x + 2, y - 3, 1, 3);
    } else if (key === "flowers") {
      for (let i = 0; i < 4; i++) {
        const [x, y] = at();
        g.fillStyle = ["#f472b6", "#fde047", "#f8fafc"][i % 3]!;
        g.fillRect(x, y, 2, 2);
      }
    } else if (key === "crack") {
      tileLine(g, 0.25, 0.4, 0.65, 0.3, "rgba(0,0,0,0.35)");
    } else if (key === "puddle") {
      groundEllipse(g, 0.5, 0.5, 0.15, 0, "rgba(148,163,184,0.45)");
    }
  }),
);

/* ---- landmarks --------------------------------------------------------- */

function kerb(g: Ctx, n: number): void {
  shadow(g, 0.2, 0.2, n - 0.4, n - 0.4);
  prism(g, 0.15, 0.15, n - 0.3, n - 0.3, 0, 4, faces("#9ca3af"));
}

const LANDMARK: Record<CivicRoom, (g: Ctx) => void> = {
  // Downtown Square: a clock tower over a low civic hall.
  plaza(g) {
    kerb(g, 4);
    prism(g, 0.5, 1.6, 3.0, 1.9, 4, 34, faces("#d6cfc2"));
    windows(g, 0.5, 1.6, 3.0, 1.9, 4, 34, 1, 2, LIT);
    prism(g, 0.4, 1.5, 3.2, 2.1, 38, 5, faces("#8b8378"));
    prism(g, 1.5, 0.5, 1.0, 1.0, 4, 120, faces("#b9ae9c"));
    windows(g, 1.5, 0.5, 1.0, 1.0, 20, 80, 3, 1, "#fef3c7");
    prism(g, 1.4, 0.4, 1.2, 1.2, 124, 18, faces("#e7e0d3"));
    // Clock faces.
    const face = (side: "left" | "right") => {
      const [x, y] = side === "left" ? P(2.0, 1.6, 133) : P(2.6, 1.0, 133);
      g.fillStyle = "#fffbeb";
      g.beginPath();
      g.ellipse(x, y, 6, 6, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#1f2937";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - 4);
      g.moveTo(x, y);
      g.lineTo(x + 3, y);
      g.stroke();
    };
    face("left");
    face("right");
    pyramid(g, 1.4, 0.4, 1.2, 1.2, 142, 34, faces("#3f6f5a"));
  },
  // Public Library: columns, steps and a pediment.
  library(g) {
    kerb(g, 4);
    prism(g, 0.4, 0.6, 3.2, 2.8, 4, 6, faces("#d1d5db"));
    prism(g, 0.7, 0.7, 2.6, 2.2, 10, 64, faces("#e7e0d3"));
    windows(g, 0.7, 0.7, 2.6, 2.2, 10, 64, 2, 1.4, LIT);
    for (let i = 0; i < 6; i++) {
      const u = 0.75 + i * 0.5;
      const [cx, cy] = P(u, 3.2, 10);
      g.fillStyle = "#f5f5f4";
      g.fillRect(cx - 3, cy - 56, 6, 56);
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.fillRect(cx + 1, cy - 56, 2, 56);
    }
    prism(g, 0.6, 0.6, 2.8, 2.8, 66, 8, faces("#d6d3d1"));
    gableX(g, 0.6, 0.6, 2.8, 2.8, 74, 30, faces("#a8a29e"));
    door(g, "left", 0.7, 0.7, 2.6, 2.2, 10, 1.3, 0.4, 26, "open", { frame: "#78716c", leaf: "#44403c", dark: "#1c1917", bar: "#a8a29e" });
  },
  // Works Yard: a sawtooth-roof factory and a chimney.
  workshop(g) {
    kerb(g, 4);
    prism(g, 0.4, 0.6, 3.0, 2.8, 4, 48, faces("#8b5a3c"));
    windows(g, 0.4, 0.6, 3.0, 2.8, 4, 48, 2, 1.6, LIT);
    for (let i = 0; i < 3; i++) gableX(g, 0.4, 0.6 + i * 0.93, 3.0, 0.93, 52, 18, faces("#57534e"));
    wallQuad(g, "left", 0.4, 0.6, 3.0, 2.8, 1.0, 2.0, 4, 34, "#27272a");
    for (let i = 0; i < 5; i++) wallQuad(g, "left", 0.4, 0.6, 3.0, 2.8, 1.0, 2.0, 6 + i * 6, 7 + i * 6, "#52525b");
    cylinder(g, 3.55, 0.75, 0.2, 4, 110, faces("#9a3412"));
    const [sx, sy] = P(3.55, 0.75, 118);
    glow(g, sx, sy - 6, 12, "rgba(209,213,219,0.45)");
  },
  // Theatre: a marquee with chaser lights.
  stage(g) {
    kerb(g, 4);
    prism(g, 0.6, 0.6, 2.8, 2.6, 4, 82, faces("#7f1d1d"));
    windows(g, 0.6, 0.6, 2.8, 2.6, 44, 38, 1, 1.5, "#fcd34d");
    // Marquee canopy jutting south.
    prism(g, 0.8, 3.2, 2.4, 0.5, 34, 12, faces("#111827"));
    for (let i = 0; i < 12; i++) {
      const [x, y] = P(0.85 + i * 0.2, 3.7, 40);
      g.fillStyle = i % 2 ? "#fde68a" : "#fbbf24";
      g.fillRect(x - 1, y - 1, 2, 2);
    }
    wallQuad(g, "left", 0.8, 3.2, 2.4, 0.5, 0.3, 2.1, 36, 44, "#fef3c7");
    prism(g, 1.6, 2.9, 0.4, 0.08, 84, 38, faces("#dc2626"));
    wallQuad(g, "left", 0.6, 0.6, 2.8, 2.6, 1.0, 1.8, 4, 30, "#1c1917");
  },
  // City Park: trees round a bandstand.
  garden(g) {
    slab(g, 0.2, 0.2, 3.6, 3.6, 0, "#3f7a3a");
    groundEllipse(g, 2, 2, 0.9, 0, "#a8a29e");
    prism(g, 1.45, 1.45, 1.1, 1.1, 0, 5, faces("#e7e5e4"));
    for (const [x, y] of [[1.5, 1.5], [2.55, 1.5], [1.5, 2.55], [2.55, 2.55]] as const) pole(g, x, y, 5, 28, "#f5f5f4", 2);
    pyramid(g, 1.35, 1.35, 1.3, 1.3, 33, 20, faces("#15803d"));
    const tree = (x: number, y: number, s: number) => {
      pole(g, x, y, 0, 14 * s, "#78350f", 3);
      const [cx, cy] = P(x, y, 26 * s);
      g.fillStyle = "#166534";
      g.beginPath();
      g.ellipse(cx, cy, 14 * s, 14 * s, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#22c55e";
      g.beginPath();
      g.ellipse(cx - 4 * s, cy - 4 * s, 8 * s, 7 * s, 0, 0, Math.PI * 2);
      g.fill();
    };
    tree(0.6, 0.7, 1.1);
    tree(3.3, 0.6, 1);
    tree(0.6, 3.3, 1);
    tree(3.4, 3.3, 1.15);
    tree(3.5, 2.0, 0.9);
  },
  // Notice Board: a civic annex with a big billboard on the roof.
  board(g) {
    kerb(g, 4);
    prism(g, 0.6, 1.0, 2.8, 2.4, 4, 40, faces("#9ca3af"));
    windows(g, 0.6, 1.0, 2.8, 2.4, 4, 40, 2, 1.5, LIT);
    pole(g, 1.2, 1.6, 44, 20, "#374151", 3);
    pole(g, 2.8, 1.6, 44, 20, "#374151", 3);
    prism(g, 0.8, 1.5, 2.4, 0.1, 62, 52, faces("#f8fafc"));
    const colours = ["#ef4444", "#3b82f6", "#f59e0b", "#10b981"];
    for (let i = 0; i < 4; i++) {
      wallQuad(g, "left", 0.8, 1.5, 2.4, 0.1, 0.15 + i * 0.58, 0.6 + i * 0.58, 70, 106, "#e5e7eb");
      wallQuad(g, "left", 0.8, 1.5, 2.4, 0.1, 0.2 + i * 0.58, 0.55 + i * 0.58, 92, 102, colours[i]!);
    }
  },
};

const landmarkB = bakery<CivicRoom>((room) => bakeAnchored(4, 4, 200, LANDMARK[room]));

/* ---- access-level lots ------------------------------------------------ */

const BUILDING: Record<AccessLevel, (g: Ctx) => void> = {
  // GATED LOT: a solid wall right round, a shut barred gate, a padlock, and
  // a tower behind it with nothing to see at street level.
  private(g) {
    shadow(g, 0.2, 0.2, 2.6, 2.6);
    const wall = faces("#78716c");
    // Back runs of the wall first, then the tower, then the front runs.
    prism(g, 0.2, 0.2, 2.6, 0.12, 0, 22, wall);
    prism(g, 0.2, 0.2, 0.12, 2.6, 0, 22, wall);
    prism(g, 0.9, 0.8, 1.4, 1.4, 0, 104, faces("#57534e"));
    windows(g, 0.9, 0.8, 1.4, 1.4, 50, 50, 2, 1.4, (i) => (i % 3 === 0 ? "#fde68a" : "#292524"));
    prism(g, 0.85, 0.75, 1.5, 1.5, 104, 5, faces("#44403c"));
    prism(g, 2.68, 0.2, 0.12, 2.6, 0, 22, wall);
    prism(g, 0.2, 2.68, 2.6, 0.12, 0, 22, wall);
    door(g, "left", 0.2, 2.68, 2.6, 0.12, 0, 1.3, 0.7, 18, "sealed", { frame: "#44403c", leaf: "#292524", dark: "#000", bar: "#dc2626" });
    const [lx, ly] = P(1.5, 2.8, 30);
    lockMark(g, lx, ly, "#dc2626", "#fafaf9");
  },
  // GLASS LOBBY: floor-to-ceiling glass, lit inside, doors shut.
  public_view(g) {
    shadow(g, 0.3, 0.3, 2.4, 2.4);
    prism(g, 0.4, 0.4, 2.2, 2.2, 0, 76, faces("#475569"));
    for (let r = 0; r < 3; r++) {
      const z0 = 4 + r * 24;
      wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, 0.08, 2.12, z0, z0 + 20, "#fde68a");
      wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, 0.08, 2.12, z0, z0 + 20, "#fcd34d");
      wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, 0.08, 2.12, z0, z0 + 20, "rgba(125,211,252,0.45)");
      wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, 0.08, 2.12, z0, z0 + 20, "rgba(56,189,248,0.4)");
    }
    for (let i = 1; i < 5; i++) {
      wallQuad(g, "left", 0.4, 0.4, 2.2, 2.2, i * 0.44 - 0.02, i * 0.44 + 0.02, 0, 76, "#334155");
      wallQuad(g, "right", 0.4, 0.4, 2.2, 2.2, i * 0.44 - 0.02, i * 0.44 + 0.02, 0, 76, "#1e293b");
    }
    door(g, "left", 0.4, 0.4, 2.2, 2.2, 0, 1.1, 0.46, 18, "shut", { frame: "#1e293b", leaf: "#64748b", dark: "#000", bar: "#e2e8f0" });
  },
  // OPEN PARK: a pavilion roof on four posts, benches, no walls.
  public_write(g) {
    slab(g, 0.2, 0.2, 2.6, 2.6, 0, "#4d8a42");
    groundEllipse(g, 1.5, 1.5, 0.8, 0, "#a8a29e");
    for (const [x, y] of [[0.8, 0.8], [2.2, 0.8], [0.8, 2.2], [2.2, 2.2]] as const) pole(g, x, y, 0, 42, "#fafaf9", 3);
    pyramid(g, 0.6, 0.6, 1.8, 1.8, 42, 20, faces("#f59e0b"));
    prism(g, 1.1, 1.9, 0.8, 0.2, 0, 6, faces("#92400e"));
    const [x, y] = P(2.7, 0.4, 0);
    g.fillStyle = "#166534";
    g.beginPath();
    g.ellipse(x, y - 22, 12, 12, 0, 0, Math.PI * 2);
    g.fill();
  },
};

const buildingB = bakery<AccessLevel>((a) => bakeAnchored(3, 3, 130, BUILDING[a]));

const scaffoldB = bakery<ScaffoldStage>((stage) =>
  bakeAnchored(3, 3, 150, (g) => {
    slab(g, 0.2, 0.2, 2.6, 2.6, 0, "#6b5a3e");
    const h = stage === 1 ? 24 : stage === 2 ? 50 : 72;
    if (stage >= 2) prism(g, 0.5, 0.5, 2.0, 2.0, 0, h * 0.5, faces("#9ca3af"));
    if (stage === 3) prism(g, 0.5, 0.5, 2.0, 2.0, h * 0.5, h * 0.35, faces("#d1d5db"));
    for (let k = 0; k <= stage; k++) wireBox(g, 0.4, 0.4, 2.2, 2.2, 0, (h * (k + 1)) / (stage + 1), "#f97316", 2);
    // A tower crane.
    pole(g, 2.8, 0.4, 0, h + 50, TAXI, 3);
    seg(g, [2.8, 0.4, h + 50], [0.6, 0.4, h + 50], TAXI, 3);
    seg(g, [1.2, 0.4, h + 50], [1.2, 0.4, h + 20], "#e5e7eb", 1);
    // Hoarding round the site.
    for (let i = 0; i < 5; i++) wallQuad(g, "left", 0.2, 0.2, 2.6, 2.6, i * 0.52 + 0.02, i * 0.52 + 0.48, 0, 10, i % 2 ? "#f97316" : "#fafaf9");
  }),
);

/* ---- props -------------------------------------------------------------- */

const PROP_ART: Record<PropKey, (g: Ctx) => void> = {
  lantern(g) {
    // Street lamp.
    pole(g, 0.5, 0.5, 0, 50, "#374151", 3);
    const [x, y] = P(0.5, 0.5, 50);
    g.fillStyle = "#374151";
    g.fillRect(x, y - 2, 10, 3);
    g.fillStyle = "#fef3c7";
    g.fillRect(x + 6, y + 1, 5, 3);
    glow(g, x + 8, y + 3, 9, "rgba(254,243,199,0.8)");
  },
  bench(g) {
    prism(g, 0.15, 0.4, 0.7, 0.2, 6, 3, faces("#92400e"));
    prism(g, 0.15, 0.35, 0.7, 0.06, 9, 10, faces("#92400e"));
    pole(g, 0.2, 0.6, 0, 6, "#1f2937", 2);
    pole(g, 0.8, 0.6, 0, 6, "#1f2937", 2);
  },
  planter(g) {
    prism(g, 0.25, 0.25, 0.5, 0.5, 0, 10, faces("#a8a29e"));
    pole(g, 0.5, 0.5, 10, 12, "#78350f", 2);
    const [x, y] = P(0.5, 0.5, 30);
    g.fillStyle = "#15803d";
    g.beginPath();
    g.ellipse(x, y, 11, 11, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#22c55e";
    g.beginPath();
    g.ellipse(x - 3, y - 3, 6, 5, 0, 0, Math.PI * 2);
    g.fill();
  },
  crates(g) {
    // A dumpster and a box.
    prism(g, 0.15, 0.3, 0.6, 0.4, 0, 16, faces("#15803d"));
    prism(g, 0.12, 0.27, 0.66, 0.46, 16, 2, faces("#166534"));
    prism(g, 0.6, 0.6, 0.3, 0.3, 0, 10, faces("#b45309"));
  },
  signpost(g) {
    pole(g, 0.5, 0.5, 0, 46, "#6b7280", 2);
    prism(g, 0.2, 0.47, 0.6, 0.06, 36, 8, faces("#15803d"));
    prism(g, 0.47, 0.2, 0.06, 0.6, 26, 8, faces("#15803d"));
  },
  brazier(g) {
    // A street-food cart with a warm grill: the heat source.
    prism(g, 0.2, 0.35, 0.6, 0.35, 4, 16, faces("#dc2626"));
    pole(g, 0.25, 0.4, 20, 18, "#e5e7eb", 1);
    pole(g, 0.75, 0.4, 20, 18, "#e5e7eb", 1);
    prism(g, 0.15, 0.3, 0.7, 0.45, 38, 3, faces("#fbbf24"));
    const [x, y] = P(0.5, 0.5, 22);
    glow(g, x, y, 14, "rgba(251,146,60,0.7)");
    groundEllipse(g, 0.3, 0.75, 0.06, 0, "#111827");
    groundEllipse(g, 0.7, 0.75, 0.06, 0, "#111827");
  },
  wellstone(g) {
    // A fountain.
    cylinder(g, 0.5, 0.5, 0.36, 0, 8, faces("#d6d3d1"));
    groundEllipse(g, 0.5, 0.5, 0.3, 8, "#38bdf8");
    pole(g, 0.5, 0.5, 8, 14, "#e7e5e4", 3);
    const [x, y] = P(0.5, 0.5, 24);
    g.fillStyle = "rgba(224,242,254,0.85)";
    g.fillRect(x - 5, y, 2, 6);
    g.fillRect(x + 3, y, 2, 6);
    g.fillRect(x - 1, y - 3, 2, 3);
  },
  rubble(g) {
    // Road works: traffic cones.
    for (const [cx, cy] of [[0.3, 0.4], [0.65, 0.35], [0.5, 0.7]] as const) {
      const [x, y] = P(cx, cy);
      g.fillStyle = "#f97316";
      g.beginPath();
      g.moveTo(x, y - 14);
      g.lineTo(x + 5, y);
      g.lineTo(x - 5, y);
      g.closePath();
      g.fill();
      g.fillStyle = "#fafafa";
      g.fillRect(x - 3, y - 7, 6, 2);
    }
  },
};

const propB = bakery<PropKey>((k) => bakeAnchored(1, 1, 70, PROP_ART[k]));

/* ---- bodies, critters, items ------------------------------------------ */

const CITIZEN: FigureSpec = {
  skin: "#e0b48a",
  head: "cap",
  headColour: "#1f2937",
  torso: "#d97706",
  legs: "#1e3a8a",
  accent: "#fde68a",
};

const COURIER_BOT: FigureSpec = {
  skin: "#c4b5fd",
  head: "dome",
  headColour: "#7c3aed",
  torso: "#6d28d9",
  legs: "#3b0764",
  accent: TAXI,
  eyes: "#a5f3fc",
  shoulders: "#a78bfa",
};

const bodyB = bakery<CharKey>((k) => bakeFigure(k.startsWith("human") ? CITIZEN : COURIER_BOT, stanceOf(k)));

/** A pigeon: grey body, iridescent neck, pecking on "graze". */
const ambientB = bakery<AmbientPose>((pose) =>
  bakeGrid(20, 20, 2, 20, 20, (px) => {
    const peck = pose === "graze";
    const step = pose === "walk-a" ? 0 : pose === "walk-b" ? 1 : 0;
    px(7, 11, 7, 4, "#9ca3af");
    px(6, 12, 2, 2, "#6b7280");
    px(8, 12, 4, 1, "#d1d5db");
    if (peck) {
      px(13, 13, 3, 3, "#6b7280");
      px(14, 14, 1, 1, "#22d3ee");
      px(16, 15, 1, 1, "#f59e0b");
    } else {
      px(12, 8, 3, 4, "#6b7280");
      px(12, 10, 2, 1, "#34d399");
      px(14, 9, 1, 1, "#111827");
      px(15, 9, 1, 1, "#f59e0b");
    }
    px(9 + step, 15, 1, 2, "#f87171");
    px(11 - step, 15, 1, 2, "#f87171");
    px(7, 17, 7, 1, "rgba(0,0,0,0.25)");
  }),
);

const ITEM_ART: Record<ItemKey, Parameters<typeof bakeGrid>[5]> = {
  // newspaper
  document(px) {
    px(2, 3, 8, 7, "#f5f5f4");
    px(3, 4, 6, 1, "#1c1917");
    px(3, 6, 3, 2, "#a8a29e");
    px(7, 6, 2, 1, "#78716c");
    px(7, 8, 2, 1, "#78716c");
  },
  // hammer
  tool(px) {
    px(2, 2, 6, 3, "#6b7280");
    px(4, 5, 2, 6, "#a16207");
  },
  // coffee to think on
  lamp(px) {
    px(3, 4, 6, 6, "#f5f5f4");
    px(3, 4, 6, 1, "#78350f");
    px(9, 5, 2, 3, "#f5f5f4");
    px(4, 1, 1, 2, "rgba(255,255,255,0.6)");
    px(6, 0, 1, 3, "rgba(255,255,255,0.6)");
  },
  // a potted plant
  seedling(px) {
    px(4, 7, 5, 4, "#c2410c");
    px(6, 3, 1, 4, "#15803d");
    px(4, 3, 2, 2, "#22c55e");
    px(7, 2, 2, 2, "#22c55e");
  },
};

const itemB = bakery<ItemKey>((k) => bakeGrid(12, 12, 2, 12, 12, ITEM_ART[k]));

/* ---- the art ------------------------------------------------------------ */

function stampOr(ctx: Ctx, b: Baked | null, x: number, y: number): boolean {
  if (!b) return false;
  stamp(ctx, b, x, y);
  return true;
}

/** Speech: the look is the theme's; a whisper keeps violet and a dashed edge in every theme. */
const SPEECH_STYLE = { bg: "rgba(250,250,249,0.95)", fg: "#1c1917", border: "rgba(28,25,23,0.7)", radius: 7, whisperBg: "rgba(237,233,254,0.96)", whisperFg: "#4c1d95", whisperBorder: "rgba(91,33,182,0.85)" } as const;

/**
 * A street-name sign: a rounded blade with an inset white keyline, bolted to
 * two brackets, the org colour as a band along the bottom. Held: a grey
 * "no entry" blade with a padlock.
 */
export const SIGN_STYLE: SignStyle = {
  board: "#14532d",
  edge: "rgba(250,250,249,0.85)",
  title: "#fafaf9",
  detail: "rgba(250,250,249,0.78)",
  heldBoard: "#3f3f46",
  heldTitle: "rgba(250,250,249,0.7)",
  lock: { body: "#71717a", shackle: "#fafaf9" },
  radius: 4,
  mark: { plate: "#a16207", rim: "#fafaf9", glyph: "#fefce8", shape: "square" },
  tintAt: "bottom",
  fixings(ctx, x0, y0, w) {
    ctx.fillStyle = "#6b7280";
    ctx.fillRect(x0 + 8, y0 - 6, 2, 6);
    ctx.fillRect(x0 + w - 10, y0 - 6, 2, 6);
  },
  trim(ctx, x0, y0, w, h) {
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x0 + 2.5, y0 + 2.5, w - 5, h - 5, 2);
    ctx.stroke();
  },
};

const art: ThemeArt = {
  async prepare() {
    /* Procedural: everything bakes on first use. */
  },
  backdrop() {
    /* The section background is the night beyond the city limits. */
  },
  ground(ctx, region, x, y, tx, ty) {
    const v = (tx * 3 + ty * 5) % 4 === 0;
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
  ambient(ctx, pose, x, y, flip) {
    const b = ambientB(pose);
    if (!b) return;
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    stamp(ctx, b, 0, 0);
    ctx.restore();
  },
  carry(ctx, item, x, y) {
    return stampOr(ctx, itemB(item), x, y);
  },
  glyph: drawVerbGlyph,
  pennant(ctx, colour, x, y) {
    // A lamp-post banner: a vertical flag hung from a crossbar.
    ctx.save();
    ctx.translate(x - 22, y - 4);
    ctx.fillStyle = "rgba(7,8,20,0.8)";
    ctx.fillRect(-1.5, -24, 3, 24);
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(-0.5, -24, 1, 24);
    ctx.fillRect(-9, -24, 9, 1);
    ctx.fillStyle = "rgba(7,8,20,0.85)";
    ctx.fillRect(-9, -23, 8, 13);
    ctx.fillStyle = colour;
    ctx.fillRect(-8, -23, 6, 11);
    ctx.restore();
  },
  hazard: drawHazardTriangle,
  speech(ctx, bubble) {
    drawSpeechBubble(ctx, bubble, SPEECH_STYLE);
  },
  speechPip(ctx, sx, sy, whisper) {
    drawSpeechPip(ctx, sx, sy, whisper, { fg: "rgba(250,250,249,0.9)", whisperFg: SPEECH_STYLE.whisperFg });
  },
  signboard(ctx, board) {
    drawSignboard(ctx, board, SIGN_STYLE);
  },
};

export const CITY_LEXICON: ThemeLexicon = {
  name: "City",
  blurb: "A downtown block at dusk. Citizens, courier bots and pigeons.",
  resource: { name: "dollars", coin: "#86efac", rim: "#166534" },
  eyebrow: "Glasshouse City",
  headline: "The city grows as they do.",
  subline: "Idle citizens loiter. Awake ones think, work, wait, or talk.",
  skyPlace: "downtown",
  aHuman: "A citizen (a person)",
  anAgent: "A courier bot (an agent)",
  bodies: "citizens",
  regions: {
    plaza: { title: "Downtown Square", bookmark: "Downtown Square — where the city talks" },
    library: { title: "Public Library", bookmark: "Public Library — where citizens read" },
    workshop: { title: "Works Yard", bookmark: "Works Yard — where the tools run" },
    stage: { title: "Theatre", bookmark: "Theatre — what is on" },
    garden: { title: "City Park", bookmark: "City Park — where idle citizens go" },
    board: { title: "Notice Board", bookmark: "Notice Board — faults and notices" },
  },
  access: {
    private: { label: "gated", blurb: "Gated and locked. The city says the lot is taken, and nothing else." },
    public_view: { label: "glass lobby", blurb: "Look through the glass. Anyone may watch; only its tenants speak here." },
    public_write: { label: "open park", blurb: "An open park — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this lot.",
  claimedPlot: "claimed lot",
  heldPlot: "Held lot",
  resting: "home for the night",
  construction: "under construction",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle", allBusy: "everyone's at work" },
  hud: { hereNow: "in town", watching: "watching", awake: "at work", asleep: "off shift", fog: "limits", world: "city", claimed: "lots", quiet: "the street is quiet" },
  legend: ["work", "think", "talk", "wait", "blocked", "fault", "off shift", "fading"],
  card: { workingOn: "Working on", lookingFor: "Looking for", latest: "Latest", links: "Links", fromToolCalls: "from its job log", fromPulse: "from its check-in", empty: "Nothing posted yet.", walkOver: "Walk over", follow: "Follow", following: "Following", message: "Leave a message" },
  controls: {
    goTo: "go to",
    busiest: "Busiest",
    busiestTitle: "Busiest block right now",
    mySpace: "My lot",
    mySpaceTitle: "My lot — the one I hold",
    kiosk: "Kiosk",
    tv: "TV",
    onAir: "Live",
    following: "Following",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
  postcard: { button: "Postcard", buttonTitle: "Save a postcard of this view to this device. Nothing is posted.", greeting: "Wish you were here, from", world: "Glasshouse City", replay: "Rerun" },
  marks: { heading: "Plaques", thousand_calls: "A thousand tool calls on this lot", week_streak: "Seven straight working days" },
};

export const CITY_PALETTE: ThemePalette = {
  plotTint: {
    private: "rgba(220,38,38,0.2)",
    public_view: "rgba(56,189,248,0.2)",
    public_write: "rgba(250,204,21,0.2)",
  },
  fog: "rgba(10,12,18,0.72)",
  plotEdge: "rgba(250,204,21,0.3)",
  coreGrid: "rgba(255,255,255,0.06)",
  plotName: "#fef08a",
  nameFill: "#fef9c3",
  paperclipNameFill: "#c4b5fd",
  departRing: "rgba(203,213,225,0.9)",
  placeholder: { human: "#d97706", agent: "#7c3aed" },
  glow: ["rgba(254,240,200,0.9)", "rgba(253,224,150,0.32)", "rgba(250,204,120,0)"],
  daylight: "rgb(170,178,190)",
  card: { bg: "rgba(17,17,20,0.94)", title: "#fef08a", text: "rgba(245,245,244,0.8)" },
  chrome: {
    dusk950: "14 15 19",
    dusk900: "24 25 31",
    dusk800: "39 41 50",
    dusk700: "55 58 70",
    lantern300: "254 240 138",
    lantern400: "250 204 21",
    lantern500: "234 179 8",
  },
  displayFont: 'Oswald, "Source Sans 3", ui-sans-serif, system-ui, sans-serif',
};

export const city = {
  id: "city",
  lexicon: CITY_LEXICON,
  palette: CITY_PALETTE,
  art,
} satisfies Theme;
