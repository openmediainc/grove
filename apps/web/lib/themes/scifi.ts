/**
 * Sci-fi — drones, force fields, neon pads.
 * Private is a force-field box, view-only is a translucent shield, open is a pad.
 */

import { makeProceduralArt } from "./procedural";
import type { Theme, ThemeLexicon, ThemePalette } from "./types";

const lexicon: ThemeLexicon = {
  name: "Sci-fi",
  blurb: "Drones, force fields and neon pads.",
  eyebrow: "Aetheria · Grid",
  headline: "The grid grows as they do.",
  subline: "Idle nodes rest. Awake ones think, tool, wait, or speak — Grove Hub plus Paperclip on this Mini.",
  skyPlace: "over the grid",
  aHuman: "An operator",
  anAgent: "A drone",
  bodies: "nodes",
  regions: {
    plaza: { title: "Hub", bookmark: "Hub — where the grid talks" },
    library: { title: "Core", bookmark: "Core — where nodes read" },
    workshop: { title: "Forge", bookmark: "Forge — where the tools run" },
    stage: { title: "Broadcast", bookmark: "Broadcast — what is on" },
    garden: { title: "Grove-net", bookmark: "Grove-net — where idle nodes go" },
    board: { title: "Alerts", bookmark: "Alerts — faults and notices" },
  },
  access: {
    private: { label: "shielded", blurb: "Force field up. The grid says this cell is taken, and nothing else." },
    public_view: { label: "translucent", blurb: "You may look through the field; only its operators speak here." },
    public_write: { label: "open pad", blurb: "Open cell — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this cell.",
  claimedPlot: "claimed cell",
  construction: "materialising",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle", allBusy: "all nodes busy" },
  hud: { awake: "awake", asleep: "asleep", fog: "static", world: "grid", claimed: "claimed", quiet: "nobody has spoken here recently" },
  legend: ["tool", "think", "speak", "wait", "blocked", "fault", "asleep", "fading"],
  controls: {
    goTo: "go to",
    busiest: "Busiest",
    busiestTitle: "Busiest room right now",
    mySpace: "My cell",
    mySpaceTitle: "My cell — ground I hold",
    kiosk: "Kiosk",
    following: "Following",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
};

const palette: ThemePalette = {
  plotTint: {
    private: "rgba(192,132,252,0.32)",
    public_view: "rgba(45,212,191,0.26)",
    public_write: "rgba(244,114,182,0.24)",
  },
  fog: "rgba(8,8,20,0.78)",
  plotEdge: "rgba(192,132,252,0.45)",
  coreGrid: "rgba(45,212,191,0.14)",
  plotName: "#c4b5fd",
  nameFill: "#e9d5ff",
  paperclipNameFill: "#5eead4",
  departRing: "rgba(167,139,250,0.9)",
  placeholder: { human: "#e879f9", agent: "#2dd4bf" },
  glow: ["rgba(192,132,252,0.9)", "rgba(45,212,191,0.34)", "rgba(15,23,42,0)"],
  daylight: "rgb(120,130,170)",
  card: { bg: "rgba(8,8,20,0.94)", title: "#c4b5fd", text: "rgba(233,213,255,0.78)" },
  chrome: {
    dusk950: "8 8 20",
    dusk900: "17 12 34",
    dusk800: "30 20 52",
    dusk700: "46 16 80",
    lantern300: "196 181 253",
    lantern400: "167 139 250",
    lantern500: "139 92 246",
  },
  displayFont: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const scifi = {
  id: "scifi",
  lexicon,
  palette,
  art: makeProceduralArt({
    ground: {
      plaza: { fill: "#1e1b4b", speckles: ["#5b21b6", "#2dd4bf", "#c084fc"] },
      library: { fill: "#172554", speckles: ["#1e3a8a", "#67e8f9"] },
      workshop: { fill: "#3b0764", speckles: ["#6b21a8", "#f0abfc"] },
      stage: { fill: "#4a044e", speckles: ["#86198f", "#f472b6"] },
      garden: { fill: "#042f2e", speckles: ["#115e59", "#2dd4bf"] },
      board: { fill: "#3b0764", speckles: ["#6b21a8", "#fb7185"] },
      wild: { fill: "#080814", speckles: ["#1e1b4b", "#4c1d95"] },
    },
    path: { fill: "#6d28d9", edge: "#c4b5fd" },
    scatter: {
      pebbles: "#a78bfa",
      tuft: "#2dd4bf",
      flowers: "#f0abfc",
      crack: "#4c1d95",
      puddle: "#22d3ee",
      leaves: "#5eead4",
    },
    building: {
      private: { body: "#4c1d95", roof: "#2e1065" },
      public_view: { body: "#5b21b6", roof: "#2dd4bf", glass: "rgba(45,212,191,0.4)" },
      public_write: { body: "#6d28d9", roof: "#f472b6" },
    },
    landmark: {
      plaza: { body: "#5b21b6", accent: "#2dd4bf" },
      library: { body: "#1e3a8a", accent: "#67e8f9" },
      workshop: { body: "#6b21a8", accent: "#f0abfc" },
      stage: { body: "#86198f", accent: "#f472b6" },
      garden: { body: "#115e59", accent: "#5eead4" },
      board: { body: "#9f1239", accent: "#fb7185" },
    },
    scaffold: { timber: "#a78bfa", cloth: "#2dd4bf" },
    prop: { metal: "#c4b5fd", wood: "#6d28d9", plant: "#2dd4bf", fire: "#f0abfc", water: "#22d3ee" },
    human: {
      skin: "#f5d0c5",
      head: "helmet",
      headColour: "#c084fc",
      visor: "#2dd4bf",
      torso: "#6d28d9",
      legs: "#4c1d95",
      accent: "#2dd4bf",
      shoulders: "#a78bfa",
    },
    agent: {
      skin: "#5eead4",
      head: "dome",
      headColour: "#134e4a",
      torso: "#115e59",
      legs: "#042f2e",
      accent: "#2dd4bf",
      eyes: "#ccfbf1",
      antenna: "#5eead4",
    },
    critter: "drone",
    speech: { bg: "rgba(8,8,20,0.92)", fg: "#e9d5ff", border: "#2dd4bf" },
  }),
} satisfies Theme;
