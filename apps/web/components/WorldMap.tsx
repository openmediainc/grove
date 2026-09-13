"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { asPermissionBadges, consequenceOf, STANCES } from "@grove/ui";
import { describeToolCall, type ToolCallView } from "@grove/protocol";
import { api } from "@/lib/api";
import {
  BUILDING,
  CIVIC,
  SCAFFOLD,
  SCATTER_KEYS,
  type AccessLevel,
  type CharKey,
  type ItemKey,
} from "@/lib/art";
import {
  DEFAULT_THEME,
  THEME_IDS,
  THEME_QUERY,
  THEMES,
  readThemeChoice,
  themeStyle,
  writeThemeChoice,
  type Theme,
  type ThemeId,
} from "@/lib/themes";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { HAZARD_COLOUR, STALL_RING, type HazardTone } from "@/lib/themes/types";
import { gp } from "@/lib/base";
import { MotionDirector, mergeSpan, spanFromWire, OUTCOME_MARK_MS } from "@/lib/motion/director";
import { drawOutcomeMark, drawStanceMark, drawWorkBar, scaffoldStageFor } from "@/lib/motion/marks";
import {
  groveVerb,
  isActiveVerb,
  paperclipVerb,
  regionForVerb,
  VERB_LABEL,
  VERB_RING,
  type AgentVerb,
} from "@/lib/agent-verbs";
import {
  MAP_COLS,
  MAP_ROWS,
  PLAZA_CENTER,
  PLOT_COLS,
  PLOT_ROWS,
  REGION_RECTS,
  exploreRadius,
  isCoreTile,
  plotForIndex,
  regionAt,
  seatInRegion,
  tileExplored,
  worldBounds,
  type MapRegion,
} from "@/lib/map-layout";
import { SpectatorPeek, type OrgBadge, type Peek } from "./SpectatorPeek";
import { AttentionBell } from "./AttentionBell";
import { CameraBookmarks, type Bookmark } from "./CameraBookmarks";
import { KIOSK_ATTR, KioskChrome } from "./KioskChrome";
import { ResourceBar } from "./ResourceBar";
import { CostCarry } from "./costCarry";
import { resourceTerms } from "@/lib/cost";
import { skyAt, type Sky } from "./skyClock";
import {
  DEPART_MS,
  ELSEWHERE,
  bodyHealth,
  healthColour,
  healthNote,
  healthVisible,
  sleepingAlpha,
  type Health,
} from "./presenceHealth";
import {
  CIVIC_LAMPS,
  CIVIC_PLACEMENTS,
  LAMP_STRIDE,
  PROPS,
  SHEEP,
  STREET_LAMPS,
  pathMaskAt,
  scatterAt,
  sheepAt,
  tileBlocked,
} from "./worldDressing";

const TW = 64;
const TH = 32;
const FOG_KEY = "grove-fog-radius";
/** Tiles beyond fog + this are never drawn; bounds per-frame work as the world grows. */
const HORIZON = 8;

/* --- view transform ------------------------------------------------ *
 * Everything on the map lives in "layout space": the world-space iso
 * position of a tile plus the centring offset from origin(). Screen
 * (CSS px) = layout * zoom + pan. One function forward, one inverse —
 * drawing and hit-testing must never compute this independently or the
 * cursor drifts away from what you can see.
 * ------------------------------------------------------------------- */
type View = { zoom: number; px: number; py: number };
const MAX_ZOOM = 2.5;
const NOMINAL_MIN_ZOOM = 0.4;
/** Never let the world be dragged further out than this many px of it left on screen. */
const PAN_MARGIN = 140;
/** Below this zoom, nameplates and task captions are dropped (level of detail). */
const LOD_LABELS = 0.7;
/** Below this zoom, claimed-plot labels are dropped too. */
const LOD_PLOTS = 0.5;
/** Every prop is 1x1; the theme decides how tall. */
const PROP_FOOTPRINT = { fw: 1, fh: 1 } as const;
/** The dressing's sheep frames, named as the contract's ambient poses. */
const AMBIENT_POSE = {
  "sheep-graze": "graze",
  "sheep-idle": "idle",
  "sheep-walk-a": "walk-a",
  "sheep-walk-b": "walk-b",
} as const;
/** Captions are clipped to roughly the body sprite's width. */
const BODY_W = 40;
const CAPTION_W = 48;
/**
 * Level of detail for the world dressing.
 *
 * Props, carried items and scaffolding are the same size as a body, so they
 * live and die with the plot buildings. Scatter and sheep are smaller and much
 * more numerous: a whole campus of speckle is what the art pass warned reads as
 * scree when zoomed out, and four sheep at 0.4x are four white blobs. Those
 * drop out one step earlier, with the nameplates.
 *
 * Paths are deliberately NOT gated. At minimum zoom they are the only thing
 * that says the six regions are one campus rather than six islands.
 */
const LOD_DRESSING = LOD_PLOTS;
const LOD_SCATTER = LOD_LABELS;
/**
 * Scaffolding used to grow on a clock: 90 s to stage 2, 5 min to stage 3, from
 * when this tab first saw a url. A clock is not progress, so that is gone. The
 * stage now follows a tool-call span's REPORTED progress, and a site with none
 * stays at stage 1 — staked out, amount unknown. See docs/design/MOTION.md §6.
 */

/* --- the hour ------------------------------------------------------ *
 * Day and night, from skyClock.ts. Two things live here rather than there
 * because they are about DRAWING the hour, not about what the hour is.
 * ------------------------------------------------------------------- */

/**
 * Street lamps bloom with the props they belong to; civic windows never gate.
 * The sky wash itself has NO level-of-detail gate at all, and that is the
 * considered answer for 0.4x: zoomed out, the whole campus is the subject and
 * its colour is the only thing still big enough to tell you the hour. Every
 * detail that could say it instead — a lit window, a lantern, a shadow — is
 * two pixels wide down there. The tint is the one signal that survives.
 */
const LOD_LAMPS = LOD_PLOTS;
/** Below this the lamps are not worth compositing at all. */
const LAMP_FLOOR = 0.03;
/** How much of the glow sprite's own alpha the hour is allowed to spend. */
const LAMP_GAIN = 0.85;

/** Where the camera lands when a bookmark is pressed. One zoom for all of them,
 *  so every jump arrives framed the same way whatever you were looking at. */
const BOOKMARK_ZOOM = 1.15;
/** The wide shot at the end of the kiosk tour. */
const KIOSK_WIDE_ZOOM = 0.45;
/** How long a kiosk tour stop is held before gliding to the next. */
const KIOSK_STOP_MS = 26_000;
/** A person who touches the map gets it to themselves for this long. */
const KIOSK_YIELD_MS = 60_000;
/** A glide that cannot reach its mark (clamped at the world edge) gives up here. */
const GLIDE_GIVE_UP_MS = 4_000;
/** If the minimap does not say, assume the documented 180s stall threshold. */
const DEFAULT_STALL_SECONDS = 180;

type GroveBody = {
  stalled?: boolean;
  error_text?: string | null;
  errorText?: string | null;
  url?: string | null;
  badges?: string[];
  id: string;
  kind: "human" | "agent";
  display_name?: string;
  displayName?: string;
  slug: string;
  room_slug?: string;
  roomSlug?: string;
  activity: string;
  connection: string;
  verb?: string | null;
  detail?: string | null;
  pulsed_at?: string | null;
  pulsedAt?: string | null;
  /** Server-measured seconds since this body last reported. Null = never has. */
  pulse_age_seconds?: number | null;
  pulseAgeSeconds?: number | null;
  /** Org tint, resolved server-side by minimap(): null = no org here. */
  org_id?: string | null;
  orgId?: string | null;
  org_colour?: string | null;
  orgColour?: string | null;
  /** A usage report just landed: time and priced-or-not, never an amount. See costCarry.ts. */
  deposit?: { at: string; costed: boolean } | null;
  /** Agent stance (autonomy_mode); null for humans. */
  stance?: string | null;
  /** Open tool-call spans, then any finished in the last 30 s (migration 020). */
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  source: "grove";
};

/** A pulse older than this is stale; fall back to inferring from presence. */
const PULSE_FRESH_MS = 90_000;

type PaperclipBody = {
  id: string;
  name: string;
  status: string;
  role: string;
  title: string | null;
  adapter_type?: string;
  adapterType?: string;
  last_heartbeat_at?: string | null;
  lastHeartbeatAt?: string | null;
};

type PaperclipIssue = {
  identifier: string;
  status: string;
  assignee_agent_id?: string | null;
  assigneeAgentId?: string | null;
  execution_state?: string | null;
  executionState?: string | null;
  title: string;
};

type SpaceView = {
  id: string;
  plot_index?: number;
  plotIndex?: number;
  policy_preset?: string;
  policyPreset?: string;
  name: string | null;
  slug: string | null;
  owner_handle?: string | null;
  ownerHandle?: string | null;
  occupancy: number;
  /** Bound orgs. Empty for a redacted row, exactly like name and owner. */
  orgs?: OrgBadge[];
};

type Plot = {
  id: string;
  rect: { x0: number; y0: number; x1: number; y1: number };
  plotIndex: number;
  preset: string;
  name: string | null;
  slug: string | null;
  ownerHandle: string | null;
  occupancy: number;
  orgs: OrgBadge[];
};

/*
 * Access-level words, room names and every other UI word the map says now come
 * from the active theme's lexicon (lib/themes). Access level is public even
 * when the space's contents are not.
 */
function accessLabel(theme: Theme, preset: string): string {
  return (theme.lexicon.access as Record<string, { label: string } | undefined>)[preset]?.label ?? preset;
}
function accessBlurb(theme: Theme, preset: string): string {
  return (
    (theme.lexicon.access as Record<string, { blurb: string } | undefined>)[preset]?.blurb ??
    theme.lexicon.accessUnknown
  );
}
function regionTitle(theme: Theme, region: string): string {
  return (theme.lexicon.regions as Record<string, { title: string } | undefined>)[region]?.title ?? region;
}

type Minimap = {
  /** The world's stall threshold, so the map never hard-codes its own. */
  stall_after_seconds?: number;
  stallAfterSeconds?: number;
  /** How this world paints bound orgs; see campus.orgRenderFor(). */
  org_render_mode?: "shared" | "dedicated";
  orgRenderMode?: "shared" | "dedicated";
  /** Legend for the colours the bodies are flying. */
  orgs?: OrgBadge[];
  recent_speech?: RecentLine[];
  recentSpeech?: RecentLine[];
  bodies?: GroveBody[];
  spaces?: SpaceView[];
  claimed_agents?: number;
  claimedAgents?: number;
  paperclip?: { ok: boolean; agents: PaperclipBody[]; issues?: PaperclipIssue[] };
};

type Actor = {
  id: string;
  name: string;
  kind: "human" | "agent" | "paperclip";
  region: MapRegion;
  activity: string;
  verb: AgentVerb;
  source: "grove" | "paperclip";
  bubble?: string;
  detail?: string;
  stalled?: boolean;
  errorText?: string | null;
  url?: string | null;
  badges?: string[];
  orgId?: string | null;
  orgName?: string | null;
  orgColour?: string | null;
  /** Carries a prompt_injection_flag in the chronicle's last 24h. */
  flagged?: boolean;
  /** Presence connection, verbatim: "live" | "async" | "offline". */
  connection?: string;
  /** Server-measured seconds since it last reported; null if it never has. */
  pulseAgeSeconds?: number | null;
  /** Offline, so counting down to eviction. Set from `connection`, not inferred. */
  fading?: boolean;
  /** When it last pulsed, verbatim. The motion model dates an errand from it. */
  pulsedAt?: string | null;
  /** Its tool-call spans, as the server published them. Empty = no shape reported. */
  toolCalls?: ToolCallView[];
  /** Stance (autonomy_mode), agents only. */
  stance?: string | null;
};

/**
 * A body that has left the map, kept for as long as it takes to see it go.
 *
 * The world deletes a presence row ten minutes after the last heartbeat, and
 * the map polls every eight seconds, so before this a body's last act was to be
 * absent from a poll — which renders as a sprite vanishing between two frames
 * with nothing to distinguish it from a bug. A departure is the same body, in
 * the same seat, fading out of it.
 *
 * Eviction is the common cause but not the only one: a block, a room change or
 * a redaction can also take a body off the public map. The animation says "this
 * body left the map", which is true in all of them, and claims nothing about why.
 */
type Departure = { x: number; y: number; alpha: number; sprite: CharKey; at: number };

type RecentLine = { speech_id?: string; speechId?: string; sender_id?: string; senderId?: string; sender_name?: string; senderName?: string; body: string };

/* --- hazards ------------------------------------------------------- *
 * Three states a watcher has to be able to see from across the world,
 * ranked by how much they want a human:
 *
 *   flag  — the chronicle has a prompt_injection_flag against this body.
 *   fault — it says it has errored, or something is blocking it.
 *   stall — the server marked it stalled: claims to be working, has gone
 *           quiet for longer than stall_after_seconds.
 *
 * They are NOT drawn in layout space. Everything else on the map shrinks
 * with the zoom, which is correct for scenery and wrong for an alarm: at
 * 0.4x a layout-space marker is four pixels and says nothing. These are
 * drawn in screen space at a fixed size, so a faulted body is equally loud
 * whether you are looking at one room or the whole campus.
 * ------------------------------------------------------------------- */
function hazardOf(a: Actor): HazardTone | null {
  if (a.flagged) return "flag";
  if (a.verb === "error" || a.verb === "blocked") return "fault";
  if (a.stalled) return "stall";
  return null;
}

/**
 * Order the bell cycles in: hazards, then stalls, then bodies drifting toward
 * eviction, then the merely idle.
 *
 * "Fading" earns its own rank between the two because it is a different kind of
 * thing from either neighbour. A stall is a fault to fix. An idle body is a
 * thing to notice. A fading body is neither: nothing is wrong with it, but it
 * has a deadline, and after the deadline there is nothing left to look at.
 */
function attentionRank(a: Actor): number {
  const h = hazardOf(a);
  if (h === "flag" || h === "fault") return 0;
  if (h === "stall") return 1;
  if (isActiveVerb(a.verb)) return -1;
  return a.fading ? 2 : 3;
}

/**
 * What a body is carrying. The verb glyph beside the sprite says the same
 * thing in the abstract; an item in the hand says it as a picture, so where
 * there is an item the glyph stands down rather than saying it twice.
 */
function itemForActor(a: Actor): ItemKey | null {
  if (a.verb === "read") return "document";
  if (a.verb === "tool") return "tool";
  if (a.verb === "think") return "lamp";
  // "Carried while claiming or planting a new space" — the Garden is where a
  // body with nothing to do goes, and a cutting is what it does there.
  if (a.region === "garden" && a.verb === "idle") return "seedling";
  return null;
}

/**
 * Below this zoom a body is a few pixels of sprite, so its pennant would be a
 * coloured speck among hundreds. Org colour survives on the plot fences, which
 * stay legible zoomed out; the per-body marks drop out instead of turning into
 * noise.
 */
const LOD_ORG = LOD_PLOTS;

/**
 * The six rooms, in the order the campus lists them, bound to the digits above
 * them. `0` is already "back to the core", so the rooms start at 1 and the two
 * computed destinations take letters instead of running into `7`.
 */
/** The six named rooms. `wild` is the rest of the world, and not a destination. */
type RoomRegion = Exclude<MapRegion, "wild">;

const BOOKMARK_REGIONS: ReadonlyArray<{ key: string; region: RoomRegion }> = [
  { key: "1", region: "plaza" },
  { key: "2", region: "library" },
  { key: "3", region: "workshop" },
  { key: "4", region: "stage" },
  { key: "5", region: "garden" },
  { key: "6", region: "board" },
];

/** Every key that jumps the camera, for the one test the key handler needs. */
const BOOKMARK_KEYS: ReadonlySet<string> = new Set([
  ...BOOKMARK_REGIONS.map((b) => b.key),
  "b",
  "m",
]);

/**
 * The kiosk tour: the six landmarks, then one wide shot of the whole campus.
 *
 * Precomputed from the region table, not from anything that moves, and the stop
 * is chosen by dividing the wall clock — so two displays side by side show the
 * same room at the same moment, a reload rejoins the tour where it already was,
 * and nothing here can shimmer or reorder on a poll.
 */
const KIOSK_STOPS: ReadonlyArray<{ tx: number; ty: number; zoom: number }> = [
  ...BOOKMARK_REGIONS.map(({ region }) => {
    const r = REGION_RECTS[region];
    return { tx: (r.x0 + r.x1) / 2, ty: (r.y0 + r.y1) / 2, zoom: BOOKMARK_ZOOM };
  }),
  { tx: PLAZA_CENTER.x, ty: PLAZA_CENTER.y, zoom: KIOSK_WIDE_ZOOM },
];

function spriteKey(kind: Actor["kind"], verb: AgentVerb): CharKey {
  if (kind === "human") {
    if (verb === "say") return "human-speak";
    if (verb === "read" || verb === "wait" || verb === "think") return "human-side";
    return "human-front";
  }
  if (verb === "tool" || verb === "error") return "agent-work";
  if (verb === "read" || verb === "wait" || verb === "think") return "agent-side";
  return "agent-front";
}

type Seat = { x: number; y: number };

/** How far a crowd may spill past its region before we accept overlap. */
const SPILL_RINGS = 6;


/**
 * Bodies must never share a tile — a stack of overlapping sprites is the fastest
 * way to make a living world look broken. Hash gives each actor a preferred
 * seat; collisions probe forward deterministically through the region.
 *
 * Since the campus got furniture, the probe also steps over tiles the dressing
 * owns: a civic building's footprint and every prop tile. A body standing on a
 * bench looks like a bug, and a body standing inside the Library looks like the
 * Library is see-through. Both regions keep well over half their tiles free, so
 * the spill rings below are no likelier to fire than before.
 */
function assignSeats(actors: Actor[]): Map<string, Seat> {
  const out = new Map<string, Seat>();
  const taken = new Set<string>();
  const byRegion = new Map<MapRegion, Actor[]>();
  for (const a of actors) {
    const list = byRegion.get(a.region) ?? [];
    list.push(a);
    byRegion.set(a.region, list);
  }
  for (const [region, list] of byRegion) {
    const rect = REGION_RECTS[region === "wild" ? "plaza" : region];
    const w = rect.x1 - rect.x0 + 1;
    const h = rect.y1 - rect.y0 + 1;
    const slots = w * h;
    // Sort for stability: the same set of actors always lays out the same way.
    for (const a of [...list].sort((p, q) => (p.id < q.id ? -1 : 1))) {
      const pref = seatInRegion(a.id, region);
      let idx = (pref.y - rect.y0) * w + (pref.x - rect.x0);
      let seat: Seat | null = null;
      for (let n = 0; n < slots; n++) {
        const i = (idx + n) % slots;
        const x = rect.x0 + (i % w);
        const y = rect.y0 + Math.floor(i / w);
        const key = `${x},${y}`;
        if (!taken.has(key) && !tileBlocked(x, y)) {
          taken.add(key);
          seat = { x, y };
          break;
        }
      }
      // Region full. Rather than stacking sprites — the fastest way to make a
      // living world look broken — spill into the ground just outside it, in
      // expanding rings, so a crowd visibly overflows its room.
      if (!seat) {
        outer: for (let ring = 1; ring <= SPILL_RINGS; ring++) {
          for (let y = rect.y0 - ring; y <= rect.y1 + ring; y++) {
            for (let x = rect.x0 - ring; x <= rect.x1 + ring; x++) {
              const onRing =
                x === rect.x0 - ring || x === rect.x1 + ring || y === rect.y0 - ring || y === rect.y1 + ring;
              if (!onRing) continue;
              const key = `${x},${y}`;
              if (taken.has(key) || tileBlocked(x, y)) continue;
              taken.add(key);
              seat = { x, y };
              break outer;
            }
          }
        }
      }
      out.set(a.id, seat ?? pref);
    }
  }
  return out;
}

/**
 * One sentence a watcher can act on.
 *
 * This used to be a hand-copied cascade of the vocabulary in
 * packages/ui/src/consequences.ts, on the reasoning that the map draws to
 * canvas and cannot render React components. True of the components — and not
 * true of `speechState()` / `consequenceOf()`, which are pure functions over a
 * badge list and come out of the same `@grove/ui` entry point this app already
 * imports from in RoomPresence. So the copy is gone and the canonical reducer
 * is called directly, which is the only version of "the map says what the room
 * says" that cannot drift.
 *
 * The copy had drifted three ways by the time it was replaced, and every one of
 * them was the map stating something false:
 *
 *  - it knew nothing about the EAR half of the matrix, so an agent with
 *    `listenToHumans: false` was described as one that can hear you;
 *  - it tested for a badge named `lurking`, which does not exist — the badge is
 *    `lurk` — so that branch had never once fired;
 *  - it returned "will only reply to other agents" for any body carrying
 *    `speaks_to_agents`, including the ones that also carry `speaks_to_humans`.
 *    With all four permissions defaulting to true, that was most of the campus.
 *
 * `silencedBySpace` is not passed: the public minimap carries no per-room say
 * permission, and guessing at one would put the map right back in the business
 * of inventing sentences.
 */
/**
 * What a body's tool calls say, as sentences for the hover card and peek: the
 * call running now (or gone quiet), then the most recent finish while the
 * server still carries it. Nothing when the body reports no spans.
 */
function toolLines(a: Actor): string[] {
  const calls = a.toolCalls ?? [];
  const out: string[] = [];
  const open = calls.find((c) => c.finishedAt === null);
  if (open) out.push(`${open.stalled ? "Tool gone quiet" : "Running"}: ${describeToolCall(open)}`);
  const done = calls.find((c) => c.finishedAt !== null);
  if (done) out.push(`Last tool: ${describeToolCall(done)}${done.result ? ` — ${done.result}` : ""}`);
  return out;
}

function badgeConsequence(badges?: string[]): string | null {
  return consequenceOf(asPermissionBadges(badges));
}

function iso(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx - ty) * (TW / 2), y: (tx + ty) * (TH / 2) };
}

/** Inverse of iso(). Kept next to it so the two can never drift apart. */
function unIso(x: number, y: number): { tx: number; ty: number } {
  return { tx: (x / (TW / 2) + y / (TH / 2)) / 2, ty: (y / (TH / 2) - x / (TW / 2)) / 2 };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function readMaxFog(): number {
  try {
    const n = Number(window.localStorage.getItem(FOG_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeMaxFog(n: number): void {
  try {
    window.localStorage.setItem(FOG_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/** Trim to fit `maxW`, with an ellipsis, so a long task title never bleeds into a neighbour. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

/**
 * The heartbeat ring: how much of this body's seat is left.
 *
 * Drawn in SCREEN space at a fixed size, for the same reason the hazard
 * triangle is. Everything else on this map shrinks with the zoom, which is
 * right for scenery and wrong for a deadline — at 0.4x a layout-space meter is
 * two pixels and says nothing, and the whole point of this mark is that you can
 * see an agent drifting from across the campus rather than discovering the
 * empty seat afterwards.
 *
 * It reads as a clock face emptying clockwise. Nothing is drawn at all while a
 * body is beating normally, so the presence of the ring is itself the signal,
 * and a healthy campus carries no marks.
 */
function drawHealthMark(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  drift: number,
  t: number,
  animate: boolean,
): void {
  const remain = Math.max(0.03, 1 - drift);
  ctx.save();
  ctx.translate(Math.round(sx), Math.round(sy));
  // Dark backing, then a faint full ring: the empty part of the clock has to be
  // visible too, or a nearly-evicted body reads as an unfinished scratch.
  ctx.strokeStyle = "rgba(7,8,20,0.88)";
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(236,231,221,0.16)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = animate ? 0.72 + 0.28 * Math.sin(t / 420) : 1;
  ctx.strokeStyle = healthColour(drift);
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(0, 0, 6.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remain);
  ctx.stroke();
  ctx.restore();
}

export function WorldMap() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorsRef = useRef<Actor[]>([]);
  const costCarryRef = useRef(new CostCarry());
  const radiusRef = useRef(4);
  const plotsRef = useRef(0);
  const plotRef = useRef<Plot[]>([]);
  const seatsRef = useRef<Map<string, Seat>>(new Map());
  const lastHeardRef = useRef<string | null>(null);
  /** Where every body is going and why: docs/design/MOTION.md. */
  const motionRef = useRef<MotionDirector | null>(null);
  if (!motionRef.current) motionRef.current = new MotionDirector();
  const hoverRef = useRef<Actor | null>(null);
  /** The last few public lines, for the spectator panel. */
  const recentRef = useRef<Array<{ who: string; body: string }>>([]);
  /** null until /humans/me answers. Nothing on the map waits for it. */
  const signedInRef = useRef<boolean | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const followRef = useRef<string | null>(null);
  /** Bodies that want a human, hazards first. Rebuilt on every poll. */
  const attentionRef = useRef<Actor[]>([]);
  const attnIdxRef = useRef(0);
  const [attnPos, setAttnPos] = useState<string | null>(null);
  /** Actor ids with a prompt_injection_flag in the chronicle's last 24h. */
  const flaggedRef = useRef<Set<string>>(new Set());
  /** Poll counter, so the chronicle is asked a quarter as often as the minimap. */
  const pullNoRef = useRef(0);
  /** Called by the "." key; owned by the effect that builds the attention list. */
  const cycleRef = useRef<() => void>(() => {});
  /** Called by the bookmark keys; owned by the effect that can resolve them. */
  const jumpRef = useRef<(key: string) => void>(() => {});
  /** Called by the K and Escape keys, which live in an effect that must not
   *  be torn down and rebuilt every time kiosk mode is toggled. */
  const kioskModeRef = useRef<(on: boolean) => void>(() => {});
  const viewRef = useRef<View>({ zoom: 1, px: 0, py: 0 });
  /**
   * The theme being DRAWN. Read once per frame by the renderer, so a switch
   * re-skins the next frame with no remount; see lib/themes for the contract.
   */
  const themeRef = useRef<Theme>(THEMES[DEFAULT_THEME]);
  /**
   * The theme the viewer CHOSE. The chrome follows it at once; the canvas
   * follows it as soon as its art is prepared, so a switch never paints a
   * frame of missing sprites.
   */
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME);
  const chosenRef = useRef<Theme>(THEMES[DEFAULT_THEME]);
  const theme = THEMES[themeId];
  const lex = theme.lexicon;
  const controlsRef = useRef<{
    zoomBy: (f: number) => void;
    reset: () => void;
    goTo: (tx: number, ty: number, zoom: number) => void;
  } | null>(null);
  /** The world's own stall threshold, straight off the minimap. */
  const stallSecondsRef = useRef(DEFAULT_STALL_SECONDS);
  /**
   * When THIS TAB first saw each body sitting offline. The minimap does not
   * publish last_seen_at, so this is the only measured interval available for
   * the fade toward eviction — see presenceHealth.ts for why that is stated as
   * a lower bound rather than dressed up as an absolute.
   */
  const offlineSinceRef = useRef<Map<string, number>>(new Map());
  /** Bodies that have left the map, still playing their departure. */
  const departedRef = useRef<Map<string, Departure>>(new Map());
  /** Where each body was last drawn, so a departure can start from its seat. */
  const lastPosRef = useRef<Map<string, Departure>>(new Map());
  /** The signed-in viewer's handle, for the "my space" bookmark. Null = unknown. */
  const myHandleRef = useRef<string | null>(null);
  const [hasMySpace, setHasMySpace] = useState(false);
  /** An eased camera move to a bookmark. Cleared by any drag, wheel or follow. */
  const glideRef = useRef<{ tx: number; ty: number; zoom: number; start: number } | null>(null);
  const [kiosk, setKiosk] = useState(false);
  const kioskRef = useRef(false);
  /** Kiosk yields to a person who touches the map, rather than fighting them. */
  const kioskYieldRef = useRef(0);
  const tourStopRef = useRef(-1);
  /** Null until the clock effect runs: the server has no hour to render. */
  const [sky, setSky] = useState<Sky | null>(null);
  const [hud, setHud] = useState({
    lastHeard: "",
    world: "",
    spaces: 0,
    grove: 0,
    paperclip: 0,
    claimed: 0,
    paperclipOk: false,
    radius: 4,
    awake: 0,
    asleep: 0,
    orgs: [] as OrgBadge[],
    orgMode: "shared" as "shared" | "dedicated",
    attn: { idle: 0, stalled: 0, hazard: 0, fading: 0 },
  });
  const [status, setStatus] = useState("charting the dusk…");

  const zoomIn = useCallback(() => controlsRef.current?.zoomBy(1.25), []);
  const zoomOut = useCallback(() => controlsRef.current?.zoomBy(1 / 1.25), []);
  const resetView = useCallback(() => controlsRef.current?.reset(), []);
  /**
   * Re-skin the world live. `persist` is false for the choice read on mount
   * (it is already wherever it came from) and true for a viewer's click. If
   * the URL is pinning a theme, the pin is moved too, so the address bar never
   * disagrees with what is on screen.
   */
  const applyTheme = useCallback((id: ThemeId, persist: boolean) => {
    const next = THEMES[id];
    chosenRef.current = next;
    setThemeId(id);
    void next.art.prepare().then(() => {
      if (chosenRef.current === next) themeRef.current = next;
    });
    if (!persist) return;
    writeThemeChoice(id);
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(THEME_QUERY)) {
        url.searchParams.set(THEME_QUERY, id);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      /* the theme still switches */
    }
  }, []);
  const themeKeyRef = useRef<() => void>(() => {});
  useEffect(() => {
    themeKeyRef.current = () => {
      const i = THEME_IDS.indexOf(chosenRef.current.id);
      applyTheme(THEME_IDS[(i + 1) % THEME_IDS.length]!, true);
    };
  }, [applyTheme]);
  // Deliberately after mount: the server renders the default, and a stored
  // choice that differed would otherwise be a hydration mismatch.
  useEffect(() => {
    applyTheme(readThemeChoice(), false);
  }, [applyTheme]);

  const stopFollowing = useCallback(() => {
    followRef.current = null;
    setFollowing(null);
    setAttnPos(null);
  }, []);

  /**
   * The bell. Hands the next body that wants attention to the follow-cam that
   * already exists — this deliberately does not move the view itself, because
   * a second camera would fight the first one the moment someone panned.
   */
  const cycleAttention = useCallback(() => {
    const list = attentionRef.current;
    if (list.length === 0) return;
    const i = attnIdxRef.current % list.length;
    attnIdxRef.current = (i + 1) % list.length;
    const target = list[i]!;
    followRef.current = target.id;
    setFollowing(target.name);
    setAttnPos(`${i + 1}/${list.length}`);
  }, []);
  useEffect(() => {
    cycleRef.current = cycleAttention;
  }, [cycleAttention]);

  /* --- the campus clock -------------------------------------------- *
   * The renderer reads the hour itself, every frame, straight from the wall
   * clock; this is only the HUD's copy of it. Deliberately null on the first
   * render: this is a client component, but Next still renders it on the
   * server, and a clock that differs between the two is a hydration mismatch.
   * Fifteen seconds is fast enough for a display that shows minutes.
   * ------------------------------------------------------------------ */
  useEffect(() => {
    const tick = () =>
      setSky((prev) => {
        const next = skyAt(Date.now());
        return prev && prev.clock === next.clock && prev.label === next.label ? prev : next;
      });
    tick();
    const t = window.setInterval(tick, 15_000);
    return () => window.clearInterval(t);
  }, []);

  /* --- kiosk mode ---------------------------------------------------- *
   * Entered by ?kiosk=1 so a wall display is a bookmark, and by the button or
   * K for everyone else. Leaving strips the parameter, so a reload does not
   * walk straight back in — and KioskChrome always draws a visible way out, so
   * someone who walks up to the Mini and taps the screen is never trapped in a
   * mode they did not know they were in.
   * ------------------------------------------------------------------- */
  const setKioskMode = useCallback((on: boolean) => {
    kioskRef.current = on;
    tourStopRef.current = -1;
    setKiosk(on);
    try {
      if (on) document.documentElement.setAttribute(KIOSK_ATTR, "1");
      else document.documentElement.removeAttribute(KIOSK_ATTR);
      const url = new URL(window.location.href);
      if (on) url.searchParams.set("kiosk", "1");
      else url.searchParams.delete("kiosk");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* A browser that refuses either of those still gets the mode itself. */
    }
  }, []);

  useEffect(() => {
    kioskModeRef.current = setKioskMode;
  }, [setKioskMode]);

  useEffect(() => {
    let wanted = false;
    try {
      const q = new URLSearchParams(window.location.search).get("kiosk");
      wanted = q !== null && q !== "0" && q !== "false";
    } catch {
      wanted = false;
    }
    if (wanted) setKioskMode(true);
    return () => {
      // The attribute lives on <html>, outside React's tree, so it has to be
      // taken off by hand or navigating away leaves the nav hidden.
      try {
        document.documentElement.removeAttribute(KIOSK_ATTR);
      } catch {
        /* ignore */
      }
    };
  }, [setKioskMode]);

  /* --- camera bookmarks --------------------------------------------- *
   * Keys, resolved against what the map already holds. Nothing here consults
   * the clock, Math.random or poll order: the busiest room is decided by a
   * strict majority over the fixed region order, so a tie always resolves the
   * same way and pressing B twice in a row never lands somewhere else.
   * ------------------------------------------------------------------- */
  const jumpTo = useCallback((key: string) => {
    const go = controlsRef.current?.goTo;
    if (!go) return;
    const region = BOOKMARK_REGIONS.find((b) => b.key === key)?.region;
    if (region) {
      const r = REGION_RECTS[region];
      go((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, BOOKMARK_ZOOM);
      return;
    }
    if (key === "b") {
      let best: RoomRegion = "plaza";
      let bestN = -1;
      for (const { region: r } of BOOKMARK_REGIONS) {
        const n = actorsRef.current.reduce((acc, a) => acc + (a.region === r ? 1 : 0), 0);
        // Strictly greater, walked in a fixed order: a tie keeps the earlier room.
        if (n > bestN) {
          bestN = n;
          best = r;
        }
      }
      const r = REGION_RECTS[best];
      go((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, BOOKMARK_ZOOM);
      return;
    }
    if (key === "m") {
      const handle = myHandleRef.current;
      if (!handle) return;
      const mine = plotRef.current
        .filter((p) => p.ownerHandle === handle)
        .sort((p, q) => p.plotIndex - q.plotIndex)[0];
      if (!mine) return;
      go((mine.rect.x0 + mine.rect.x1) / 2, (mine.rect.y0 + mine.rect.y1) / 2, BOOKMARK_ZOOM);
    }
  }, []);
  useEffect(() => {
    jumpRef.current = jumpTo;
  }, [jumpTo]);

  const bookmarks: Bookmark[] = [
    ...BOOKMARK_REGIONS.map(({ key, region }) => ({
      key,
      label: lex.regions[region].title,
      title: lex.regions[region].bookmark,
    })),
    { key: "b", label: lex.controls.busiest, title: lex.controls.busiestTitle },
    ...(hasMySpace ? [{ key: "m", label: lex.controls.mySpace, title: lex.controls.mySpaceTitle }] : []),
  ];

  // Who is watching. Deliberately its own effect, deliberately not awaited by
  // anything that draws: the map must paint for a spectator exactly as fast as
  // it does for a member, so this only ever changes what a CLICK does.
  useEffect(() => {
    let cancelled = false;
    void api<{ human: { id: string; handle?: string } }>("/api/v1/humans/me")
      .then((res) => {
        if (cancelled) return;
        signedInRef.current = true;
        // The handle is what the public minimap names a plot's owner with, so
        // it is the one field that lets "my space" be resolved without asking
        // a second endpoint for something the map already has.
        myHandleRef.current = res.human?.handle ?? null;
        setSignedIn(true);
      })
      .catch(() => {
        if (cancelled) return;
        signedInRef.current = false;
        setSignedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const data = await api<Minimap>("/api/v1/world/minimap");
        if (cancelled) return;
        // Injection flags come from the chronicle, not the minimap, and cost a
        // real query, so they are refreshed every fourth poll rather than every
        // one. The chronicle decides in SQL who may see a moderation row: a
        // signed-out spectator gets an empty page, and the count is then
        // honestly zero rather than withheld.
        if (pullNoRef.current % 4 === 0) {
          try {
            const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
            const flags = await api<{ entries: Array<{ actor: { id: string } | null }> }>(
              `/api/v1/chronicle?types=prompt_injection_flag&limit=100&since=${encodeURIComponent(since)}`,
            );
            if (cancelled) return;
            flaggedRef.current = new Set(
              flags.entries.map((e) => e.actor?.id).filter((id): id is string => Boolean(id)),
            );
          } catch {
            /* Not readable by this viewer. Leave the last known set alone. */
          }
        }
        pullNoRef.current += 1;
        const flaggedIds = flaggedRef.current;
        const orgList = (data.orgs ?? []).map((o) => ({ id: o.id, name: o.name, colour: o.colour }));
        const orgById = new Map(orgList.map((o) => [o.id, o]));
        const orgMode = data.org_render_mode ?? data.orgRenderMode ?? "shared";
        const grove = (data.bodies ?? []).map((b) => {
          const room = (b.room_slug ?? b.roomSlug ?? "plaza") as MapRegion;
          const region =
            room === "plaza" || room === "library" || room === "workshop" || room === "stage" || room === "garden" || room === "board"
              ? room
              : "plaza";
          // A self-reported pulse wins over what we can infer from presence,
          // but only while it is fresh — a dead runtime must not look busy forever.
          const pulsedAt = b.pulsed_at ?? b.pulsedAt ?? null;
          const fresh =
            Boolean(pulsedAt) && Date.now() - Date.parse(String(pulsedAt)) < PULSE_FRESH_MS;
          const pulsed = fresh && b.verb && b.verb in VERB_LABEL ? (b.verb as AgentVerb) : null;
          const verb = pulsed ?? groveVerb(b.activity, b.connection);
          // The tint is already resolved server-side (own org when the space is
          // shared, the host org when it is dedicated), so the map only paints.
          const orgId = b.org_id ?? b.orgId ?? null;
          const connection = b.connection ?? "";
          return {
            id: b.id,
            connection,
            pulseAgeSeconds: b.pulse_age_seconds ?? b.pulseAgeSeconds ?? null,
            fading: connection.toLowerCase() === "offline",
            name: b.display_name ?? b.displayName ?? b.slug,
            kind: b.kind,
            region,
            activity: b.activity || "idle",
            verb,
            source: "grove" as const,
            detail: (pulsed && b.detail) || VERB_LABEL[verb],
            stalled: Boolean(b.stalled),
            errorText: b.error_text ?? b.errorText ?? null,
            url: b.url ?? null,
            badges: b.badges ?? [],
            orgId,
            orgColour: b.org_colour ?? b.orgColour ?? null,
            orgName: (orgId ? orgById.get(orgId)?.name : null) ?? null,
            flagged: flaggedIds.has(b.id),
            pulsedAt,
            stance: b.stance ?? null,
            toolCalls: (b.tool_calls ?? b.toolCalls ?? [])
              .map((raw) => spanFromWire(raw))
              .filter((v): v is ToolCallView => v !== null),
          };
        });
        const issues = data.paperclip?.issues ?? [];
        const pcAgents = data.paperclip?.agents ?? [];
        const paperclip = pcAgents.map((a) => {
          const mine = issues.find((i) => (i.assignee_agent_id ?? i.assigneeAgentId) === a.id);
          const hb = a.last_heartbeat_at ?? a.lastHeartbeatAt;
          const verb = paperclipVerb({
            status: a.status,
            lastHeartbeatAt: hb,
            issueStatus: mine?.status,
            executionState: mine?.execution_state ?? mine?.executionState,
          });
          const region = regionForVerb(verb, a.role) as MapRegion;
          return {
            id: `pc:${a.id}`,
            name: a.name,
            kind: "paperclip" as const,
            region,
            activity: verb,
            verb,
            source: "paperclip" as const,
            // The issue title is what the agent is actually doing; the verb is
            // only how it is doing it, so lead with the title when there is one.
            detail: mine ? mine.title || `${VERB_LABEL[verb]} · ${mine.identifier}` : VERB_LABEL[verb],
          };
        });
        const actors: Actor[] = [...grove, ...paperclip];
        costCarryRef.current.sync(data.bodies ?? []);
        stallSecondsRef.current =
          data.stall_after_seconds ?? data.stallAfterSeconds ?? DEFAULT_STALL_SECONDS;
        /* --- the fade, and the leaving ------------------------------ *
         * Two clocks kept here rather than in the draw loop, because both are
         * about what CHANGED between two polls and a frame cannot see that.
         * ------------------------------------------------------------ */
        {
          const now = Date.now();
          const since = offlineSinceRef.current;
          const live = new Set<string>();
          for (const a of actors) {
            live.add(a.id);
            // First poll at which this body read offline. A body that comes
            // back forgets its fade entirely rather than resuming it.
            if (a.fading) {
              if (!since.has(a.id)) since.set(a.id, now);
            } else since.delete(a.id);
          }
          for (const id of [...since.keys()]) if (!live.has(id)) since.delete(id);
          // Bodies in the last poll and not in this one have left the map.
          // Their departure starts from wherever they were last DRAWN, which is
          // the interpolated walk position, not the seat they were assigned.
          for (const prev of actorsRef.current) {
            if (live.has(prev.id)) continue;
            const at = lastPosRef.current.get(prev.id);
            if (!at) continue;
            departedRef.current.set(prev.id, { ...at, at: now });
          }
          // A body that came back cancels its own departure mid-fade.
          for (const id of live) departedRef.current.delete(id);
        }
        // The attention list, in the order the bell walks it. Sorted by id
        // within each rank so the same world always cycles the same way.
        attentionRef.current = actors
          .filter((a) => attentionRank(a) >= 0)
          .sort((p, q) => attentionRank(p) - attentionRank(q) || (p.id < q.id ? -1 : 1));
        const attn = { idle: 0, stalled: 0, hazard: 0, fading: 0 };
        for (const a of attentionRef.current) {
          const r = attentionRank(a);
          if (r === 0) attn.hazard += 1;
          else if (r === 1) attn.stalled += 1;
          else if (r === 2) attn.fading += 1;
          else attn.idle += 1;
        }
        if (attnIdxRef.current >= attentionRef.current.length) attnIdxRef.current = 0;
        const plots: Plot[] = (data.spaces ?? []).map((sp) => {
          const idx = sp.plot_index ?? sp.plotIndex ?? 0;
          return {
            id: sp.id,
            rect: plotForIndex(idx),
            plotIndex: idx,
            preset: sp.policy_preset ?? sp.policyPreset ?? "public_write",
            name: sp.name,
            slug: sp.slug,
            ownerHandle: sp.owner_handle ?? sp.ownerHandle ?? null,
            occupancy: sp.occupancy ?? 0,
            // Redacted rows arrive with no orgs at all, so there is nothing to
            // leak here — the server already decided what this viewer may see.
            orgs: (sp.orgs ?? []).map((o) => ({ id: o.id, name: o.name, colour: o.colour })),
          };
        });
        plotRef.current = plots;
        plotsRef.current = plots.length;
        // The "my space" bookmark only exists when there is one to go to.
        // owner_handle is redacted to null on a private plot the viewer cannot
        // see, which is exactly right: a plot you cannot be told about is not
        // one this bookmark should quietly confirm the existence of.
        const handle = myHandleRef.current;
        setHasMySpace(Boolean(handle) && plots.some((p) => p.ownerHandle === handle));
        // A quiet Plaza used to render mute: the live SSE feed only carries what
        // happens while you watch. Seed the last few lines a spectator is allowed
        // to hear so arriving at a still world still shows it talking.
        const recent = data.recent_speech ?? data.recentSpeech ?? [];
        for (const line of recent) {
          const sid = line.sender_id ?? line.senderId;
          const target = actors.find((a) => a.id === sid);
          if (target && !target.bubble) target.bubble = line.body.slice(0, 48);
        }
        recentRef.current = recent.slice(-3).map((line) => ({
          who: line.sender_name ?? line.senderName ?? "someone",
          body: line.body.slice(0, 80),
        }));
        lastHeardRef.current = recent.length
          ? `${recent[recent.length - 1]!.sender_name ?? recent[recent.length - 1]!.senderName ?? "someone"}: ${recent[recent.length - 1]!.body.slice(0, 60)}`
          : null;
        actorsRef.current = actors;
        seatsRef.current = assignSeats(actors);
        motionRef.current?.sync(actors, seatsRef.current, Date.now());
        const claimed = data.claimed_agents ?? data.claimedAgents ?? 0;
        const awake = actors.filter((a) => isActiveVerb(a.verb)).length;
        const asleep = actors.length - awake;
        const next = Math.max(readMaxFog(), exploreRadius(claimed, awake));
        writeMaxFog(next);
        radiusRef.current = next;
        const bounds = worldBounds(plotsRef.current);
        setHud({
          lastHeard: lastHeardRef.current ?? "",
          world: `${bounds.x1 - bounds.x0 + 1}x${bounds.y1 - bounds.y0 + 1}`,
          spaces: plots.length,
          grove: grove.length,
          paperclip: paperclip.length,
          claimed,
          paperclipOk: Boolean(data.paperclip?.ok),
          radius: next,
          awake,
          asleep,
          orgs: orgList,
          orgMode,
          attn,
        });
        setStatus(data.paperclip?.ok ? "live campus + paperclip" : "live campus · paperclip quiet");
      } catch {
        if (!cancelled) setStatus("map stream paused");
      }
    };
    void pull();
    const t = window.setInterval(() => void pull(), 8000);
    const es = new EventSource(gp("/api/v1/sse/plaza"));
    es.addEventListener("pulse", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as {
        actor_id?: string;
        verb?: string;
        detail?: string | null;
        presence?: { pulsed_at?: string | null; pulsedAt?: string | null };
        batch?: { last_pulsed_at?: string | null };
      };
      if (!d.actor_id || !d.verb || !(d.verb in VERB_LABEL)) return;
      const verb = d.verb as AgentVerb;
      // A pulse just arrived, so for this body "gone quiet" is no longer true
      // until the next poll says otherwise.
      // A batch pulse (AGT-10) arrives as ONE event carrying the final state,
      // stamped with when that phase really happened, which may already be
      // old. Date the errand from that stamp and judge the stall from it too,
      // rather than pretending it happened the moment the event landed.
      const at = d.presence?.pulsed_at ?? d.presence?.pulsedAt ?? d.batch?.last_pulsed_at ?? new Date().toISOString();
      const ageS = (Date.now() - Date.parse(at)) / 1000;
      const stalled = isActiveVerb(verb) && Number.isFinite(ageS) && ageS > stallSecondsRef.current;
      actorsRef.current = actorsRef.current.map((a) =>
        a.id === d.actor_id ? { ...a, verb, detail: d.detail || VERB_LABEL[verb], stalled, pulsedAt: at } : a,
      );
      motionRef.current?.sync(actorsRef.current, seatsRef.current, Date.now());
    });
    // Tool-call spans, live (Plaza only, like every other SSE event). The next
    // poll replaces the list wholesale, so a missed event heals in 8 seconds.
    es.addEventListener("tool_call", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data) as { actor_id?: string; tool_call?: Record<string, unknown> };
      const span = d.tool_call ? spanFromWire(d.tool_call) : null;
      if (!d.actor_id || !span) return;
      actorsRef.current = actorsRef.current.map((a) =>
        a.id === d.actor_id ? { ...a, toolCalls: mergeSpan(a.toolCalls, span) } : a,
      );
      motionRef.current?.sync(actorsRef.current, seatsRef.current, Date.now());
    });
    es.addEventListener("speech", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { sender_id?: string; body?: string };
      if (!data.sender_id || !data.body) return;
      actorsRef.current = actorsRef.current.map((a) =>
        a.id === data.sender_id ? { ...a, bubble: data.body!.slice(0, 48), verb: "say" } : a,
      );
      window.setTimeout(() => {
        actorsRef.current = actorsRef.current.map((a) => (a.id === data.sender_id ? { ...a, bubble: undefined } : a));
      }, 8000);
    });
    return () => {
      cancelled = true;
      window.clearInterval(t);
      es.close();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let cancelled = false;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    /**
     * Is this body on this tile? Asked of where it was last DRAWN, not of its
     * home seat: a body at the Workshop is clicked at the Workshop.
     */
    const standsOn = (a: Actor, tx: number, ty: number): boolean => {
      const drawn = lastPosRef.current.get(a.id);
      const at = drawn ?? seatsRef.current.get(a.id) ?? seatInRegion(a.id, a.region);
      return Math.round(at.x) === tx && Math.round(at.y) === ty;
    };

    /* ---- the one transform ---------------------------------------- */

    /** Layout-space offset that centres the civic core at zoom 1. */
    const origin = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const last = iso(MAP_COLS - 1, MAP_ROWS - 1);
      const first = iso(0, MAP_ROWS - 1);
      const mapW = iso(MAP_COLS - 1, 0).x - first.x + TW;
      const mapH = last.y + TH;
      return { ox: (w - mapW) / 2 - first.x, oy: Math.max(24, (h - mapH) / 2), w, h };
    };

    /** Bounding box of the whole world in layout space. */
    const worldBox = () => {
      const b = worldBounds(plotsRef.current);
      const { ox, oy } = origin();
      return {
        minX: ox + iso(b.x0, b.y1).x - TW / 2,
        maxX: ox + iso(b.x1, b.y0).x + TW / 2,
        minY: oy + iso(b.x0, b.y0).y,
        maxY: oy + iso(b.x1, b.y1).y + TH,
      };
    };

    /** Zoomed all the way out, the entire world fits on screen. */
    const minZoom = () => {
      const { w, h } = origin();
      const box = worldBox();
      const fit = Math.min(w / Math.max(1, box.maxX - box.minX), h / Math.max(1, box.maxY - box.minY));
      return clamp(Math.min(NOMINAL_MIN_ZOOM, fit), 0.12, MAX_ZOOM);
    };

    /** The world may be dragged to the edge of the viewport, never past it. */
    const clampPan = () => {
      const v = viewRef.current;
      const { w, h } = origin();
      const box = worldBox();
      const wx = (box.maxX - box.minX) * v.zoom;
      const wy = (box.maxY - box.minY) * v.zoom;
      if (wx <= w) v.px = (w - wx) / 2 - box.minX * v.zoom;
      else v.px = clamp(v.px, w - PAN_MARGIN - box.maxX * v.zoom, PAN_MARGIN - box.minX * v.zoom);
      if (wy <= h) v.py = (h - wy) / 2 - box.minY * v.zoom;
      else v.py = clamp(v.py, h - PAN_MARGIN - box.maxY * v.zoom, PAN_MARGIN - box.minY * v.zoom);
    };

    /** Zoom about a point in CSS canvas coords, so what is under it stays put. */
    const zoomAt = (cx: number, cy: number, factor: number) => {
      const v = viewRef.current;
      const z0 = v.zoom;
      const z1 = clamp(z0 * factor, minZoom(), MAX_ZOOM);
      if (z1 === z0) return;
      v.px = cx - ((cx - v.px) / z0) * z1;
      v.py = cy - ((cy - v.py) / z0) * z1;
      v.zoom = z1;
      clampPan();
    };

    /**
     * Hand the camera to whoever just grabbed it.
     *
     * Three things want to drive the view — the follow-cam, a bookmark glide
     * and the kiosk tour — and the way two cameras fight is that neither of
     * them lets go. One place where a new driver cancels the last one, called
     * by every entry point, is the whole answer.
     */
    const takeCamera = () => {
      followRef.current = null;
      setFollowing(null);
      setAttnPos(null);
      glideRef.current = null;
    };

    const reset = () => {
      // Reset means reset. Before the bell existed you had to double-click a
      // body to start following one, so a follow-cam quietly surviving "back to
      // the core" was rare enough to go unnoticed; now one click starts one,
      // and a reset that snapped straight back to the body looked broken.
      takeCamera();
      const v = viewRef.current;
      v.zoom = clamp(1, minZoom(), MAX_ZOOM);
      v.px = 0;
      v.py = 0;
      clampPan();
    };

    /** Screen → tile. The exact inverse of how a tile is drawn. */
    const tileFromClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { ox, oy } = origin();
      const v = viewRef.current;
      const wx = (clientX - rect.left - v.px) / v.zoom - ox;
      const wy = (clientY - rect.top - v.py) / v.zoom - oy;
      const { tx, ty } = unIso(wx, wy);
      return { tx: Math.round(tx), ty: Math.round(ty) };
    };

    controlsRef.current = {
      zoomBy: (f) => {
        const { w, h } = origin();
        zoomAt(w / 2, h / 2, f);
      },
      reset,
      /**
       * Point the camera at a tile. Deliberately does NOT set the view here:
       * it records a target, and the draw loop eases toward it with the same
       * clampPan the follow-cam uses. A cut across the campus is disorienting
       * and, worse, tells you nothing about where you went — a glide shows you
       * the way, which is the whole point of a world you watch rather than read.
       */
      goTo: (tx, ty, zoom) => {
        takeCamera();
        // Whoever pressed a bookmark is a person; the kiosk tour stands down
        // and gives them the display for a while.
        kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
        glideRef.current = { tx, ty, zoom, start: performance.now() };
      },
    };

    /**
     * How healthy this body's connection is, right now.
     *
     * Called once per body per frame for the meter, and once more for whatever
     * is being hovered or peeked. Cheap by construction: it returns numbers and
     * builds no strings — healthNote() does the wording, and only when read.
     */
    const healthOf = (a: Actor): Health =>
      // Paperclip bodies are mirrored from next door. Grove holds no heartbeat
      // for them and never evicts them, so there is no seat here to run out.
      a.source === "paperclip"
        ? ELSEWHERE
        : bodyHealth({
            connection: a.connection,
            pulseAgeSeconds: a.pulseAgeSeconds ?? null,
            stallAfterSeconds: stallSecondsRef.current,
            offlineSince: offlineSinceRef.current.get(a.id) ?? null,
            now: Date.now(),
          });

    /* ---- input ------------------------------------------------------ */

    const pointers = new Map<number, { x: number; y: number }>();
    let dragging = false;
    let dragMoved = 0;
    let last = { x: 0, y: 0 };
    let pinchDist = 0;

    const localPoint = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };

    const onPointerDown = (ev: PointerEvent) => {
      canvas.setPointerCapture?.(ev.pointerId);
      // Somebody is here. A wall display that keeps touring while a person is
      // dragging it is a display that is fighting them.
      kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
      glideRef.current = null;
      pointers.set(ev.pointerId, localPoint(ev));
      if (pointers.size === 1) {
        dragging = true;
        dragMoved = 0;
        last = { x: ev.clientX, y: ev.clientY };
        canvas.style.cursor = "grabbing";
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
        dragging = false;
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, localPoint(ev));
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        if (!a || !b) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
        pinchDist = d;
        return;
      }
      if (dragging) {
        const dx = ev.clientX - last.x;
        const dy = ev.clientY - last.y;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        if (followRef.current) {
          followRef.current = null;
          setFollowing(null);
        }
        viewRef.current.px += dx;
        viewRef.current.py += dy;
        last = { x: ev.clientX, y: ev.clientY };
        clampPan();
        return;
      }
      const { tx, ty } = tileFromClient(ev.clientX, ev.clientY);
      const actors = actorsRef.current;
      hoverRef.current = actors.find((a) => standsOn(a, tx, ty)) ?? null;
      canvas.style.cursor = regionAt(tx, ty) !== "wild" ? "pointer" : "grab";
    };

    const releasePointer = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) {
        dragging = false;
        canvas.style.cursor = "grab";
      }
    };

    /**
     * What a click landed on, read straight off what is already drawn: a body,
     * a claimed plot, or a public room. Every field here came out of the public
     * minimap, which the server redacts before it leaves — a private plot
     * arrives with a null name and no orgs, and this renders that as it is.
     */
    const peekAt = (tx: number, ty: number): Peek | null => {
      if (!tileExplored(tx, ty, radiusRef.current)) return null;
      const body = actorsRef.current.find((a) => standsOn(a, tx, ty));
      if (body) {
        const facts: string[] = [];
        if (body.flagged) facts.push("Flagged for prompt injection — the chronicle holds the record.");
        if (body.stalled) facts.push("Stopped reporting — it says it is working, but has gone quiet.");
        if (body.errorText) facts.push(`Fault: ${body.errorText.slice(0, 120)}`);
        // How its connection is doing, said as a sentence rather than as a ring
        // the reader has to have learnt. Always shown for a Grove body: "it is
        // beating" is the answer an owner came here for as often as the alarm.
        if (body.source === "grove") facts.push(healthNote(healthOf(body)));
        for (const line of toolLines(body)) facts.push(line);
        const stance = body.stance ? STANCES[body.stance as keyof typeof STANCES] : undefined;
        if (stance) facts.push(`Stance: ${stance.label}. ${stance.blurb} ${stance.enforcementNote}`);
        const consequence = badgeConsequence(body.badges);
        if (consequence) facts.push(consequence);
        if (body.source === "paperclip") facts.push("Runs on Paperclip next door, so it has no Grove body to answer you.");
        return {
          kind: "body",
          title: body.name,
          subtitle: `${body.kind === "human" ? chosenRef.current.lexicon.aHuman : chosenRef.current.lexicon.anAgent} · ${body.detail ?? VERB_LABEL[body.verb]}`,
          region: regionTitle(chosenRef.current, body.region),
          facts,
          org:
            body.orgColour && body.orgName
              ? { id: body.orgId ?? body.orgName, name: body.orgName, colour: body.orgColour }
              : null,
          url: body.url ?? null,
          // Paperclip bodies are mirrored onto the map but live next door, so
          // no amount of signing in lets you address one.
          speakable: body.source === "grove",
        };
      }
      const plot = plotRef.current.find(
        (q) => tx >= q.rect.x0 && tx <= q.rect.x1 && ty >= q.rect.y0 && ty <= q.rect.y1,
      );
      if (plot) {
        return {
          kind: "space",
          name: plot.name,
          slug: plot.slug,
          plotIndex: plot.plotIndex,
          access: accessLabel(chosenRef.current, plot.preset),
          accessBlurb: accessBlurb(chosenRef.current, plot.preset),
          ownerHandle: plot.ownerHandle,
          occupancy: plot.occupancy,
          orgs: plot.orgs,
        };
      }
      const region = regionAt(tx, ty);
      if (region === "wild") return null;
      return {
        kind: "region",
        region,
        title: regionTitle(chosenRef.current, region),
        here: actorsRef.current
          .filter((a) => a.region === region)
          .map((a) => ({ name: a.name, detail: a.detail ?? VERB_LABEL[a.verb] })),
        recent: recentRef.current,
      };
    };

    const onPointerUp = (ev: PointerEvent) => {
      const wasDragging = dragging;
      const moved = dragMoved;
      releasePointer(ev);
      // A pan that happened to end over a region must not navigate into it.
      if (!wasDragging || moved > 6) return;
      const { tx, ty } = tileFromClient(ev.clientX, ev.clientY);
      const target = peekAt(tx, ty);
      // Someone with a body clicked a room to walk into it, and still does.
      // A spectator gets the read-only view instead of a bounce to a login
      // form — which is the one thing the first click must never be.
      if (target?.kind === "region" && signedInRef.current !== false) {
        router.push(`/w/${target.region}`);
        return;
      }
      setPeek(target);
    };

    /** Follow the body under the cursor. Double-click, because a single click
     *  already opens the read-only card and a spectator needs that more. */
    const onDoubleClick = (ev: MouseEvent) => {
      const { tx, ty } = tileFromClient(ev.clientX, ev.clientY);
      const body = actorsRef.current.find((a) => standsOn(a, tx, ty));
      if (!body) return;
      ev.preventDefault();
      followRef.current = body.id;
      setFollowing(body.name);
    };

    const onPointerAbort = (ev: PointerEvent) => {
      releasePointer(ev);
      hoverRef.current = null;
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
      glideRef.current = null;
      const rect = canvas.getBoundingClientRect();
      // Trackpad pinch arrives as a ctrl-wheel; give it a snappier ratio.
      const k = ev.ctrlKey ? 0.01 : 0.0016;
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * k));
    };

    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Escape is the way out of whatever the map has put you in, innermost
      // first: release a follow before you leave kiosk mode, so one key does
      // not throw away two states at once.
      if (ev.key === "Escape") {
        if (followRef.current) {
          followRef.current = null;
          setFollowing(null);
          return;
        }
        if (kioskRef.current) {
          kioskModeRef.current(false);
          ev.preventDefault();
        }
        return;
      }
      // Age of Empires bound the idle-villager bell to a single key and so
      // does this: "." is the next body that wants attention.
      if (ev.key === ".") cycleRef.current();
      else if (ev.key === "+" || ev.key === "=") controlsRef.current?.zoomBy(1.25);
      else if (ev.key === "-" || ev.key === "_") controlsRef.current?.zoomBy(1 / 1.25);
      else if (ev.key === "0") reset();
      else if (ev.key === "k" || ev.key === "K") kioskModeRef.current(!kioskRef.current);
      // T walks the themes. Works in kiosk mode too, where there is no switcher.
      else if ((ev.key === "t" || ev.key === "T") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) themeKeyRef.current();
      // The bookmarks. A modified key is somebody else's shortcut — cmd-1 is a
      // browser tab, not the Plaza — so only the bare keystroke jumps.
      else if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && BOOKMARK_KEYS.has(ev.key.toLowerCase()))
        jumpRef.current(ev.key.toLowerCase());
      else return;
      ev.preventDefault();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("pointercancel", onPointerAbort);
    canvas.addEventListener("pointerleave", onPointerAbort);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    canvas.style.cursor = "grab";

    const start = async () => {
      /* ---- the art, from the active theme -----------------------------
       * Everything the map draws is asked of the theme (lib/themes). The
       * theme's prepare() awaits what it cannot draw an honest frame without —
       * for aoe, the ground, characters and the three access buildings — and
       * fetches or bakes the rest behind the first frame. Every draw call below
       * treats "not ready" as "not yet", never as an error.
       * ---------------------------------------------------------------- */
      await themeRef.current.art.prepare();
      if (cancelled || !canvasRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      /* ---- one lamp, drawn once -------------------------------------
       * A radial gradient is an allocation, and the campus has forty-odd lamps
       * in view at once. Building one per lamp per frame is 2,400 gradients a
       * second for a picture that never changes, so the blob is rendered ONCE
       * per theme into an offscreen canvas and stamped from then on — the same
       * discipline the dressing follows, moved from placement to paint.
       * ---------------------------------------------------------------- */
      const GLOW_R = 64;
      const glowSprites = new Map<string, HTMLCanvasElement>();
      const glowFor = (theme: Theme): HTMLCanvasElement => {
        let sprite = glowSprites.get(theme.id);
        if (sprite) return sprite;
        sprite = document.createElement("canvas");
        sprite.width = GLOW_R * 2;
        sprite.height = GLOW_R * 2;
        const g = sprite.getContext("2d");
        if (g) {
          const [inner, mid, outer] = theme.palette.glow;
          const grad = g.createRadialGradient(GLOW_R, GLOW_R, 0, GLOW_R, GLOW_R, GLOW_R);
          grad.addColorStop(0, inner);
          grad.addColorStop(0.32, mid);
          grad.addColorStop(1, outer);
          g.fillStyle = grad;
          g.fillRect(0, 0, GLOW_R * 2, GLOW_R * 2);
        }
        glowSprites.set(theme.id, sprite);
        return sprite;
      };

      /** Where a body is this frame, in (fractional) tile coords, and what it is doing about its errand. */
      const bodyAt = (id: string, seat: Seat) =>
        motionRef.current!.frame(id, seat, Date.now(), reduceMotion.matches);

      type Label = {
        x: number;
        y: number;
        name: string;
        detail: string;
        nameFill: string;
        detailFill: string;
        alpha: number;
        orgColour: string | null;
      };

      const draw = (t: number) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssW = el.clientWidth;
        const cssH = el.clientHeight;
        if (el.width !== Math.floor(cssW * dpr) || el.height !== Math.floor(cssH * dpr)) {
          el.width = Math.floor(cssW * dpr);
          el.height = Math.floor(cssH * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, cssW, cssH);
        // The theme is read ONCE a frame: a switch lands on a frame boundary,
        // never halfway down the depth list.
        const theme = themeRef.current;
        const art = theme.art;
        const pal = theme.palette;
        art.backdrop(ctx, cssW, cssH, t);

        // Re-clamp every frame: the viewport (and the world) can change size
        // underneath a view that was legal when it was set.
        const v = viewRef.current;
        v.zoom = clamp(v.zoom, minZoom(), MAX_ZOOM);
        clampPan();
        const z = v.zoom;
        // Everything below is drawn in layout space; the canvas transform is the
        // single place pan/zoom is applied, so drawing and hit-testing agree.
        ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * v.px, dpr * v.py);

        const { ox, oy } = origin();
        const radius = radiusRef.current;

        // Only tiles inside the viewport are candidates: this is what keeps the
        // per-frame cost flat as the world grows and as people zoom out.
        const corners = [
          unIso((0 - v.px) / z - ox, (0 - v.py) / z - oy),
          unIso((cssW - v.px) / z - ox, (0 - v.py) / z - oy),
          unIso((0 - v.px) / z - ox, (cssH - v.py) / z - oy),
          unIso((cssW - v.px) / z - ox, (cssH - v.py) / z - oy),
        ];
        const bounds = worldBounds(plotsRef.current);
        const vx0 = Math.max(bounds.x0, Math.floor(Math.min(...corners.map((c) => c.tx))) - 2);
        const vx1 = Math.min(bounds.x1, Math.ceil(Math.max(...corners.map((c) => c.tx))) + 2);
        const vy0 = Math.max(bounds.y0, Math.floor(Math.min(...corners.map((c) => c.ty))) - 2);
        const vy1 = Math.min(bounds.y1, Math.ceil(Math.max(...corners.map((c) => c.ty))) + 2);
        // The horizon widens with the visible area rather than being switched
        // off when zoomed out, so distant land appears instead of a hard edge.
        const horizon = HORIZON + Math.ceil(Math.max(cssW / z / TW, cssH / z / TH));

        for (let ty = vy0; ty <= vy1; ty++) {
          for (let tx = vx0; tx <= vx1; tx++) {
            // Beyond the horizon there is nothing to see yet; skipping keeps the
            // frame cost flat however large the world gets.
            if (Math.hypot(tx - PLAZA_CENTER.x, ty - PLAZA_CENTER.y) > radius + horizon) continue;
            const core = isCoreTile(tx, ty);
            const region = regionAt(tx, ty);
            const p = iso(tx, ty);
            const x = ox + p.x;
            const y = oy + p.y;
            const explored = tileExplored(tx, ty, radius);
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + TW / 2, y + TH / 2);
            ctx.lineTo(x, y + TH);
            ctx.lineTo(x - TW / 2, y + TH / 2);
            ctx.closePath();
            ctx.clip();
            ctx.globalAlpha = explored ? (core ? 1 : 0.55) : 0.18;
            art.ground(ctx, core ? region : "wild", x, y, tx, ty);
            // Paving, then seasoning, both still inside the tile's clip so a
            // path arm can never bleed into the diamond next door. Both are a
            // single typed-array read per tile — the whole network and every
            // pebble was decided once, at module load, from the tile grid.
            if (core && explored) {
              const mask = pathMaskAt(tx, ty);
              if (mask >= 0) art.path(ctx, mask, x, y);
              if (z >= LOD_SCATTER) {
                const s = scatterAt(tx, ty);
                if (s >= 0) art.scatter(ctx, SCATTER_KEYS[s]!, x, y);
              }
            }
            if (!explored) {
              ctx.fillStyle = pal.fog;
              ctx.fill();
            }
            ctx.restore();
            // Unclaimed land is parcelled: show the plot edges so it reads as
            // somewhere you could claim, not as undifferentiated wilderness.
            if (explored && !core) {
              const edgeX = ((tx % PLOT_COLS) + PLOT_COLS) % PLOT_COLS === 0;
              const edgeY = ((ty % PLOT_ROWS) + PLOT_ROWS) % PLOT_ROWS === 0;
              if (edgeX || edgeY) {
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + TW / 2, y + TH / 2);
                ctx.lineTo(x, y + TH);
                ctx.lineTo(x - TW / 2, y + TH / 2);
                ctx.closePath();
                ctx.strokeStyle = pal.plotEdge;
                ctx.stroke();
              }
            }
            if (explored && core && (tx + ty) % 7 === 0) {
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(x + TW / 2, y + TH / 2);
              ctx.lineTo(x, y + TH);
              ctx.lineTo(x - TW / 2, y + TH / 2);
              ctx.closePath();
              ctx.strokeStyle = pal.coreGrid;
              ctx.stroke();
            }
          }
        }

        /* ---- the structure layer -------------------------------------
         * Everything with a footprint, and everything standing on one, goes
         * into ONE list and is painted back-to-front by the (tx + ty) of its
         * south-most tile — the rule the art README states and the only rule
         * that makes a body and a building agree about which is in front.
         *
         * Before this pass the plot buildings were drawn in one block and the
         * bodies in another, so a body always won. That was invisible while
         * the only structures were 3x3 sheds on empty plots and is very
         * visible now there is a Library for someone to stand behind.
         *
         * The list is rebuilt from the ALREADY-CULLED viewport every frame, so
         * its length is bounded by what is on screen rather than by how big
         * the world has grown: a few dozen entries, sorted once.
         * ------------------------------------------------------------- */
        type Scene = { s: number; draw: () => void };
        const scene: Scene[] = [];
        /** Generous margin: a 328px Library pokes into view from ~7 tiles off. */
        const near = (tx: number, ty: number, fw: number, fh: number) =>
          tx + fw - 1 >= vx0 - 8 && tx <= vx1 + 8 && ty + fh - 1 >= vy0 - 8 && ty <= vy1 + 8;
        /** Queue a footprint-anchored draw from the theme. The footprint sets the depth; the theme draws. */
        const anchored = (
          paint: (px: number, py: number) => void,
          tx: number,
          ty: number,
          a: { fw: number; fh: number },
          alpha = 1,
        ) => {
          const q = iso(tx, ty);
          const px = ox + q.x;
          const py = oy + q.y;
          scene.push({
            s: tx + a.fw - 1 + (ty + a.fh - 1),
            draw: () => {
              if (alpha === 1) {
                paint(px, py);
                return;
              }
              ctx.save();
              ctx.globalAlpha = alpha;
              paint(px, py);
              ctx.restore();
            },
          });
        };

        // Claimed land, drawn over the terrain and under the bodies.
        for (const plot of plotRef.current) {
          const { rect } = plot;
          if (rect.x1 < vx0 || rect.x0 > vx1 || rect.y1 < vy0 || rect.y0 > vy1) continue;
          const access: AccessLevel =
            plot.preset === "private" || plot.preset === "public_view" ? plot.preset : "public_write";
          const tint = pal.plotTint[plot.preset as AccessLevel] ?? pal.plotTint.public_write;
          let anyExplored = false;
          for (let ty = rect.y0; ty <= rect.y1; ty++) {
            for (let tx = rect.x0; tx <= rect.x1; tx++) {
              if (!tileExplored(tx, ty, radius)) continue;
              anyExplored = true;
              const q = iso(tx, ty);
              const px = ox + q.x;
              const py = oy + q.y;
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(px + TW / 2, py + TH / 2);
              ctx.lineTo(px, py + TH);
              ctx.lineTo(px - TW / 2, py + TH / 2);
              ctx.closePath();
              ctx.fillStyle = tint;
              ctx.fill();
            }
          }
          // The building IS the permission. A closed compound, a see-through
          // colonnade or an open canopy says the access level from across the
          // map, without a badge to hover or a legend to learn. The tint stays
          // underneath as the machine-readable half.
          if (anyExplored && z >= LOD_PLOTS) {
            anchored((px, py) => art.building(ctx, access, px, py), rect.x0 + 2, rect.y0 + 1, BUILDING, 0.96);
          }

          // Bound orgs colour the FENCE, not the ground: the fill already says
          // who may speak here, so an org takes the edge instead of fighting it.
          const orgColour = plot.orgs[0]?.colour;
          if (anyExplored && orgColour) {
            ctx.save();
            ctx.strokeStyle = orgColour;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.85;
            const edge = (ax: number, ay: number, bx: number, by: number) => {
              ctx.beginPath();
              ctx.moveTo(ax, ay);
              ctx.lineTo(bx, by);
              ctx.stroke();
            };
            for (let ty = rect.y0; ty <= rect.y1; ty++) {
              for (let tx = rect.x0; tx <= rect.x1; tx++) {
                if (!tileExplored(tx, ty, radius)) continue;
                // Only the outward faces, so the plot reads as one enclosure
                // rather than a grid of outlined diamonds.
                if (tx > rect.x0 && tx < rect.x1 && ty > rect.y0 && ty < rect.y1) continue;
                const q = iso(tx, ty);
                const px = ox + q.x;
                const py = oy + q.y;
                if (ty === rect.y0) edge(px, py, px + TW / 2, py + TH / 2);
                if (tx === rect.x1) edge(px + TW / 2, py + TH / 2, px, py + TH);
                if (ty === rect.y1) edge(px, py + TH, px - TW / 2, py + TH / 2);
                if (tx === rect.x0) edge(px - TW / 2, py + TH / 2, px, py);
              }
            }
            ctx.restore();
          }
          if (!anyExplored || z < LOD_PLOTS) continue;
          const mid = iso((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2);
          const lx = ox + mid.x;
          const ly = oy + mid.y;
          ctx.textAlign = "center";
          ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = pal.plotName;
          ctx.fillText(plot.name ?? theme.lexicon.claimedPlot, lx, ly - 2);
          ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = tint.replace(/[\d.]+\)$/, "0.95)");
          ctx.fillText(
            `${accessLabel(theme, plot.preset)}${plot.occupancy ? ` · ${plot.occupancy} here` : ""}`,
            lx,
            ly + 10,
          );
          if (plot.orgs.length && z >= LOD_LABELS) {
            ctx.fillStyle = plot.orgs[0]!.colour;
            ctx.fillText(plot.orgs.map((o) => o.name).join(" · "), lx, ly + 21);
          }
        }

        const actors = actorsRef.current;
        // Bodies that have left the world stop walking. The last-seen positions
        // are pruned on the same pass, but only once the departure that needs
        // them has finished playing — that is the one entry a leaver still has
        // a use for after it is gone.
        if (lastPosRef.current.size > actors.length) {
          const live = new Set(actors.map((a) => a.id));
          for (const id of [...lastPosRef.current.keys()]) {
            if (!live.has(id) && !departedRef.current.has(id)) lastPosRef.current.delete(id);
          }
        }
        const labels: Label[] = [];
        /** Layout-space positions of everything wrong, drawn in screen space later. */
        const hazards: Array<{ x: number; y: number; tone: HazardTone }> = [];
        /** Bodies whose connection is drifting. Fixed-size marks, drawn later. */
        const meters: Array<{ x: number; y: number; drift: number }> = [];
        /** Where the lamps are this frame; lit after the hour's wash goes down. */
        const lamps: Array<{ x: number; y: number; r: number }> = [];
        /** Speech, lifted out of the depth list so the night can never dim it. */
        const bubbles: Array<{ x: number; y: number; text: string }> = [];
        // `t` is a rAF timestamp; the work clock, the fade clock and the
        // campus clock are all WALL time, because that is what the poll
        // recorded and what the hour means. Read once per frame, not per body.
        const nowMs = Date.now();
        // The hour. Read once per frame — not once per tile, and not once per
        // body — and used by everything below that cares what time it is.
        const hour = skyAt(nowMs);
        const lit = hour.lamp > LAMP_FLOOR;

        // The six civic landmarks. No level-of-detail gate: zoomed all the way
        // out these ARE the campus, and a map of six coloured rectangles with
        // nothing on them is what this pass exists to stop being.
        for (const c of CIVIC_PLACEMENTS) {
          const a = CIVIC[c.room];
          if (!near(c.tx, c.ty, a.fw, a.fh)) continue;
          if (!tileExplored(c.tx + 1, c.ty + 1, radius)) continue;
          const room = c.room;
          anchored((px, py) => art.landmark(ctx, room, px, py), c.tx, c.ty, a);
        }

        // Furniture. Fixed list, computed once from the tile grid, so the same
        // bench is on the same tile in every frame and after every poll.
        if (z >= LOD_DRESSING) {
          for (const p of PROPS) {
            if (!near(p.tx, p.ty, 1, 1)) continue;
            if (!tileExplored(p.tx, p.ty, radius)) continue;
            const key = p.key;
            anchored((px, py) => art.prop(ctx, key, px, py), p.tx, p.ty, PROP_FOOTPRINT);
          }
        }

        /* ---- what is burning -----------------------------------------
         * Two precomputed flat arrays of [tx, ty, lift, radius], read four
         * numbers at a time. The civic windows are never gated, because the
         * six landmarks are never gated; the street lamps follow the props
         * they belong to and go out with them at 0.4x, where the lantern under
         * the glow would be two pixels and the glow would be a smudge.
         * -------------------------------------------------------------- */
        if (lit) {
          const takeLamps = (table: Int16Array) => {
            for (let i = 0; i < table.length; i += LAMP_STRIDE) {
              const tx = table[i]!;
              const ty = table[i + 1]!;
              if (!near(tx, ty, 1, 1) || !tileExplored(tx, ty, radius)) continue;
              const q = iso(tx, ty);
              lamps.push({ x: ox + q.x, y: oy + q.y - table[i + 2]!, r: table[i + 3]! });
            }
          };
          takeLamps(CIVIC_LAMPS);
          if (z >= LOD_LAMPS) takeLamps(STREET_LAMPS);
        }

        // Sheep. Pure function of the clock, so they neither shimmer nor need
        // state; dropped with the nameplates because zoomed out they are blobs.
        if (z >= LOD_SCATTER) {
          for (const plan of SHEEP) {
            const f = sheepAt(plan, t);
            const htx = Math.round(f.x);
            const hty = Math.round(f.y);
            if (!near(htx, hty, 1, 1) || !tileExplored(htx, hty, radius)) continue;
            const q = iso(f.x, f.y);
            const sx = ox + q.x;
            const sy = oy + q.y - 18;
            const flip = f.flip;
            const pose = AMBIENT_POSE[f.pose];
            scene.push({
              s: f.x + f.y - 0.5,
              // The ambient critter: a sheep in aoe, whatever idles in the theme.
              draw: () => art.ambient(ctx, pose, sx, sy, flip, t),
            });
          }
        }

        for (const a of actors) {
          const seat = seatsRef.current.get(a.id) ?? seatInRegion(a.id, a.region);
          // The motion model decides where the body is; the renderer only draws it.
          const at = bodyAt(a.id, seat);
          if (!tileExplored(Math.round(at.x), Math.round(at.y), radius)) continue;
          if (!near(Math.round(at.x), Math.round(at.y), 1, 1)) continue;
          const p = iso(at.x, at.y);
          const active = isActiveVerb(a.verb);
          // Silence freezes: a stalled body neither sways nor bobs. A walking body
          // is already moving, so the work sway only plays once it has arrived.
          const still = at.state === "stalled";
          const walking = at.state === "dispatched" || at.state === "returning" || at.state === "approaching";
          const walk = active && !still && !walking ? Math.sin(t / 160 + seat.x) * 5 : 0;
          const bob = still
            ? 0
            : Math.sin(t / (active ? 160 : 400) + seat.y) * (active ? 2.5 : a.verb === "offline" ? 0 : 1.2);
          const x = ox + p.x + walk;
          const y = oy + p.y - 18 + bob;
          /* --- idle, asleep, and going --------------------------------
           * The ladder used to stop at "asleep": 1.0 awake, 0.72 idle, 0.4
           * offline, and then the body was simply not in the next poll. The
           * last rung is now a slope — a sleeping body keeps dimming as its
           * seat runs out — so "about to go" is a state you can see rather
           * than one you reconstruct from the gap afterwards.
           * ------------------------------------------------------------ */
          const health = healthOf(a);
          const alpha =
            a.verb === "offline" ? sleepingAlpha(health.drift) : a.verb === "idle" ? 0.72 : 1;
          const tone = hazardOf(a);
          if (tone) hazards.push({ x, y, tone });
          costCarryRef.current.note(a.id, x, y);
          if (healthVisible(health)) meters.push({ x, y, drift: health.drift });
          // Remember where this body stood, so that if it is gone by the next
          // poll its departure can start from the seat and not from nowhere.
          {
            const last = lastPosRef.current.get(a.id);
            const sprite = spriteKey(a.kind === "paperclip" ? "agent" : a.kind, a.verb);
            if (last) {
              last.x = at.x;
              last.y = at.y;
              last.alpha = alpha;
              last.sprite = sprite;
            } else lastPosRef.current.set(a.id, { x: at.x, y: at.y, alpha, sprite, at: 0 });
          }

          // Scaffolding. A body working a url stakes out a site three tiles north
          // of its HOME seat — the thing it is building lives where it lives, even
          // while it walks to the Workshop to run a tool. The stage is the
          // reported progress of its open span, and stays at 1 when none was
          // reported: nothing on this map grows on a clock.
          if (a.url && isActiveVerb(a.verb) && z >= LOD_DRESSING) {
            const open = a.toolCalls?.find((c) => c.finishedAt === null && c.progress != null);
            const stage = scaffoldStageFor(open?.progress);
            const sx = seat.x - 3;
            const sy = seat.y - 3;
            if (near(sx, sy, SCAFFOLD.fw, SCAFFOLD.fh))
              anchored((px, py) => art.scaffold(ctx, stage, px, py), sx, sy, SCAFFOLD, 0.92);
          }
          const workSpan = at.span;
          const mark = at.mark;
          const stance = a.kind === "agent" ? a.stance : null;

          scene.push({
            // Bodies stand on the tile's NORTH vertex while a footprint covers
            // the whole diamond, so a body on tile T is half a tile north of a
            // prop on tile T and must sort just ahead of it.
            s: at.x + at.y - 0.5,
            draw: () => {
              ctx.save();
              ctx.globalAlpha = alpha;
              ctx.beginPath();
              ctx.ellipse(x, y + 18, active ? 14 : 10, 5, 0, 0, Math.PI * 2);
              ctx.strokeStyle = a.stalled ? STALL_RING : VERB_RING[a.verb];
              ctx.lineWidth = active ? 2 : 1;
              if (a.stalled) ctx.setLineDash([3, 3]);
              ctx.stroke();
              ctx.setLineDash([]);
              // A hazard also spreads on the ground. The screen-space triangle
              // is what carries at low zoom; this is what makes a faulted body
              // look wrong rather than merely labelled when you are close.
              if (tone && z >= LOD_PLOTS) {
                const grow = 0.5 + 0.5 * Math.sin(t / 300);
                ctx.globalAlpha = alpha * (0.5 - 0.34 * grow);
                ctx.strokeStyle = HAZARD_COLOUR[tone];
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.ellipse(x, y + 18, 14 + 16 * grow, (14 + 16 * grow) * 0.42, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = alpha;
              }
              const key = spriteKey(a.kind === "paperclip" ? "agent" : a.kind, a.verb);
              if (!art.body(ctx, key, x, y)) {
                ctx.fillStyle = a.kind === "human" ? pal.placeholder.human : pal.placeholder.agent;
                ctx.fillRect(x - 6, y - 6, 12, 12);
              }
              // Org before the verb glyph and the bubble: identity sits behind
              // what the body is doing and what it just said, never over them.
              if (a.orgColour && z >= LOD_ORG) art.pennant(ctx, a.orgColour, x, y);
              // What it is doing, as a thing in its hand. The 24x24 item is
              // anchored at its grip point, placed at the sprite's right hand —
              // 11px right of centre, 3px below the waist. Where an item says
              // the verb, the abstract glyph stands down instead of saying the
              // same thing twice beside it.
              const carried = z >= LOD_DRESSING ? itemForActor(a) : null;
              if (!(carried && art.carry(ctx, carried, x + 11, y + 3))) art.glyph(ctx, a.verb, x, y, t);
              // Motion marks (lib/motion/marks.ts): fixed semantics, not theme art.
              if (workSpan && z >= LOD_DRESSING) drawWorkBar(ctx, workSpan, x, y, t, reduceMotion.matches);
              if (mark) drawOutcomeMark(ctx, mark.outcome, x, y, (Date.now() - mark.at) / OUTCOME_MARK_MS, reduceMotion.matches);
              if (stance && z >= LOD_LABELS) drawStanceMark(ctx, stance, x, y);
              ctx.restore();
            },
          });
          // Speech leaves the depth list. It used to be painted inside the
          // body's own entry, which meant a nearer body could draw over a line
          // someone had just said — and, since this pass, that the hour's wash
          // would have gone down on top of it. It is information, so it is
          // painted after the light, with the nameplates.
          if (a.bubble) bubbles.push({ x, y, text: a.bubble });

          if (z >= LOD_LABELS) {
            labels.push({
              x,
              y,
              name: a.name,
              // The caption is what this body is doing: the task detail when
              // there is one, the verb only as a fallback.
              detail: a.detail ?? VERB_LABEL[a.verb],
              nameFill: a.source === "paperclip" ? pal.paperclipNameFill : pal.nameFill,
              detailFill: VERB_RING[a.verb],
              alpha,
              orgColour: a.orgColour ?? null,
            });
          }
        }

        /* ---- and gone -------------------------------------------------
         * The last rung of the ladder. A departure goes through the SAME
         * depth-sorted list as everything else — a body leaving from behind
         * the Library has to leave from behind the Library — and it is pushed
         * after the live bodies so that on a shared tile the living one is
         * still in front.
         * -------------------------------------------------------------- */
        for (const [id, gone] of departedRef.current) {
          const age = nowMs - gone.at;
          // Not `age >= DEPART_MS`: the test is that the age is IN the window.
          // A wall clock can step backwards — an NTP correction, a laptop
          // waking up in another timezone — and a departure that started in
          // the future would otherwise play backwards forever, which in a
          // canvas means a negative radius and a dead render loop.
          if (!(age >= 0 && age < DEPART_MS)) {
            departedRef.current.delete(id);
            lastPosRef.current.delete(id);
            continue;
          }
          const htx = Math.round(gone.x);
          const hty = Math.round(gone.y);
          if (!near(htx, hty, 1, 1) || !tileExplored(htx, hty, radius)) continue;
          const pr = age / DEPART_MS;
          const q = iso(gone.x, gone.y);
          // Reduced motion keeps the fade and drops the rise: dissolving in
          // place is what says "gone"; the drift upward is only decoration.
          const gx = ox + q.x;
          const gy = oy + q.y - 18 - (reduceMotion.matches ? 0 : 10 * pr);
          const startAlpha = gone.alpha;
          scene.push({
            s: gone.x + gone.y - 0.5,
            draw: () => {
              ctx.save();
              // The seat empties: a ring opening outward where the body stood,
              // which is the half of this that is still readable at 0.4x.
              ctx.globalAlpha = (1 - pr) * 0.55;
              ctx.strokeStyle = pal.departRing;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.ellipse(gx, gy + 18, 10 + 24 * pr, (10 + 24 * pr) * 0.42, 0, 0, Math.PI * 2);
              ctx.stroke();
              ctx.globalAlpha = startAlpha * (1 - pr) * (1 - pr);
              art.body(ctx, gone.sprite, gx, gy);
              ctx.restore();
            },
          });
        }

        // One sort, one pass. Ties keep insertion order, which is why the
        // pushes above run landmarks first and bodies last: on the same tile,
        // the living thing is in front.
        scene.sort((p, q) => p.s - q.s);
        for (const item of scene) item.draw();

        /* ---- the hour -------------------------------------------------
         * The wash goes down over the terrain, the buildings and the bodies —
         * and over nothing else. Everything you READ off this map is painted
         * after it: speech, nameplates, task captions, hazard marks, the
         * heartbeat rings and the hover card. That is what "legibility beats
         * atmosphere" means in practice rather than as a promise, and it is
         * why the deepest hour can be a third of an alpha without any hour
         * making anything unreadable.
         *
         * Two fillRects for the sky, however far out you are zoomed.
         *
         * Daylight goes down first, as `screen`. A translucent pale fill could
         * not do this job: the campus is painted in dusk values, so a film
         * thin enough to keep the art legible barely moved it and noon looked
         * like midnight with the lanterns off. `screen` raises the blacks and
         * leaves the highlights where they are, which is what daylight does to
         * a dark scene. Then the hue wash, as ordinary alpha, for the colour
         * of the hour rather than its brightness.
         * -------------------------------------------------------------- */
        if (hour.lift > 0.004 || hour.wash) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (hour.lift > 0.004) {
            ctx.save();
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = hour.lift;
            ctx.fillStyle = pal.daylight;
            ctx.fillRect(0, 0, cssW, cssH);
            ctx.restore();
          }
          if (hour.wash) {
            ctx.fillStyle = hour.wash;
            ctx.fillRect(0, 0, cssW, cssH);
          }
          ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * v.px, dpr * v.py);
        }
        // Then the lamps cut back through it. Additive, so a lantern lifts the
        // night rather than painting a disc on it, and smoothed — this is the
        // one thing on a pixel map that must not be nearest-neighboured.
        if (lamps.length) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.imageSmoothingEnabled = true;
          ctx.globalAlpha = Math.min(1, hour.lamp * LAMP_GAIN);
          const glowSprite = glowFor(theme);
          for (const l of lamps) ctx.drawImage(glowSprite, l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
          ctx.restore();
          ctx.imageSmoothingEnabled = false;
        }

        // Speech, above the light. Painted before the nameplates so that when
        // the two would collide it is the caption that loses, not the line
        // somebody just said.
        for (const b of bubbles) art.speech(ctx, b.x, b.y, b.text);

        // Captions last, front-most first, skipping any that would collide:
        // a smeared pile of half-readable task titles is worse than a gap.
        const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
        for (const l of [...labels].sort((p, q) => q.y - p.y)) {
          const box = { x0: l.x - CAPTION_W / 2, y0: l.y + 20, x1: l.x + CAPTION_W / 2, y1: l.y + 44 };
          if (placed.some((r) => box.x0 < r.x1 && box.x1 > r.x0 && box.y0 < r.y1 && box.y1 > r.y0)) continue;
          placed.push(box);
          ctx.save();
          ctx.globalAlpha = l.alpha;
          ctx.textAlign = "center";
          ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = l.nameFill;
          // A dot in the org colour leads the nameplate. It shifts the name by
          // 4px rather than recolouring it: the name's colour already says
          // whether this body is Grove's or Paperclip's.
          const nameText = fitText(ctx, l.name, CAPTION_W - (l.orgColour ? 8 : 0));
          ctx.fillText(nameText, l.x + (l.orgColour ? 4 : 0), l.y + 28);
          if (l.orgColour) {
            const nameW = ctx.measureText(nameText).width;
            ctx.fillStyle = l.orgColour;
            ctx.beginPath();
            ctx.arc(l.x - nameW / 2, l.y + 24.5, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = l.detailFill;
          ctx.fillText(fitText(ctx, l.detail, CAPTION_W), l.x, l.y + 40);
          ctx.restore();
        }

        // Screen-space overlay: never pans or zooms.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Hazard marks, at a fixed size. Everything else on this map shrinks
        // with the zoom; an alarm must not. A stalled body is the same 14px
        // triangle whether you are looking at one room or the whole campus,
        // which is what makes "something is wrong over there" readable from
        // across the world instead of only in a counter.
        for (const h of hazards) {
          const sx = h.x * z + v.px;
          const sy = h.y * z + v.py - 22;
          if (sx < -20 || sx > cssW + 20 || sy < -20 || sy > cssH + 20) continue;
          art.hazard(ctx, sx, sy, h.tone, t);
        }
        // Carry and deposit (costCarry.ts): a turn that reported usage sends its
        // load to the treasury at the Plaza's centre. Screen space, fixed size.
        {
          const bank = iso(PLAZA_CENTER.x, PLAZA_CENTER.y);
          costCarryRef.current.draw(
            ctx,
            (lx, ly) => ({ x: lx * z + v.px, y: ly * z + v.py }),
            { x: ox + bank.x, y: oy + bank.y },
            reduceMotion.matches,
            resourceTerms(theme),
          );
        }
        // The heartbeat rings, at the same fixed size and for the same reason.
        // Offset to the right of the hazard slot so a body that is both faulted
        // and drifting shows both marks rather than one on top of the other.
        for (const m of meters) {
          const sx = m.x * z + v.px + 16;
          const sy = m.y * z + v.py - 24;
          if (sx < -20 || sx > cssW + 20 || sy < -20 || sy > cssH + 20) continue;
          drawHealthMark(ctx, sx, sy, m.drift, t, !reduceMotion.matches);
        }
        // Follow-cam. Runs after the bodies are placed so it can use the same
        // interpolated position they were drawn at, and eases rather than snaps.
        const followId = followRef.current;
        if (followId) {
          const target = actors.find((a) => a.id === followId);
          if (!target) {
            followRef.current = null;
          } else {
            const seat = seatsRef.current.get(target.id) ?? seatInRegion(target.id, target.region);
            const at = bodyAt(target.id, seat);
            const q = iso(at.x, at.y);
            const v = viewRef.current;
            const wantX = cssW / 2 - (ox + q.x) * v.zoom;
            const wantY = cssH / 2 - (oy + q.y) * v.zoom;
            const followEase = reduceMotion.matches ? 1 : 0.12;
            v.px += (wantX - v.px) * followEase;
            v.py += (wantY - v.py) * followEase;
            clampPan();
          }
        }

        /* ---- kiosk: the slow tour --------------------------------------
         * The stop is chosen by dividing the WALL clock, not by counting
         * frames or polls: two displays side by side show the same room at the
         * same moment, a reload rejoins the tour where it already was, and
         * nothing here can drift, shimmer or reorder. It yields for a minute to
         * anyone who touches the map, and it does not run at all under reduced
         * motion — a wall that pans on its own is exactly what that setting is
         * asking us not to do, and a screen that jump-cut every 26 seconds
         * instead would be worse than one that sits still.
         * ---------------------------------------------------------------- */
        if (kioskRef.current && !reduceMotion.matches && nowMs > kioskYieldRef.current) {
          const stop = Math.floor(nowMs / KIOSK_STOP_MS) % KIOSK_STOPS.length;
          if (stop !== tourStopRef.current) {
            tourStopRef.current = stop;
            const s = KIOSK_STOPS[stop]!;
            glideRef.current = { tx: s.tx, ty: s.ty, zoom: s.zoom, start: t };
          }
        }

        /* ---- bookmark glide --------------------------------------------
         * Eased, and through the same clampPan as every other camera, so a
         * bookmark can no more leave the world behind than a drag can. The
         * follow-cam wins outright while it is on: two cameras that both think
         * they are driving is the bug this avoids by never having two.
         *
         * A target the pan clamp cannot reach — the far corner of the world at
         * a zoom that will not fit it — would otherwise never converge, so the
         * glide also gives up on a clock.
         * ---------------------------------------------------------------- */
        const glide = glideRef.current;
        if (glide && !followRef.current) {
          const q = iso(glide.tx, glide.ty);
          const k = reduceMotion.matches ? 1 : 0.1;
          v.zoom = clamp(v.zoom + (glide.zoom - v.zoom) * k, minZoom(), MAX_ZOOM);
          const wantX = cssW / 2 - (ox + q.x) * v.zoom;
          const wantY = cssH / 2 - (oy + q.y) * v.zoom;
          v.px += (wantX - v.px) * k;
          v.py += (wantY - v.py) * k;
          clampPan();
          const arrived =
            Math.abs(v.zoom - glide.zoom) < 0.004 &&
            Math.abs(wantX - v.px) < 1.5 &&
            Math.abs(wantY - v.py) < 1.5;
          if (arrived || t - glide.start > GLIDE_GIVE_UP_MS) glideRef.current = null;
        }
        const hover = hoverRef.current;
        if (hover) {
          const lines: string[] = [
            `${hover.name} · ${hover.detail ?? hover.verb} · ${regionTitle(theme, hover.region)}`,
          ];
          if (hover.flagged) lines.push("Flagged for prompt injection — the chronicle holds the record.");
          if (hover.stalled) lines.push("Stopped reporting — it says it is working, but has gone quiet.");
          if (hover.errorText) lines.push(`Fault: ${hover.errorText.slice(0, 90)}`);
          const hoverHealth = healthOf(hover);
          if (healthVisible(hoverHealth)) lines.push(healthNote(hoverHealth));
          for (const line of toolLines(hover)) lines.push(line.slice(0, 90));
          if (hover.url) lines.push(`${theme.lexicon.construction} · ${hover.url.slice(0, 90)}`);
          if (hover.orgName) lines.push(`Flying ${hover.orgName} colours here.`);
          const consequence = badgeConsequence(hover.badges);
          if (consequence) lines.push(consequence);
          const boxH = 14 + lines.length * 16;
          ctx.fillStyle = pal.card.bg;
          ctx.fillRect(12, cssH - boxH - 12, 460, boxH);
          ctx.textAlign = "left";
          ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
          lines.forEach((ln, i) => {
            ctx.fillStyle = i === 0 ? pal.card.title : hover.stalled && i === 1 ? STALL_RING : pal.card.text;
            ctx.fillText(ln, 20, cssH - boxH + 6 + i * 16);
          });
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    };

    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      controlsRef.current = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("pointercancel", onPointerAbort);
      canvas.removeEventListener("pointerleave", onPointerAbort);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [router]);

  return (
    <section
      data-grove-theme={theme.id}
      style={themeStyle(theme)}
      className={`relative overflow-hidden bg-dusk-950 ${
        kiosk ? "min-h-[100svh]" : "min-h-[calc(100svh-56px)]"
      }`}
    >
      <KioskChrome active={kiosk} onLeave={() => setKioskMode(false)} />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: "pixelated", touchAction: "none" }}
        aria-label="Grove world map"
      />
      {/* Top overlay. On a phone the display heading and the HUD together used
          to eat the screen the world is supposed to fill, so at small widths the
          title drops to a readable 24px, the decorative line stands down, and
          the HUD becomes one compact strip instead of a column beside it.

          Gone entirely in kiosk mode: on a wall display this is the half of the
          page that is talking to somebody who is not there. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex-col gap-2 bg-gradient-to-b from-dusk-950/90 via-dusk-950/55 to-transparent p-4 pb-8 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:bg-none sm:p-6 ${
          // Not the `hidden` attribute: a utility class carrying `display:flex`
          // is an author style and beats the user agent's [hidden] rule, so the
          // overlay would have stayed on the wall display.
          kiosk ? "hidden sm:hidden" : "flex"
        }`}
      >
        <div className="min-w-0 sm:max-w-xl">
          <p className="text-[10px] uppercase tracking-[0.25em] text-lantern-400/80 sm:text-xs">{lex.eyebrow}</p>
          <h1 className="font-display mt-1 text-2xl leading-tight text-lantern-300 sm:text-4xl md:text-5xl">
            {lex.headline}
          </h1>
          <p className="mt-2 hidden max-w-xl text-sm text-white/70 sm:block">
            {lex.subline}
          </p>
          {signedIn === false ? (
            <p className="mt-1 max-w-xl text-xs text-white/60 sm:text-white/45">
              You are watching as a spectator. Tap anyone, any room, or any claimed plot to see what is public
              about it.
            </p>
          ) : null}
        </div>
        <div className="pointer-events-auto w-full shrink-0 rounded-2xl border border-lantern-400/20 bg-dusk-950/80 px-3 py-2 text-[11px] uppercase tracking-widest text-lantern-300/80 sm:w-auto sm:px-4 sm:py-3 sm:text-xs">
          <ResourceBar signedIn={signedIn} />
          <div className="flex items-baseline justify-between gap-3">
            <span>{status}</span>
            {/* The campus clock. UTC and said so: the world is one place, and
                two people watching it from two continents are watching the
                same hour of it, whatever their own clocks say. */}
            {sky ? (
              <span className="shrink-0 tabular-nums text-lantern-300/70" title={`${sky.label} ${lex.skyPlace}`}>
                {sky.clock} <span className="text-white/40">UTC</span>
              </span>
            ) : null}
          </div>
          {sky ? <div className="mt-0.5 text-[10px] text-white/40">{sky.label}</div> : null}
          <div className="mt-1 text-white/60">
            {hud.awake} {lex.hud.awake} · {hud.asleep} {lex.hud.asleep} · {lex.hud.fog} {hud.radius}
            {hud.world ? ` · ${lex.hud.world} ${hud.world}` : ""}
            {hud.spaces ? ` · ${hud.spaces} ${lex.hud.claimed}` : ""}
          </div>
          <div className="mt-1 truncate text-[11px] normal-case tracking-normal text-white/45 sm:mt-2 sm:max-w-[240px]">
            {hud.lastHeard || lex.hud.quiet}
          </div>
          <div className="mt-2 hidden flex-wrap gap-2 text-[10px] normal-case tracking-normal text-white/50 sm:flex">
            {lex.legend.map((word) => (
              <span key={word}>{word}</span>
            ))}
          </div>
          {hud.orgs.length ? (
            <div className="mt-2 hidden flex-wrap items-center gap-2 border-t border-white/10 pt-2 text-[10px] normal-case tracking-normal text-white/55 sm:flex">
              {hud.orgs.map((o) => (
                <span key={o.id} className="inline-flex items-center gap-1">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: o.colour }} />
                  {o.name}
                </span>
              ))}
              <span className="text-white/35">
                {hud.orgMode === "dedicated" ? "· everyone here flies it" : "· by membership"}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      {peek ? <SpectatorPeek peek={peek} signedIn={signedIn} onClose={() => setPeek(null)} /> : null}
      {/* Bottom overlay. These were three separately-pinned clusters that landed
          on top of each other at phone width — the zoom buttons sat underneath
          the "Enter as yourself" pill and could not be pressed at all. One
          column that wraps keeps every control reachable at any width. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-end gap-2 p-4 sm:p-6 ${
          // Kiosk keeps the bell — a wall display exists to show you the alarm —
          // and the exit pill is pinned under it, so the column gets out of its
          // way. Both breakpoints: `sm:p-6` above would otherwise win the
          // padding-bottom back at exactly the widths a wall display runs at.
          kiosk ? "pb-16 sm:pb-20" : ""
        }`}
      >
        {kiosk ? null : <CameraBookmarks items={bookmarks} onGo={jumpTo} goToLabel={lex.controls.goTo} />}
        <AttentionBell counts={hud.attn} position={attnPos} onCycle={cycleAttention} words={lex.bell} />
        {following ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-lantern-400/40 bg-dusk-950/90 py-1.5 pl-4 pr-1.5 text-xs text-lantern-300">
            <span className="truncate">
              {lex.controls.following} {following}
            </span>
            <button
              type="button"
              onClick={stopFollowing}
              className="shrink-0 rounded-full border border-white/20 px-4 py-2.5 text-white/80 sm:px-3 sm:py-1"
            >
              {lex.controls.release}
            </button>
          </div>
        ) : null}
        <div
          className={`w-full flex-wrap items-center justify-between gap-2 ${kiosk ? "hidden" : "flex"}`}
        >
          <div className="pointer-events-auto flex flex-wrap gap-2 text-sm">
            <a href={gp("/login")} className="rounded-full bg-lantern-400 px-5 py-3 font-semibold text-dusk-950 sm:py-2">
              Enter as yourself
            </a>
            <a href={gp("/docs")} className="rounded-full border border-white/15 bg-dusk-950/70 px-5 py-3 text-white/80 sm:bg-transparent sm:py-2">
              curl /skill.md
            </a>
          </div>
          <div className="pointer-events-auto ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out (−)"
              className="h-11 w-11 rounded-full border border-white/15 bg-dusk-950/80 text-xl leading-none text-white/80 sm:h-9 sm:w-9 sm:text-lg"
            >
              −
            </button>
            <button
              type="button"
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in (+)"
              className="h-11 w-11 rounded-full border border-white/15 bg-dusk-950/80 text-xl leading-none text-white/80 sm:h-9 sm:w-9 sm:text-lg"
            >
              +
            </button>
            <button
              type="button"
              onClick={resetView}
              title="Back to the core (0)"
              className="rounded-full border border-white/15 bg-dusk-950/80 px-4 py-3 text-xs uppercase tracking-widest text-white/80 sm:py-2"
            >
              {lex.controls.resetView}
            </button>
            <button
              type="button"
              onClick={() => setKioskMode(true)}
              title="Kiosk mode: the world with no chrome, for a wall display (K). Escape leaves."
              className="rounded-full border border-white/15 bg-dusk-950/80 px-4 py-3 text-xs uppercase tracking-widest text-white/80 sm:py-2"
            >
              {lex.controls.kiosk}
            </button>
            <ThemeSwitcher value={themeId} onChange={(id) => applyTheme(id, true)} label={lex.controls.theme} />
          </div>
        </div>
      </div>
      {/* The one line kiosk mode keeps besides the bell: what time it is here
          and how many bodies are up, in the corner, at the weight of a clock on
          a wall rather than of a heading on a page. */}
      {kiosk && sky ? (
        <div className="pointer-events-none absolute bottom-4 left-4 text-[11px] tabular-nums tracking-wide text-white/35">
          {sky.clock} UTC · {sky.label} · {hud.awake} {lex.hud.awake} · {hud.asleep} {lex.hud.asleep}
        </div>
      ) : null}
    </section>
  );
}
