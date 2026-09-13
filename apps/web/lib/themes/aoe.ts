/**
 * Age of Empires — the reference theme.
 *
 * This is Grove as it looked and read before themes existed, moved behind the
 * contract without a pixel changed: the PNG set from tools/generate_art.py, the
 * sheep in the Garden, the stone keep / colonnade / market canopy for the three
 * access levels, and every word the map already said. It is the default, and it
 * is the theme every other one is measured against.
 */

import {
  ANIMAL_KEYS,
  BUILDING,
  CHAR_SRC,
  CIVIC,
  CIVIC_ROOMS,
  ITEM,
  ITEM_KEYS,
  PROP,
  PROP_KEYS,
  SCAFFOLD,
  SCATTER_KEYS,
  animalSrc,
  buildingSrc,
  civicSrc,
  drawAnchored,
  groundSrc,
  itemSrc,
  pathSrc,
  propSrc,
  scaffoldSrc,
  scatterSrc,
  tileSrc,
  type AccessLevel,
  type AnimalKey,
  type CharKey,
  type CivicRoom,
  type ItemKey,
  type PropKey,
  type ScaffoldStage,
  type ScatterKey,
} from "@/lib/art";
import { drawHazardTriangle, drawPennantFlag, drawSpeechBubble, drawSpeechPip, drawVerbGlyph } from "./kit";
import type { AmbientPose, Theme, ThemeArt, ThemeLexicon, ThemePalette } from "./types";

/** Lantern text on night stone; a whisper in the violet the whisper UI rings bodies with. */
const AOE_SPEECH = {
  bg: "rgba(7,8,20,0.9)",
  fg: "#f4d19a",
  border: "rgba(232,184,109,0.35)",
  whisperBg: "rgba(24,16,48,0.92)",
  whisperFg: "#ddd6fe",
  whisperBorder: "rgba(196,181,253,0.9)",
} as const;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

const TW = 64;
const TH = 32;

const tiles = new Map<string, HTMLImageElement>();
const chars = new Map<CharKey, HTMLImageElement>();
const buildings = new Map<AccessLevel, HTMLImageElement>();
const civics = new Map<CivicRoom, HTMLImageElement>();
const scaffolds = new Map<ScaffoldStage, HTMLImageElement>();
const props = new Map<PropKey, HTMLImageElement>();
const paths = new Map<number, HTMLImageElement>();
const scatters = new Map<ScatterKey, HTMLImageElement>();
const items = new Map<ItemKey, HTMLImageElement>();
const animals = new Map<AnimalKey, HTMLImageElement>();

let prepared: Promise<void> | null = null;

const POSE: Record<AmbientPose, AnimalKey> = {
  graze: "sheep-graze",
  idle: "sheep-idle",
  "walk-a": "sheep-walk-a",
  "walk-b": "sheep-walk-b",
};

const art: ThemeArt = {
  prepare() {
    if (prepared) return prepared;
    prepared = (async () => {
      /* Ground, characters and the three access buildings are what the map
       * cannot draw a single honest frame without, so they are awaited. The
       * other 47 files are scenery: fetched without blocking, and every draw
       * below treats a missing image as "not yet" rather than as an error. */
      for (const slug of ["plaza", "library", "workshop", "stage", "garden", "board"]) {
        try {
          try {
            tiles.set(slug, await loadImage(groundSrc(slug)));
          } catch {
            tiles.set(slug, await loadImage(tileSrc(slug)));
          }
        } catch {
          /* missing tile */
        }
      }
      await Promise.all([
        ...(Object.keys(CHAR_SRC) as CharKey[]).map((k) =>
          loadImage(CHAR_SRC[k]).then((img) => void chars.set(k, img)).catch(() => {}),
        ),
        ...(["private", "public_view", "public_write"] as AccessLevel[]).map((k) =>
          loadImage(buildingSrc(k)).then((img) => void buildings.set(k, img)).catch(() => {}),
        ),
      ]);
      const lazy = <K,>(store: Map<K, HTMLImageElement>, key: K, src: string) =>
        loadImage(src)
          .then((img) => void store.set(key, img))
          .catch(() => {
            /* a missing scenery file just means that thing never appears */
          });
      void Promise.all([
        ...CIVIC_ROOMS.map((r) => lazy(civics, r, civicSrc(r))),
        ...([1, 2, 3] as ScaffoldStage[]).map((s) => lazy(scaffolds, s, scaffoldSrc(s))),
        ...PROP_KEYS.map((k) => lazy(props, k, propSrc(k))),
        ...Array.from({ length: 16 }, (_, m) => lazy(paths, m, pathSrc(m))),
        ...SCATTER_KEYS.map((k) => lazy(scatters, k, scatterSrc(k))),
        ...ITEM_KEYS.map((k) => lazy(items, k, itemSrc(k))),
        ...ANIMAL_KEYS.map((k) => lazy(animals, k, animalSrc(k))),
      ]);
    })();
    return prepared;
  },

  backdrop() {
    /* The section's own dusk background is the backdrop. */
  },

  ground(ctx, region, x, y) {
    const tile = tiles.get(region === "wild" ? "garden" : region) ?? tiles.get("plaza");
    if (!tile) return false;
    ctx.drawImage(tile, x - TW / 2, y, TW, TH);
    return true;
  },

  path(ctx, mask, x, y) {
    const road = paths.get(mask);
    if (road) ctx.drawImage(road, x - TW / 2, y, TW, TH);
  },

  scatter(ctx, key, x, y) {
    const speck = scatters.get(key);
    if (speck) ctx.drawImage(speck, x - TW / 2, y, TW, TH);
  },

  landmark(ctx, room, px, py) {
    const img = civics.get(room);
    if (img) drawAnchored(ctx, img, px, py, CIVIC[room]);
  },

  building(ctx, access, px, py) {
    const img = buildings.get(access);
    if (img) drawAnchored(ctx, img, px, py, BUILDING);
  },

  scaffold(ctx, stage, px, py) {
    const img = scaffolds.get(stage);
    if (img) drawAnchored(ctx, img, px, py, SCAFFOLD);
  },

  prop(ctx, key, px, py) {
    const img = props.get(key);
    if (img) drawAnchored(ctx, img, px, py, PROP[key]);
  },

  body(ctx, sprite, x, y) {
    const img = chars.get(sprite) ?? chars.get("agent-front");
    if (!img) return false;
    ctx.drawImage(img, x - 20, y - 20, 40, 40);
    return true;
  },

  ambient(ctx, pose, x, y, flip) {
    const img = animals.get(POSE[pose]);
    if (!img) return;
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    // 64x64 art drawn at 40x40, feet on the bottom edge of the frame.
    ctx.drawImage(img, -20, -20, 40, 40);
    ctx.restore();
  },

  carry(ctx, item, x, y) {
    const held = items.get(item);
    if (!held) return false;
    ctx.drawImage(held, x - ITEM.ax, y - ITEM.ay, ITEM.w, ITEM.h);
    return true;
  },

  glyph: drawVerbGlyph,
  pennant: drawPennantFlag,
  hazard: drawHazardTriangle,

  speech(ctx, bubble) {
    drawSpeechBubble(ctx, bubble, AOE_SPEECH);
  },
  speechPip(ctx, sx, sy, whisper) {
    drawSpeechPip(ctx, sx, sy, whisper, { fg: "rgba(244,209,154,0.78)", whisperFg: AOE_SPEECH.whisperFg });
  },
};

export const AOE_LEXICON: ThemeLexicon = {
  name: "Age of Empires",
  blurb: "Stone, timber and lanterns at dusk. Villagers and sheep.",
  resource: { name: "gold", coin: "#fbbf24", rim: "#92400e" },
  eyebrow: "Aetheria · Grove",
  headline: "The campus grows as they do.",
  subline: "Idle bodies sit. Awake ones think, tool, wait, or speak — Grove Plaza plus Paperclip on this Mini.",
  skyPlace: "over Aetheria",
  aHuman: "A person",
  anAgent: "An agent",
  bodies: "bodies",
  regions: {
    plaza: { title: "Plaza", bookmark: "Plaza — where the world talks" },
    library: { title: "Library", bookmark: "Library — where bodies read" },
    workshop: { title: "Workshop", bookmark: "Workshop — where the tools run" },
    stage: { title: "Stage", bookmark: "Stage — what is on" },
    garden: { title: "Garden", bookmark: "Garden — where idle bodies go" },
    board: { title: "Board", bookmark: "Board — faults and notices" },
  },
  access: {
    private: { label: "private", blurb: "Held privately. The world says the ground is taken, and nothing else." },
    public_view: { label: "view only", blurb: "Open to look at. Anyone may watch; only its members speak here." },
    public_write: { label: "open", blurb: "Open ground — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this ground.",
  claimedPlot: "claimed",
  construction: "under construction",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle", allBusy: "all hands busy" },
  hud: { hereNow: "here now", watching: "watching", awake: "awake", asleep: "asleep", fog: "fog", world: "world", claimed: "claimed", quiet: "nobody has spoken here recently" },
  legend: ["tool", "think", "speak", "wait", "blocked", "fault", "asleep", "fading"],
  controls: {
    goTo: "go to",
    busiest: "Busiest",
    busiestTitle: "Busiest room right now",
    mySpace: "My space",
    mySpaceTitle: "My space — ground I hold",
    kiosk: "Kiosk",
    tv: "TV",
    onAir: "On air",
    following: "Following",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
};

export const AOE_PALETTE: ThemePalette = {
  plotTint: {
    private: "rgba(244,114,182,0.30)",
    public_view: "rgba(56,189,248,0.26)",
    // Amber, not green: the open land underneath is already green.
    public_write: "rgba(251,191,36,0.26)",
  },
  fog: "rgba(4,6,16,0.72)",
  plotEdge: "rgba(167,139,250,0.38)",
  coreGrid: "rgba(232,184,109,0.12)",
  plotName: "#f4d19a",
  nameFill: "#f4d19a",
  paperclipNameFill: "#c4b5fd",
  departRing: "rgba(148,163,184,0.9)",
  placeholder: { human: "#e8b86d", agent: "#7c3aed" },
  glow: ["rgba(255,206,132,0.9)", "rgba(255,174,86,0.34)", "rgba(255,146,56,0)"],
  daylight: "rgb(150,164,186)",
  card: { bg: "rgba(7,8,20,0.94)", title: "#f4d19a", text: "rgba(236,231,221,0.78)" },
  chrome: {
    dusk950: "7 8 20",
    dusk900: "11 18 32",
    dusk800: "18 26 46",
    dusk700: "26 39 68",
    lantern300: "244 209 154",
    lantern400: "232 184 109",
    lantern500: "212 146 58",
  },
  displayFont: 'Fraunces, Georgia, serif',
};

export const aoe = {
  id: "aoe",
  lexicon: AOE_LEXICON,
  palette: AOE_PALETTE,
  art,
} satisfies Theme;
