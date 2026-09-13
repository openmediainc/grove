/**
 * City — pigeons, gated lots, storefronts.
 * Private is a gated lot, view-only is a shop window, open is a plaza stall.
 */

import { makeProceduralArt } from "./procedural";
import type { Theme, ThemeLexicon, ThemePalette } from "./types";

const lexicon: ThemeLexicon = {
  name: "City",
  blurb: "Pigeons, gated lots and shop windows.",
  eyebrow: "Aetheria · District",
  headline: "The block grows as they do.",
  subline: "Idle people sit. Awake ones think, tool, wait, or speak — Grove Square plus Paperclip on this Mini.",
  skyPlace: "over the district",
  aHuman: "A resident",
  anAgent: "A courier",
  bodies: "people",
  regions: {
    plaza: { title: "Square", bookmark: "Square — where the block talks" },
    library: { title: "Library", bookmark: "Library — where people read" },
    workshop: { title: "Yard", bookmark: "Yard — where the tools run" },
    stage: { title: "Bandstand", bookmark: "Bandstand — what is on" },
    garden: { title: "Park", bookmark: "Park — where idle people go" },
    board: { title: "Notices", bookmark: "Notices — faults and flyers" },
  },
  access: {
    private: { label: "gated", blurb: "Gated lot. The block says this plot is taken, and nothing else." },
    public_view: { label: "shop window", blurb: "You may look in; only its staff speak here." },
    public_write: { label: "open stall", blurb: "Open ground — anyone with a body may walk in and speak." },
  },
  accessUnknown: "Somebody holds this lot.",
  claimedPlot: "claimed lot",
  construction: "under construction",
  bell: { faulted: "faulted", stalled: "stalled", fading: "fading", idle: "idle", allBusy: "all hands busy" },
  hud: { awake: "awake", asleep: "asleep", fog: "haze", world: "block", claimed: "claimed", quiet: "nobody has spoken here recently" },
  legend: ["tool", "think", "speak", "wait", "blocked", "fault", "asleep", "fading"],
  controls: {
    goTo: "go to",
    busiest: "Busiest",
    busiestTitle: "Busiest room right now",
    mySpace: "My lot",
    mySpaceTitle: "My lot — ground I hold",
    kiosk: "Kiosk",
    following: "Following",
    release: "Release",
    resetView: "Reset view",
    theme: "Theme",
  },
};

const palette: ThemePalette = {
  plotTint: {
    private: "rgba(248,113,113,0.28)",
    public_view: "rgba(96,165,250,0.26)",
    public_write: "rgba(74,222,128,0.22)",
  },
  fog: "rgba(15,23,42,0.7)",
  plotEdge: "rgba(148,163,184,0.4)",
  coreGrid: "rgba(203,213,225,0.12)",
  plotName: "#e2e8f0",
  nameFill: "#f8fafc",
  paperclipNameFill: "#c4b5fd",
  departRing: "rgba(148,163,184,0.9)",
  placeholder: { human: "#fbbf24", agent: "#60a5fa" },
  glow: ["rgba(253,224,71,0.85)", "rgba(251,191,36,0.3)", "rgba(120,53,15,0)"],
  daylight: "rgb(186,198,210)",
  card: { bg: "rgba(15,23,42,0.94)", title: "#f8fafc", text: "rgba(226,232,240,0.78)" },
  chrome: {
    dusk950: "15 23 42",
    dusk900: "30 41 59",
    dusk800: "51 65 85",
    dusk700: "71 85 105",
    lantern300: "226 232 240",
    lantern400: "203 213 225",
    lantern500: "148 163 184",
  },
  displayFont: "ui-sans-serif, system-ui, sans-serif",
};

export const city = {
  id: "city",
  lexicon,
  palette,
  art: makeProceduralArt({
    ground: {
      plaza: { fill: "#64748b", speckles: ["#94a3b8", "#cbd5e1", "#475569"] },
      library: { fill: "#57534e", speckles: ["#78716c", "#a8a29e"] },
      workshop: { fill: "#44403c", speckles: ["#57534e", "#a8a29e"] },
      stage: { fill: "#3f3f46", speckles: ["#52525b", "#fbbf24"] },
      garden: { fill: "#3f6212", speckles: ["#4d7c0f", "#a3e635"] },
      board: { fill: "#44403c", speckles: ["#78716c", "#f87171"] },
      wild: { fill: "#1c1917", speckles: ["#292524", "#44403c"] },
    },
    path: { fill: "#a8a29e", edge: "#e7e5e4" },
    scatter: {
      pebbles: "#a8a29e",
      tuft: "#65a30d",
      flowers: "#f472b6",
      crack: "#292524",
      puddle: "#38bdf8",
      leaves: "#4d7c0f",
    },
    building: {
      private: { body: "#44403c", roof: "#1c1917" },
      public_view: { body: "#78716c", roof: "#d6d3d1", glass: "rgba(191,219,254,0.45)" },
      public_write: { body: "#a8a29e", roof: "#fbbf24" },
    },
    landmark: {
      plaza: { body: "#78716c", accent: "#fbbf24" },
      library: { body: "#57534e", accent: "#e7e5e4" },
      workshop: { body: "#44403c", accent: "#fb923c" },
      stage: { body: "#3f3f46", accent: "#f472b6" },
      garden: { body: "#3f6212", accent: "#a3e635" },
      board: { body: "#57534e", accent: "#f87171" },
    },
    scaffold: { timber: "#a8a29e", cloth: "#fbbf24" },
    prop: { metal: "#a1a1aa", wood: "#78716c", plant: "#65a30d", fire: "#fb923c", water: "#38bdf8" },
    human: {
      skin: "#e8b894",
      head: "cap",
      headColour: "#1e3a5f",
      torso: "#1d4ed8",
      legs: "#1e3a8a",
      accent: "#fbbf24",
    },
    agent: {
      skin: "#fde68a",
      head: "cap",
      headColour: "#b45309",
      torso: "#f59e0b",
      legs: "#92400e",
      accent: "#fef3c7",
    },
    critter: "pigeon",
    speech: { bg: "rgba(15,23,42,0.92)", fg: "#f8fafc", border: "#94a3b8" },
  }),
} satisfies Theme;
