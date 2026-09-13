/**
 * The theme contract.
 *
 * Grove's map speaks in domain concepts — a body, an idle critter, a building
 * at an access level, a work site per verb region, a fault — and a theme is the
 * ONE place those concepts are turned into pixels and words. The renderer never
 * decides what a private plot looks like; it asks the active theme to draw "a
 * building at access level private", and the theme answers in its own art.
 *
 * Every slot below is required. A theme object is declared with
 * `satisfies Theme`, so a theme that forgets the scaffolding, a prop, a region
 * name or an access-level blurb does not compile. `contract.typetest.ts` pins
 * that down.
 *
 * What a theme may NOT change is listed in docs/design/THEMES.md and enforced
 * here by shape: the semantic colours (verb rings, hazard tones, stall ring)
 * are NOT theme tokens, the footprints and anchors that decide seat blocking
 * and draw order are NOT theme tokens, and the order of the attention bell is
 * NOT a theme token. A theme changes how a truth looks, never what it says.
 */

import type { AgentVerb } from "@/lib/agent-verbs";
import type { BrandEmblem, SpaceMark } from "@grove/protocol";
import type {
  AccessLevel,
  CharKey,
  CivicRoom,
  ItemKey,
  PropKey,
  ScaffoldStage,
  ScatterKey,
} from "@/lib/art";
import type { MapRegion } from "@/lib/map-layout";

export type ThemeId = "aoe" | "space" | "city" | "scifi";

export type Ctx = CanvasRenderingContext2D;

/** flag — prompt-injection flag; fault — errored or blocked; stall — gone quiet while "working". */
export type HazardTone = "flag" | "fault" | "stall";

/** The four frames an ambient critter cycles through. See worldDressing.sheepAt(). */
export type AmbientPose = "graze" | "idle" | "walk-a" | "walk-b";

/**
 * A body sprite, named semantically: who (human | agent) and the stance the
 * current verb puts them in (front | side | work | speak). The renderer picks
 * the key from the verb; the theme only draws it.
 */
export type BodySprite = CharKey;

/* ------------------------------------------------------------------ *
 * Semantics a theme cannot touch.
 *
 * These are here, beside the contract, so that "why can't my theme recolour
 * the fault triangle?" has its answer next to the question.
 * ------------------------------------------------------------------ */

/** Hazard tones. Fixed across every theme: a fault is the loudest thing on screen, always. */
export const HAZARD_COLOUR: Readonly<Record<HazardTone, string>> = {
  flag: "#f472b6",
  fault: "#f87171",
  stall: "#fb923c",
};

/** A stalled body's dashed ring. Fixed for the same reason. */
export const STALL_RING = "#f87171";

/* ------------------------------------------------------------------ *
 * Art: every drawable concept on the map.
 *
 * Coordinates are LAYOUT space unless a slot says SCREEN. The anchor rules
 * are the ones apps/web/public/art/README.md states for the PNG set, and every
 * theme keeps them, because they are what the depth sort and the hit-testing
 * are built on:
 *
 *   tile       (x, y) is the diamond's NORTH vertex; the tile is 64 x 32 and
 *              the caller has already clipped to the diamond.
 *   anchored   (px, py) is iso() of the north-most tile of the footprint.
 *              Footprints are fixed by the layout (landmark 4x4, access
 *              building and scaffold 3x3, prop 1x1) — a theme may draw taller
 *              or shorter, never wider.
 *   body       (x, y) is the sprite centre; the sprite occupies a 40 x 40 box
 *              with its feet on y + 20.
 *   carry      (x, y) is the grip point at the body's right hand.
 * ------------------------------------------------------------------ */

export interface ThemeArt {
  /**
   * Load or bake whatever the theme cannot draw an honest frame without.
   * Idempotent; the renderer calls it on mount and on every switch, and keeps
   * drawing the previous theme until it resolves.
   */
  prepare(): Promise<void>;

  /** SCREEN space, before the world: what lies beyond the edge of the map. */
  backdrop(ctx: Ctx, w: number, h: number, t: number): void;

  /** Terrain. `region` is "wild" outside the civic core. Returns false if not drawable yet. */
  ground(ctx: Ctx, region: MapRegion, x: number, y: number, tx: number, ty: number): boolean;
  /** Avenue piece, 16-way N/E/S/W bitmask (art.ts PATH_*). Tile rules. */
  path(ctx: Ctx, mask: number, x: number, y: number): void;
  /** Ground seasoning. Tile rules. */
  scatter(ctx: Ctx, key: ScatterKey, x: number, y: number): void;

  /** The work site for a verb region. Anchored, 4x4. */
  landmark(ctx: Ctx, room: CivicRoom, px: number, py: number): void;
  /**
   * A claimed plot's building. Anchored, 3x3. Access level MUST be carried by
   * shape, not only colour: private reads closed, public_view reads
   * see-through, public_write reads open.
   */
  building(ctx: Ctx, access: AccessLevel, px: number, py: number): void;
  /** Work in progress, three stages growing toward a building. Anchored, 3x3. */
  scaffold(ctx: Ctx, stage: ScaffoldStage, px: number, py: number): void;
  /**
   * Street furniture. Anchored, 1x1. The keys are semantic:
   * lantern = light source, bench = seat, planter = greenery, crates = stores,
   * signpost = wayfinding / notice board, brazier = fire / heat source,
   * wellstone = water feature / fountain, rubble = debris.
   */
  prop(ctx: Ctx, key: PropKey, px: number, py: number): void;

  /** A body. Returns false if not drawable yet (the renderer draws a placeholder). */
  body(ctx: Ctx, sprite: BodySprite, x: number, y: number): boolean;
  /** Ambient life: an idle critter. Same 40 x 40 box as a body; `flip` faces it left. */
  ambient(ctx: Ctx, pose: AmbientPose, x: number, y: number, flip: boolean, t: number): void;
  /**
   * What a body carries for its verb: document = read, tool = tool,
   * lamp = think, seedling = idle in the garden. Returns false when there is
   * nothing to draw yet, and the renderer falls back to glyph().
   */
  carry(ctx: Ctx, item: ItemKey, x: number, y: number): boolean;
  /** The abstract verb mark beside a body. Colour comes from VERB_RING and must not be changed. */
  glyph(ctx: Ctx, verb: AgentVerb, x: number, y: number, t: number): void;
  /** Org identity, flown to the body's left. `colour` is the org's own colour. */
  pennant(ctx: Ctx, colour: string, x: number, y: number): void;
  /**
   * SCREEN space, fixed size. Must stay a warning triangle in HAZARD_COLOUR
   * with a dark backing — a theme may frame it, never soften it.
   */
  hazard(ctx: Ctx, sx: number, sy: number, tone: HazardTone, t: number): void;
  /**
   * SCREEN space. A line somebody just said, already laid out: the box, the
   * wrapped lines, whether it needs a leader line back to the head and how many
   * lines were squeezed out around it ("+N"). Placement is NOT the theme's to
   * change — @grove/ui speech-layout decided it so that bubbles never cover a
   * hazard or each other — only how the box looks. A whisper must still read as
   * a whisper (kit.drawSpeechBubble keeps the dashed edge). Drawn after the sky.
   */
  speech(ctx: Ctx, bubble: SpeechBubble, t: number): void;
  /**
   * CSS font-family for speech text. The layout measures with it, so the text
   * a theme draws is the text that was fitted to the box. Default: system sans.
   */
  speechFont?: string;
  /**
   * SCREEN space, fixed size. "This body said something": the far-zoom stand-in
   * for a bubble, and the mark on a speaker the crowd squeezed out. Must stay
   * smaller and quieter than hazard() — speech never outranks a fault.
   */
  speechPip(ctx: Ctx, sx: number, sy: number, whisper: boolean, t: number): void;
  /**
   * SCREEN space. A claimed plot's signboard, hung on the front of its
   * building, already laid out by lib/signboard (box, fitted lines, org tint).
   * The theme draws the board, its fixings and the text; it may not move the
   * box or change the words. A `held` board is a private plot: it never has a
   * name or a tint to draw, and should read closed. Drawn after the sky, and
   * only above the signboard zoom threshold.
   */
  signboard(ctx: Ctx, board: Signboard, t: number): void;
}

/** One fitted line on a signboard. `y` is the vertical middle, SCREEN px. */
export type SignLine = { text: string; fontPx: number; y: number; role: "title" | "tagline" | "detail" | "org" };

/**
 * The owner's emblem (035), laid out inside the board to the left of the text.
 * The GLYPH is fixed per key (kit `drawBrandEmblem`); `colour` is the owner's
 * accent, or null for the theme's own title colour. SCREEN px.
 */
export type SignEmblem = { key: BrandEmblem; cx: number; cy: number; size: number; colour: string | null };

/** A laid-out plot signboard as the renderer hands it to a theme. SCREEN px. */
export type Signboard = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The point on the building's front the board is centred on. */
  ax: number;
  ay: number;
  lines: readonly SignLine[];
  /** A private plot: "Held plot", no name, no org, no headcount. */
  held: boolean;
  /**
   * The primary stripe: the owner's accent (035) when set, else the first bound
   * org's colour, else null. Always null when held.
   */
  tint: string | null;
  /**
   * The org colour, when an owner accent took the primary stripe: drawn as a
   * small secondary stripe so the org still shows. Always null when held.
   */
  secondaryTint: string | null;
  /** The owner's emblem, or null. Always null when held. */
  emblem: SignEmblem | null;
  /** Horizontal centre of the text, SCREEN px (shifted right of an emblem). */
  tx: number;
  /**
   * Achievement marks (030), laid out as medallions hanging under the board,
   * SCREEN px. Always empty when held. The SHAPE of each mark's glyph is fixed
   * (kit `drawSignMark`); a theme only chooses what the medallion is made of.
   */
  marks: readonly SignMark[];
};

/** One laid-out mark medallion: centre and radius, SCREEN px. */
export type SignMark = { key: SpaceMark; x: number; y: number; r: number };

/** A laid-out bubble as the renderer hands it to a theme. SCREEN px. */
export type SpeechBubble = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The speaker's head: where the tail or leader line points. */
  ax: number;
  ay: number;
  lines: readonly string[];
  fontPx: number;
  lineH: number;
  padX: number;
  padY: number;
  whisper: boolean;
  leader: boolean;
  /** Lines nearby that did not fit, shown as "+N". */
  overflow: number;
};

/* ------------------------------------------------------------------ *
 * Palette: the non-semantic colours, for the canvas and for the chrome.
 * ------------------------------------------------------------------ */

/** "r g b", the form Tailwind's `<alpha-value>` wants. */
export type RgbTriplet = `${number} ${number} ${number}`;

export interface ThemePalette {
  /** Tint over a claimed plot's ground, per access level. Paired with a shape, never alone. */
  plotTint: Readonly<Record<AccessLevel, string>>;
  /** Unexplored ground. */
  fog: string;
  /** Parcel edges on unclaimed land. */
  plotEdge: string;
  /** The faint grid on the civic core. */
  coreGrid: string;
  /** A plot's name. */
  plotName: string;
  /** Nameplate for a Grove body, and for a mirrored Paperclip one. */
  nameFill: string;
  paperclipNameFill: string;
  /** The ring opening where a departed body stood. */
  departRing: string;
  /** Placeholder square when a body sprite is not ready. */
  placeholder: { human: string; agent: string };
  /** Lamp glow stops, inner to outer. */
  glow: readonly [string, string, string];
  /** The colour daylight lifts the world toward, as a `screen` fill. */
  daylight: string;
  /** Hover card. */
  card: { bg: string; title: string; text: string };
  /**
   * Chrome tokens, applied as CSS custom properties on the map's section, so
   * every `dusk-*` / `lantern-*` utility inside it re-skins live.
   */
  chrome: {
    dusk950: RgbTriplet;
    dusk900: RgbTriplet;
    dusk800: RgbTriplet;
    dusk700: RgbTriplet;
    lantern300: RgbTriplet;
    lantern400: RgbTriplet;
    lantern500: RgbTriplet;
  };
  /** CSS font-family stack for display headings. Always ends in a generic family. */
  displayFont: string;
}

/* ------------------------------------------------------------------ *
 * Lexicon: every UI word the map says that a theme may say differently.
 *
 * Rules (see THEMES.md): human and agent stay distinguishable; "private" must
 * still read as closed; "faulted" and "stalled" keep their plain meaning. The
 * room slugs in URLs (/w/library) never change — only what they are called.
 * ------------------------------------------------------------------ */

export interface ThemeLexicon {
  /** Shown in the switcher. */
  name: string;
  /** One line in the switcher, what this skin is. */
  blurb: string;
  /**
   * The resource the cost counter and the carry-and-deposit animation speak in
   * (AGT-11). Words and colours only: the amount is always real dollars, and an
   * unpriced cost is always drawn grey with a "?" whatever the theme.
   */
  resource?: { name: string; coin: string; rim: string };

  /** HUD heading. Product name only; the Mini-only Paperclip line is added by `mapSubline()`, never baked in. */
  eyebrow: string;
  headline: string;
  subline: string;
  /** "over Glasshouse" — completes the clock's tooltip. */
  skyPlace: string;

  /** Peek card subtitle openers. */
  aHuman: string;
  anAgent: string;
  /** Plural noun for whatever stands on the map, e.g. "bodies", "crew". */
  bodies: string;

  /** Per verb region: its name, and the sentence on its camera bookmark. */
  regions: Readonly<Record<CivicRoom, { title: string; bookmark: string }>>;

  /** Per access level: the short label and the sentence a spectator can act on. */
  access: Readonly<Record<AccessLevel, { label: string; blurb: string }>>;
  /** Fallback blurb for a plot whose preset is unknown. */
  accessUnknown: string;
  /** Unnamed claimed plot label on the map. */
  claimedPlot: string;
  /** A private plot's signboard. Never a name: "Held plot" in its own words. */
  heldPlot: string;
  /**
   * Caption under an agent resting at its home plot while nobody runs it.
   * Must read as not working. The dim and the moon mark beside it are fixed.
   */
  resting: string;

  /** What a work site is called: prefixes the url on the hover card. */
  construction: string;

  /** The idle-villager bell. */
  bell: { faulted: string; stalled: string; fading: string; idle: string; allBusy: string };

  /** HUD counters and legend. */
  /** hereNow/watching: the live headcount pill ("N here now · N watching"). */
  hud: { hereNow: string; watching: string; awake: string; asleep: string; fog: string; world: string; claimed: string; quiet: string };
  legend: readonly string[];

  /** The card on a space or body (peek + profile pages). */
  card: {
    workingOn: string;
    lookingFor: string;
    latest: string;
    links: string;
    /** Where a derived row came from. */
    fromToolCalls: string;
    fromPulse: string;
    /** Nothing written, nothing read. */
    empty: string;
    walkOver: string;
    follow: string;
    /** The heart once it is on: "Following" in this theme's words. */
    following: string;
    /** Leave a message for a person or an agent, in this theme's words. */
    message: string;
  };

  /** Controls. */
  controls: {
    goTo: string;
    busiest: string;
    busiestTitle: string;
    mySpace: string;
    mySpaceTitle: string;
    kiosk: string;
    /** Grove TV: the auto-directed kiosk channel. */
    tv: string;
    /** The tag on the TV caption while it is directing. */
    onAir: string;
    following: string;
    release: string;
    resetView: string;
    theme: string;
  };

  /**
   * Postcard: the map saved to this device as a PNG with a caption strip.
   * `greeting` + `world` is the caption's title; `replay` tags a picture of the past.
   */
  postcard: { button: string; buttonTitle: string; greeting: string; world: string; replay: string };

  /**
   * Achievement marks on a plot (030), named for the space peek card. Plain
   * statements of work done, never a score: no numbers beyond the rule itself.
   */
  marks: { heading: string } & Record<SpaceMark, string>;
}

export interface Theme {
  id: ThemeId;
  lexicon: ThemeLexicon;
  palette: ThemePalette;
  art: ThemeArt;
}
