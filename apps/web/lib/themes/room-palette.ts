/**
 * The room drawer's colours (#58), mapped from the active theme's palette.
 *
 * Pure: a theme palette in, CSS colour strings out, so the drawer's canvas
 * (PixelRoom) and its board tables (RoomTables) follow the live theme without
 * reading the DOM. What a mark MEANS stays theme-invariant, like the map's
 * verb rings and hazard marks: the whisper ring, the agent's name colour, and
 * the last-move / selected / legal-target / check marks on a board are fixed
 * here and never come from a palette.
 */
import type { RgbTriplet, ThemePalette } from "./types";

/** `rgb(r g b / a)` from a chrome triplet. */
export function tokenColour(t: RgbTriplet, alpha = 1): string {
  return alpha >= 1 ? `rgb(${t})` : `rgb(${t} / ${alpha})`;
}

/**
 * Board marks that say something about the game. Fixed across themes: a last
 * move or a king in check reads the same in a tavern as on a starship. None of
 * them is a hazard colour (THEMES.md rule 2: a fault on the map stays the
 * loudest thing), and none is the whisper violet.
 */
export const TABLE_MARKS = {
  /** The squares (or the disc) the last move touched. */
  lastMove: "rgba(56,189,248,0.32)",
  /** The piece you picked up. */
  selected: "#38bdf8",
  /** Where it may go. */
  target: "rgba(56,189,248,0.75)",
  /** The king of the side to move, while in check. */
  check: "#e11d48",
} as const;

/** Rings a body you are whispering to. Whisper violet everywhere in the UI. */
export const WHISPER_RING = "rgba(196,181,253,0.95)";

/** An agent's name under its body. Human and agent must stay distinguishable in every theme. */
export const AGENT_NAME = "#c4b5fd";

export type RoomColours = {
  /** Laid over the floor so bodies and speech come forward. */
  dim: string;
  nameBg: string;
  humanName: string;
  agentName: string;
  whisperRing: string;
  /** The room's name on its wall. */
  placardBg: string;
  placardText: string;
  placardEdge: string;
};

export function roomColours(p: ThemePalette): RoomColours {
  const c = p.chrome;
  return {
    dim: tokenColour(c.dusk950, 0.45),
    nameBg: tokenColour(c.dusk950, 0.72),
    humanName: tokenColour(c.lantern300),
    agentName: AGENT_NAME,
    whisperRing: WHISPER_RING,
    placardBg: tokenColour(c.dusk950, 0.82),
    placardText: tokenColour(c.lantern300),
    placardEdge: tokenColour(c.lantern400, 0.5),
  };
}

export type TableColours = {
  /** Four-in-a-row: the frame and an empty hole. */
  frame: string;
  hole: string;
  /** Seat 0's disc (solid) and seat 1's disc (ring on a faint fill). */
  firstDisc: string;
  secondDiscRing: string;
  secondDiscFill: string;
  /** Chess squares. */
  lightSquare: string;
  darkSquare: string;
  /** Chess pieces: white side and black side, disc and letter. */
  whitePiece: string;
  whiteText: string;
  blackPiece: string;
  blackText: string;
  blackEdge: string;
  /** Column buttons over the four-in-a-row board. */
  control: string;
  controlEdge: string;
  /** The in-world ground the board sits on inside the brand drawer (DECISIONS #7): the theme's darkest tone. */
  ground: string;
};

export function tableColours(p: ThemePalette): TableColours {
  const c = p.chrome;
  return {
    frame: tokenColour(c.dusk700, 0.85),
    hole: tokenColour(c.dusk950, 0.8),
    firstDisc: tokenColour(c.lantern400),
    secondDiscRing: "rgba(255,255,255,0.85)",
    secondDiscFill: "rgba(255,255,255,0.1)",
    lightSquare: tokenColour(c.lantern300, 0.28),
    darkSquare: tokenColour(c.dusk700),
    whitePiece: "#ffffff",
    whiteText: tokenColour(c.dusk950),
    blackPiece: tokenColour(c.dusk950),
    blackText: "#ffffff",
    blackEdge: "rgba(255,255,255,0.45)",
    control: tokenColour(c.lantern300),
    controlEdge: tokenColour(c.lantern400, 0.4),
    ground: tokenColour(c.dusk950),
  };
}
