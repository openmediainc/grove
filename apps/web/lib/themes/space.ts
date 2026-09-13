/**
 * Space — hangars, airlocks, drifting satellites.
 * Shape still carries access: airlock is closed, cupola is see-through, pad is open.
 */

import { makeProceduralArt } from "./procedural";
import type { Theme, ThemeLexicon, ThemePalette } from "./types";

const lexicon: ThemeLexicon = {
  name: "Space",
  blurb: "Hangars, airlocks and drifting satellites.",
  eyebrow: "Aetheria · Station",
  headline: "The station grows as they do.",
  subline: "Idle crew rest. Awake ones think, tool, wait, or speak — Grove Atrium plus Paperclip on this Mini.",
  skyPlace: "over the station",
  aHuman: "A crew member",
  anAgent: "A unit",
  bodies: "crew",
  regions: {
    plaza: { title: "Atrium", bookmark: "Atrium — where the station talks" },
    library: { title: "Archive", bookmark: "Archive — where units read" },
    workshop: { title: "Bay", bookmark: "Bay — where the tools run" },
    stage: { title: "Comms", bookmark: "Comms — what is on" },
    garden: { title: "Greenhouse", bookmark: "Greenhouse — where idle crew go" },
    board: { title: "Alert deck", bookmark: "Alert deck — faults and notices" },
  },
  access: {
    private: { label: "sealed", blurb: "Airlock shut. The station says this berth is taken, and nothing else." },
    public_view: { label: "cupola", blurb: "You may look through the glass; only its crew speak here." },
    public_write: { label: "open pad", blurb: "Open dock — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this berth.",
  claimedPlot: "claimed berth",
  construction: "assembling",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle", allBusy: "all hands busy" },
  hud: { awake: "awake", asleep: "asleep", fog: "dark", world: "station", claimed: "claimed", quiet: "nobody has spoken here recently" },
  legend: ["tool", "think", "speak", "wait", "blocked", "fault", "asleep", "fading"],
  controls: {
    goTo: "go to",
    busiest: "Busiest",
    busiestTitle: "Busiest room right now",
    mySpace: "My berth",
    mySpaceTitle: "My berth — ground I hold",
    kiosk: "Kiosk",
    following: "Following",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
};

const palette: ThemePalette = {
  plotTint: {
    private: "rgba(56,189,248,0.28)",
    public_view: "rgba(125,211,252,0.24)",
    public_write: "rgba(253,224,71,0.22)",
  },
  fog: "rgba(2,6,23,0.78)",
  plotEdge: "rgba(56,189,248,0.4)",
  coreGrid: "rgba(125,211,252,0.12)",
  plotName: "#7dd3fc",
  nameFill: "#e0f2fe",
  paperclipNameFill: "#c4b5fd",
  departRing: "rgba(148,163,184,0.9)",
  placeholder: { human: "#7dd3fc", agent: "#38bdf8" },
  glow: ["rgba(125,211,252,0.9)", "rgba(14,165,233,0.34)", "rgba(8,47,73,0)"],
  daylight: "rgb(148,163,184)",
  card: { bg: "rgba(2,6,23,0.94)", title: "#7dd3fc", text: "rgba(224,242,254,0.78)" },
  chrome: {
    dusk950: "2 6 23",
    dusk900: "8 15 36",
    dusk800: "15 23 42",
    dusk700: "30 41 68",
    lantern300: "125 211 252",
    lantern400: "56 189 248",
    lantern500: "14 165 233",
  },
  displayFont: "ui-sans-serif, system-ui, sans-serif",
};

export const space = {
  id: "space",
  lexicon,
  palette,
  art: makeProceduralArt({
    ground: {
      plaza: { fill: "#1e293b", speckles: ["#334155", "#475569", "#0ea5e9"] },
      library: { fill: "#1e293b", speckles: ["#334155", "#64748b"] },
      workshop: { fill: "#292524", speckles: ["#57534e", "#78716c"] },
      stage: { fill: "#1e1b4b", speckles: ["#312e81", "#38bdf8"] },
      garden: { fill: "#14532d", speckles: ["#166534", "#4ade80"] },
      board: { fill: "#1c1917", speckles: ["#44403c", "#f87171"] },
      wild: { fill: "#020617", speckles: ["#0f172a", "#1e293b", "#38bdf8"] },
    },
    path: { fill: "#475569", edge: "#94a3b8" },
    scatter: {
      pebbles: "#64748b",
      tuft: "#4ade80",
      flowers: "#38bdf8",
      crack: "#0f172a",
      puddle: "#0ea5e9",
      leaves: "#22c55e",
    },
    building: {
      private: { body: "#1e293b", roof: "#0f172a" },
      public_view: { body: "#334155", roof: "#38bdf8", glass: "rgba(125,211,252,0.4)" },
      public_write: { body: "#475569", roof: "#eab308" },
    },
    landmark: {
      plaza: { body: "#334155", accent: "#38bdf8" },
      library: { body: "#1e3a5f", accent: "#7dd3fc" },
      workshop: { body: "#44403c", accent: "#fb923c" },
      stage: { body: "#1e1b4b", accent: "#a78bfa" },
      garden: { body: "#14532d", accent: "#4ade80" },
      board: { body: "#44403c", accent: "#f87171" },
    },
    scaffold: { timber: "#64748b", cloth: "#38bdf8" },
    prop: { metal: "#94a3b8", wood: "#57534e", plant: "#22c55e", fire: "#38bdf8", water: "#0ea5e9" },
    human: {
      skin: "#f8d7c4",
      head: "helmet",
      headColour: "#e2e8f0",
      visor: "#38bdf8",
      torso: "#e2e8f0",
      legs: "#cbd5e1",
      accent: "#0ea5e9",
      shoulders: "#94a3b8",
    },
    agent: {
      skin: "#67e8f9",
      head: "box",
      headColour: "#0e7490",
      torso: "#155e75",
      legs: "#164e63",
      accent: "#22d3ee",
      eyes: "#a5f3fc",
      antenna: "#67e8f9",
    },
    critter: "satellite",
    speech: { bg: "rgba(2,6,23,0.92)", fg: "#7dd3fc", border: "#38bdf8" },
  }),
} satisfies Theme;
