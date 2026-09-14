"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { asPermissionBadges, consequenceOf, STANCES, type Rect, type Speaker } from "@grove/ui";
import { AWAY_ALPHA, decorSlotTile, describeToolCall, facingFromWire, normaliseMarks, type DecorItem, type SpaceBranding, type SpaceMark, type ToolCallView } from "@grove/protocol";
import { paintDecorClear, plotDecor } from "@/lib/decor";
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
  announceActiveTheme,
  hasOwnThemeChoice,
  readThemeChoice,
  writeThemeChoice,
  type Theme,
  type ThemeId,
} from "@/lib/themes";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { AppearanceMenuGroup } from "./Appearance";
import { linkAtTile, viewedOwnerDefault, type ViewLink } from "@/lib/themes/owner-default";
import { HAZARD_COLOUR, STALL_RING, type HazardTone } from "@/lib/themes/types";
import { enterWallMode } from "@grove/ui/tokens";
import { CHROME_WORDS } from "@/lib/themes/chrome-words";
import { IDENTITY_TICK_W, drawIdentityTick, identityOf, type IdentityKind } from "@/lib/identity";
import { gp } from "@/lib/base";
import { startPoll } from "@/lib/poll";
import { themedAccess } from "@/lib/access";
import { MotionDirector, mergeSpan, spanFromWire, OUTCOME_MARK_MS, type BodyFrame } from "@/lib/motion/director";
import { bodyScreenRect, clearCentre, holeRuns, hoverCardSpot, type Rect as LayerRect } from "@/lib/layering";
import { drawOutcomeMark, drawPlayingMark, drawRestingMark, drawStanceMark, drawTrialRing, drawWorkBar, RESTING_MARK_COLOUR, scaffoldStageFor } from "@/lib/motion/marks";
import { useTrialStage } from "@/components/useTrialStage";
import { usePlayingTables } from "@/components/usePlayingTables";
import { restingBodies, type RestingBody, type RestingWire } from "@/lib/resting";
import { SpeechBook, markRect, paintSpeech, speechPainter } from "@/lib/speech-render";
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
import type { OrgBadge, Peek } from "./SpectatorPeek";
import { loginHref } from "@/lib/login-href";
import { deepLinkApplies, parseDeepLink, resolveAt, type DeepLink } from "@/lib/deep-link";
import {
  centreOn,
  clampTile,
  insetCollapsedDefault,
  insetTransform,
  worldCentre,
} from "@/lib/camera";
import {
  DEPTH_ANGLE,
  DEPTH_KEY,
  aimScreenY,
  clampPanTilted,
  depthPreference,
  easeTilt,
  fitZoomTilted,
  focusOf,
  fromScreen,
  groundTransform,
  perspectiveScale,
  shadowSpec,
  stepParallax,
  tiltFor,
  tiltY,
  toScreen,
  viewportBoxTilted,
  zoomRangeTilted,
  type LayerHeight,
} from "@/lib/depth";
import {
  districtLabelsVisible,
  districtStops,
  districtStopsKey,
  inDistrict,
  ringLabelAnchors,
  ringNumberLabel,
  type DistrictStop,
} from "@/lib/districts";
import { districtName, worldDistricts } from "@grove/protocol";
import { estateSignContent, estateSignVisible, layoutEstateSign, layoutSignboard, plotBranding, plotEdgeColour, signContent, signboardVisible, supporterTrim } from "@/lib/signboard";
import { estatePerimeter, estateSignTile, readEstates, type MapEstate } from "@/lib/estates";
import { WATCH_HEADER, formatHeadcount, makeWatchToken } from "@/lib/headcount";
import { AttentionBell } from "./AttentionBell";
import { FirstVisitCard, MAP_KEYS, MENU_ROW, MapMenu, MapPanel, MenuHeading, MenuItem, MenuLink } from "./MapMenu";
import type { RoomPublicView } from "./RoomDrawer";
import type { Arrival } from "./WalkInSheet";
import { ArrivalToast } from "./ArrivalToast";
import { readWorldUrl, roomHref, withHistory, withRoom, type WorldUrl } from "@/lib/world-url";
import {
  FIRST_VISIT_KEY,
  WALK_IN_SEEN_KEY,
  autoWalkIn,
  browserStore,
  mapCta,
  readFlag,
  writeFlag,
} from "@/lib/walk-in";
import { KIOSK_ATTR, KioskChrome } from "./KioskChrome";
import type { TvActor, TvDirector, TvShotKind, TvStage } from "@/lib/tv/director";
import { useSoundscape } from "@/lib/sound/useSoundscape";
import { SoundMenuSection, TapForSound } from "./SoundControls";
import { ReplayController, startVisitClock, type LiveContext } from "@/lib/replay/controller";
import { ReplayMotion } from "@/lib/replay/motion";
import { ResourceBar } from "./ResourceBar";
import { composePostcard, downloadBlob, nearestToCentre, postcardCaption, postcardFilename } from "@/lib/postcard";
import { CostCarry } from "./costCarry";
// Code-split map chrome (#68): loaded the first time each is shown.
import { CinemaBars, HistoryDrawer, ReplayBadge, ReplayBar, RoomDrawer, SequenceRecorder, SpectatorPeek, WalkInSheet, usePrefetchMapDrawers } from "./WorldMapLazy";
import { SEQUENCE_QUERY, parseSequenceRef, toCamel, validateSequence, type CameraKey, type Sequence, type SequenceShotKind } from "@grove/protocol";
import {
  addShot,
  buildTimeline,
  cameraAt,
  clampCamera,
  draftSequence,
  emptyDraft,
  inlineSequenceLink,
  removeLastShot,
  storedSequenceLink,
  type Draft,
  type Timeline,
} from "@/lib/sequence";
import { resourceTerms } from "@/lib/cost";
import { bodyWashErase, skyAt, type Sky } from "./skyClock";
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
/** Grove TV's close-up when it follows a body. */
const TV_ZOOM = 1.35;
/** How often the TV director reconsiders the shot. Cuts are held for seconds; this is only the sampling rate. */
const TV_STEP_MS = 500;
/** The Stage's schedule changes on the scale of minutes. */
const TV_STAGE_POLL_MS = 30_000;
/** Where Go to ▾ lands on a district: far enough out to see its neighbours. */
const DISTRICT_ZOOM = 0.75;
/** The minimap inset redraws at most this often; it is an overview, not a second map. */
const INSET_REDRAW_MS = 200;
/** Inset size in CSS px. */
const INSET_W = 168;
const INSET_H = 112;
/** localStorage: "1" when the viewer folded the minimap away, "0" when they opened it. */
const INSET_KEY = "grove-minimap-collapsed";
/** A glide that cannot reach its mark (clamped at the world edge) gives up here. */
const GLIDE_GIVE_UP_MS = 4_000;
/** A live line is forgotten this long after it was said, unless the poll re-seeds it. */
const SPEECH_MAX_AGE_MS = 5 * 60_000;
/** A tapped body's line stays open in full for this long. */
const SPEECH_EXPAND_MS = 8_000;
/** Lines kept in the screen-reader log. */
const HEARD_KEEP = 8;
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
  /** Achievement mark keys (030). Empty for a redacted row. */
  marks?: string[];
  /** Owner branding (035). Null for a redacted row. */
  branding?: unknown;
  /** Placed plot decor (#45). Empty for a redacted row. */
  decor?: unknown;
  /** The owner is an active supporter (#47). False on a private plot and while supporters are off. */
  supporter?: boolean;
  /** The owner's default theme (#59). Null for a redacted row. */
  default_theme?: string | null;
  defaultTheme?: string | null;
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
  /** Achievement marks, keys only. Always empty on a private plot. */
  marks: SpaceMark[];
  /** Owner branding (035), re-checked. Always null on a private plot (lib/signboard). */
  branding: SpaceBranding | null;
  /** The estate (#37) this plot has joined, or null. Never set on a private plot (lib/estates). */
  estateId: string | null;
  /** Owner-placed decor (#45) on the plot's decor slots. Always empty on a private plot (lib/decor). */
  decor: DecorItem[];
  /** The owner's default theme (#59), public plots only; members get a private plot's from their own list. */
  defaultTheme: string | null;
  /** Supporter sign trim (#51). Never true on a private plot (lib/signboard `supporterTrim`). */
  supporter: boolean;
};

/*
 * Access-level words, room names and every other UI word the map says now come
 * from the active theme's lexicon (lib/themes). Access level is public even
 * when the space's contents are not.
 */
/** The default theme's plain access words, used by the chrome in every theme. */
const DEFAULT_THEME_OBJ: Theme = THEMES[DEFAULT_THEME];

function accessLabel(theme: Theme, preset: string): string {
  return themedAccess((theme.lexicon.access as Record<string, { label: string } | undefined>)[preset]?.label, preset);
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
  /** Joined estates over public plots (#37); see lib/estates. */
  estates?: unknown;
  /** Agents resting at their home plot (never live bodies); see lib/resting. */
  resting?: RestingWire[];
  claimed_agents?: number;
  claimedAgents?: number;
  /** Distinct map tabs heard from recently (AudienceService); null = not counted. */
  watching?: number | null;
  audience_cap?: number;
  paperclip?: { ok: boolean; agents: PaperclipBody[]; issues?: PaperclipIssue[] };
  /** #60: public facing hints {from, to, until}; see @grove/protocol facing.ts. */
  facing?: unknown[];
};

type Actor = {
  id: string;
  name: string;
  /** Grove bodies only: what `?follow=` names. Paperclip bodies have none. */
  slug?: string;
  kind: "human" | "agent" | "paperclip";
  region: MapRegion;
  activity: string;
  verb: AgentVerb;
  source: "grove" | "paperclip";
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
  /** #60: whom it just addressed in public (a server hint, never a whisper), and until when (ms). */
  addressing?: string | null;
  addressingUntil?: number | null;
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

/** The same rgba colour at a chosen alpha: the map's plot tints are films, the minimap needs solid marks. */
function withAlpha(colour: string, alpha: number): string {
  const m = /^rgba?\(([^)]+)\)$/.exec(colour.trim());
  if (!m) return colour;
  const parts = m[1]!.split(",").map((p) => p.trim());
  return parts.length >= 3 ? `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})` : colour;
}

/** A plot block key. Claimed land is never lost in the fog (#38): see `revealed`. */
function blockKey(tx: number, ty: number): string {
  return `${Math.floor(tx / PLOT_COLS)},${Math.floor(ty / PLOT_ROWS)}`;
}

/**
 * Explored, or on a claimed plot. The fog is how far the world has been
 * walked, and it used to swallow claimed plots in the outer rings whole: you
 * could pan to one and find nothing there. Claimed land (held plots included,
 * which the minimap already places) always shows through.
 */
function revealed(tx: number, ty: number, radius: number, claimed: ReadonlySet<string>): boolean {
  return tileExplored(tx, ty, radius) || (claimed.size > 0 && claimed.has(blockKey(tx, ty)));
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

/**
 * Reads the address for the map. Its own component inside a Suspense boundary,
 * so `useSearchParams` never takes the map's server render with it; and the
 * one source of truth for which drawer is open, whether the address changed by
 * a click here, a <Link> elsewhere, or the back button.
 */
function WorldUrlSync({ onChange }: { onChange: (u: WorldUrl) => void }) {
  const params = useSearchParams();
  const key = params.toString();
  useEffect(() => {
    onChange(readWorldUrl(key));
  }, [key, onChange]);
  return null;
}

/** A button's shape in the bottom row. */
const CONTROL =
  "pointer-events-auto flex h-11 items-center rounded-gh-pill border border-line gh-frost px-4 gh-label text-ink shadow-gh-2 hover:bg-tint sm:h-9";

export function WorldMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actorsRef = useRef<Actor[]>([]);
  const costCarryRef = useRef(new CostCarry());
  const radiusRef = useRef(4);
  const plotsRef = useRef(0);
  const plotRef = useRef<Plot[]>([]);
  const estateRef = useRef<MapEstate[]>([]);
  /** Blocks holding a claimed plot, for `revealed`. Rebuilt on every poll. */
  const claimedBlocksRef = useRef<ReadonlySet<string>>(new Set());
  /** Go to ▾ districts (#38): only those holding a public plot. */
  const [districts, setDistricts] = useState<Array<Omit<DistrictStop, "name">>>([]);
  const districtsKeyRef = useRef("");
  /** The minimap inset (#38). Null while folded away, so the draw loop skips it. */
  const insetRef = useRef<HTMLCanvasElement>(null);
  const insetDrawnRef = useRef(0);
  /** The last inset transform, so a click on the inset maps back to the world. */
  const insetXformRef = useRef<ReturnType<typeof insetTransform> | null>(null);
  const [insetCollapsed, setInsetCollapsed] = useState(true);
  /** Depth view (#46): a viewer preference, off by default, remembered in this browser. */
  const [depthOn, setDepthOn] = useState(false);
  /**
   * What the renderer reads for Depth view each frame: whether it is on, the
   * tilt as currently drawn (it eases), the ground's parallax trail, and the
   * last focus it was measured from. Never stored in a shot or a link.
   */
  const depthRef = useRef({ on: false, k: 1, lag: { x: 0, y: 0 }, lastF: null as { fx: number; fy: number } | null, lastT: 0 });
  /** Resting at plot: drawn, never counted, followed, cut to or rung for. */
  const restingRef = useRef<RestingBody[]>([]);
  const seatsRef = useRef<Map<string, Seat>>(new Map());
  const lastHeardRef = useRef<string | null>(null);
  /** Where every body is going and why: docs/design/MOTION.md. */
  const motionRef = useRef<MotionDirector | null>(null);
  if (!motionRef.current) motionRef.current = new MotionDirector();
  /** Who said what, newest per body. Painted through lib/speech-render. */
  const speechRef = useRef(new SpeechBook());
  /** Slot memory and tier between frames, so bubbles hold still. */
  const speechPaintRef = useRef(speechPainter());
  /** A body whose line is shown in full at any zoom: tapped, for a few seconds. */
  const expandRef = useRef<{ id: string; until: number } | null>(null);
  /** Screen rects of the HTML laid over the canvas, refreshed a few times a second. */
  const overlayRectsRef = useRef<{ at: number; rects: Rect[] }>({ at: 0, rects: [] });
  /** Open drawers over the canvas, in canvas px: the follow-cam frames the part they leave clear (#52). */
  const coverRectsRef = useRef<LayerRect[]>([]);
  /**
   * The same speech as text, for a screen reader: the canvas must not be the
   * only thing carrying what people say. Newest last, a handful kept.
   */
  const [heard, setHeard] = useState<Array<{ key: string; who: string; body: string }>>([]);
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
  /** Chrome speaks plain words whatever the theme; `lex` is for in-world names only. */
  const words = CHROME_WORDS;
  const controlsRef = useRef<{
    zoomBy: (f: number) => void;
    reset: () => void;
    goTo: (tx: number, ty: number, zoom: number) => void;
    /** Centre the camera on a layout-space point at once (the minimap). */
    centreLayout: (x: number, y: number) => void;
    /** The body drawn nearest the middle of the frame, if one is close. */
    centred: () => string | null;
    /** The camera as a tile framing: the tile under the middle of the view, and the zoom (#39). */
    cameraKey: () => CameraKey;
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
  const glideRef = useRef<{ tx: number; ty: number; zoom: number; start: number; fit?: boolean } | null>(null);
  const [kiosk, setKiosk] = useState(false);
  const kioskRef = useRef(false);
  /** Kiosk yields to a person who touches the map, rather than fighting them. */
  const kioskYieldRef = useRef(0);
  const tourStopRef = useRef(-1);
  /* Grove TV: kiosk mode with a director (lib/tv/director). */
  const [tv, setTv] = useState(false);
  const tvRef = useRef(false);
  /** Loaded with TV itself (#68): null until TV is first switched on. */
  const tvDirectorRef = useRef<TvDirector | null>(null);
  /** The live Stage event, if any, polled only while TV is on. */
  const tvStageRef = useRef<TvStage | null>(null);
  /** The open trial on the Stage (040): trial rings on entrants, and a TV shot. */
  const trialRef = useTrialStage();
  /** Bodies at board tables (#42): the "playing" glyph, and TV's game moments. */
  const playingRef = usePlayingTables();
  /** The shot the camera was last pointed at; null = point it again (after a person let go). */
  const tvAppliedRef = useRef<string | null>(null);
  const tvLastStepRef = useRef(0);
  const tvCaptionKeyRef = useRef("");
  const [tvCaption, setTvCaption] = useState<{ kind: TvShotKind; caption: string; paused: boolean } | null>(null);
  /** Public lines already handed to the director, so a poll never re-tells one. Null until the first poll. */
  const tvSpeechSeenRef = useRef<Set<string> | null>(null);
  const tvModeRef = useRef<(on: boolean) => void>(() => {});
  /* Ambient soundscape (#43, lib/sound): off by default, on in kiosk/TV after a tap. Stable `scape`. */
  const sound = useSoundscape({ kiosk, sound: theme.sound });
  usePrefetchMapDrawers();
  const soundscape = sound.scape;
  /* --- cinematic sequences (#39, lib/sequence) ------------------------ *
   * A playing sequence owns the camera outright, the way TV does, and hides
   * the chrome. Its clock is advanced by the draw loop: wall time live, and
   * only while the replay plays when a replay is on.
   * ------------------------------------------------------------------ */
  const cinemaRef = useRef<{
    seq: Sequence;
    tl: Timeline;
    elapsed: number;
    lastT: number | null;
    last: CameraKey | null;
    done: boolean;
    holding: boolean;
    shownAt: number;
  } | null>(null);
  const [cinema, setCinema] = useState<{ title: string | null; total: number; done: boolean; preview: boolean; holding: boolean } | null>(null);
  const [cinemaElapsed, setCinemaElapsed] = useState(0);
  /** A sequence from the link, waiting for the first poll to say how big the world is. */
  const pendingSeqRef = useRef<Sequence | null>(null);
  const startCinemaRef = useRef<(seq: Sequence, preview: boolean) => void>(() => {});
  const stopCinemaRef = useRef<() => void>(() => {});
  const [recorder, setRecorder] = useState<Draft | null>(null);
  const [recKind, setRecKind] = useState<SequenceShotKind>("path");
  const [recSeconds, setRecSeconds] = useState(5);
  const [recNote, setRecNote] = useState<string | null>(null);
  const [recLink, setRecLink] = useState<string | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  /**
   * A shareable deep link read on load (lib/deep-link), waiting for what it
   * needs: `at` for the camera controls, `follow` for the body to be on the
   * map. Consumed once. Null when there is none, or when TV owns the camera.
   */
  const deepLinkRef = useRef<(DeepLink & { tries: number }) | null>(null);
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
    /** The headcount pill: live only, never during replay. */
    live: false,
    here: 0,
    watching: null as number | null,
    watchCap: null as number | null,
  });
  /**
   * This tab's audience token: random, in memory only, new on every load. It
   * lets the server count distinct watchers without knowing who any of them is
   * (lib/headcount, AudienceService).
   */
  const watchTokenRef = useRef<string | null>(null);
  const [status, setStatus] = useState("charting the dusk…");

  /* --- replay (MAP-04) ----------------------------------------------- *
   * Replay swaps the SOURCE of the minimap payload and the CLOCK, nothing
   * else: pull() draws the ledger at the playhead instead of the live map, and
   * bodies are moved by the same MotionDirector stepped on historical time
   * (lib/replay/motion). Same seating, verbs, bubbles, spans and theme as live.
   * ------------------------------------------------------------------- */
  const pullRef = useRef<() => void>(() => {});
  const lastLiveRef = useRef<LiveContext | null>(null);
  const [replay] = useState(() => new ReplayController(() => pullRef.current()));
  const [replayMotion] = useState(
    () =>
      new ReplayMotion(
        replay,
        (bodies) =>
          assignSeats(
            bodies.map((b) => {
              const room = b.room_slug as MapRegion;
              const region =
                room === "plaza" || room === "library" || room === "workshop" || room === "stage" || room === "garden" || room === "board"
                  ? room
                  : "plaza";
              return { id: b.id, name: b.id, kind: b.kind, region, activity: b.activity, verb: "idle", source: "grove" } as Actor;
            }),
          ),
        () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
  );
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    const off = replay.subscribe(() => setReplaying(replay.view.active));
    const stopClock = startVisitClock();
    return () => {
      off();
      stopClock();
      replay.dispose();
    };
  }, [replay]);

  /* --- drawers (DECISIONS #1) ---------------------------------------- *
   * A room and the History are drawers over the running map, and the address
   * says which one is open (lib/world-url): `/?room=<slug>`, `/?history=1`.
   * Opening pushes a history entry, so Back closes the drawer; everything else
   * in the address (theme pin, follow, at) is left alone.
   * ------------------------------------------------------------------- */
  const [worldUrl, setWorldUrl] = useState<WorldUrl>({ room: null, history: false, arrived: false });
  const worldUrlRef = useRef(worldUrl);
  worldUrlRef.current = worldUrl;
  const [roomExpanded, setRoomExpanded] = useState(false);
  const onUrl = useCallback((u: WorldUrl) => setWorldUrl(u), []);
  const navigateWorld = useCallback((qs: string, mode: "push" | "replace" = "push") => {
    try {
      const { pathname, hash } = window.location;
      const href = `${pathname}${qs}${hash}`;
      if (mode === "push") window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    } catch {
      /* the drawer still opens from state below */
    }
    setWorldUrl(readWorldUrl(qs));
  }, []);
  const openRoom = useCallback(
    (slug: string, opts: { arrived?: boolean } = {}) => {
      setPeek(null);
      const cur = worldUrlRef.current;
      // Moving from one room to the next replaces; Back still leaves the room.
      navigateWorld(withRoom(window.location.search, slug, opts), cur.room ? "replace" : "push");
    },
    [navigateWorld],
  );
  const closeDrawer = useCallback(() => {
    let qs = withRoom(window.location.search, null);
    qs = withHistory(qs, false);
    // Replace, so Back after closing does not reopen what was just closed.
    navigateWorld(qs, "replace");
  }, [navigateWorld]);
  const openHistory = useCallback(() => {
    setPeek(null);
    navigateWorld(withHistory(window.location.search, true), worldUrlRef.current.room ? "replace" : "push");
  }, [navigateWorld]);
  const openRoomRef = useRef(openRoom);
  openRoomRef.current = openRoom;
  const closeDrawerRef = useRef(closeDrawer);
  closeDrawerRef.current = closeDrawer;
  const toggleHistoryRef = useRef<() => void>(() => {});
  toggleHistoryRef.current = () => (worldUrlRef.current.history ? closeDrawer() : openHistory());

  /** The signed-in viewer's actor id, and whether their body is on the map. Null = not known yet. */
  const myIdRef = useRef<string | null>(null);
  const [meInside, setMeInside] = useState<boolean | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const [panel, setPanel] = useState<"keys" | "legend" | null>(null);
  const [firstVisit, setFirstVisit] = useState(false);
  useEffect(() => setFirstVisit(!readFlag(browserStore(), FIRST_VISIT_KEY)), []);
  const dismissFirstVisit = useCallback(() => {
    setFirstVisit(false);
    writeFlag(browserStore(), FIRST_VISIT_KEY);
  }, []);
  useEffect(() => {
    if (!arrival) return;
    const t = window.setTimeout(() => setArrival(null), 4000);
    return () => window.clearTimeout(t);
  }, [arrival]);

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
    if (!persist) {
      // The drawer follows what the map shows, owner default included (#59).
      announceActiveTheme(id);
      return;
    }
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

  /*
   * Step 3 of the theme order (#59): the owner default of the space being
   * viewed — a link that targets its plot, or the camera centred on it
   * (lib/themes/owner-default). Soft: never while the viewer has a `?theme=`
   * pin or a stored choice, and not in kiosk or TV, whose cuts would re-skin
   * the wall every few seconds. Checked on a slow tick, not per frame.
   */
  const ownerLinkRef = useRef<ViewLink | null>(null);
  const pendingOwnerLinkRef = useRef<{ tx: number; ty: number } | { bodyId: string; since: number } | null>(null);
  const ownerPlotRef = useRef<number | null>(null);
  const memberThemesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    const tick = () => {
      const plots = plotRef.current;
      const cam = controlsRef.current?.cameraKey();
      if (!cam || !plots.length) return;
      const now = Date.now();
      const pending = pendingOwnerLinkRef.current;
      if (pending && "tx" in pending) {
        ownerLinkRef.current = linkAtTile(pending.tx, pending.ty, plots, now);
        pendingOwnerLinkRef.current = null;
      } else if (pending) {
        const pos = lastPosRef.current.get(pending.bodyId);
        if (pos) {
          ownerLinkRef.current = linkAtTile(Math.round(pos.x), Math.round(pos.y), plots, now);
          pendingOwnerLinkRef.current = null;
        } else if (now - pending.since > 12_000) pendingOwnerLinkRef.current = null;
      }
      const wall = kioskRef.current || tvRef.current;
      const r = viewedOwnerDefault({
        camera: cam,
        plots,
        memberDefaults: memberThemesRef.current,
        link: wall ? null : ownerLinkRef.current,
        current: ownerPlotRef.current,
        now,
      });
      ownerLinkRef.current = r.link;
      ownerPlotRef.current = r.plotIndex;
      if (hasOwnThemeChoice()) return;
      const want = readThemeChoice(wall ? null : r.theme);
      if (want !== chosenRef.current.id) applyTheme(want, false);
    };
    const timer = window.setInterval(tick, 600);
    return () => window.clearInterval(timer);
  }, [applyTheme]);

  /** Postcard (lib/postcard): the canvas plus a caption, downloaded locally. Nothing is posted. */
  const savePostcard = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const id = followRef.current ?? controlsRef.current?.centred() ?? null;
    const a = id ? actorsRef.current.find((x) => x.id === id) : undefined;
    const at = replay.view.active ? replay.view.playhead : Date.now();
    const theme = chosenRef.current;
    const caption = postcardCaption({
      lex: theme.lexicon,
      at,
      replay: replay.view.active,
      subject: a
        ? { name: a.name, kind: a.kind, region: a.region, verb: a.verb, detail: a.detail, followed: a.id === followRef.current }
        : null,
      privateNames: plotRef.current.filter((p) => p.preset === "private" && p.name).map((p) => p.name!),
      sequenceTitle: cinemaRef.current?.seq.title ?? null,
    });
    const blob = await composePostcard(canvas, caption, themeRef.current.palette);
    if (blob) downloadBlob(blob, postcardFilename(at));
  }, [replay]);

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
    // Somebody pressed it: the TV director and the kiosk tour stand down for a while.
    kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
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
  // TV and kiosk are for a wall across a room: the chrome goes to the `tv`
  // brand mode (night, larger type) unless this viewer chose light, and the
  // viewer's own choice comes back when they leave (DECISIONS #7).
  useEffect(() => {
    if (!kiosk) return;
    try {
      return enterWallMode();
    } catch {
      return undefined;
    }
  }, [kiosk]);

  const setKioskMode = useCallback((on: boolean) => {
    kioskRef.current = on;
    tourStopRef.current = -1;
    setKiosk(on);
    // Leaving kiosk mode leaves TV with it, and lets go of the body TV was on.
    if (!on && tvRef.current) {
      tvRef.current = false;
      setTv(false);
      setTvCaption(null);
      tvCaptionKeyRef.current = "";
      followRef.current = null;
      setFollowing(null);
      setAttnPos(null);
      glideRef.current = null;
    }
    try {
      if (on) document.documentElement.setAttribute(KIOSK_ATTR, "1");
      else document.documentElement.removeAttribute(KIOSK_ATTR);
      const url = new URL(window.location.href);
      if (on && !tvRef.current) url.searchParams.set("kiosk", "1");
      else url.searchParams.delete("kiosk");
      if (on && tvRef.current) url.searchParams.set("tv", "1");
      else url.searchParams.delete("tv");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* A browser that refuses either of those still gets the mode itself. */
    }
  }, []);

  /**
   * Grove TV. Kiosk mode, plus a director that points the camera at what is
   * happening — hazards, tool-call bursts, conversations, arrivals, the Stage —
   * and captions it. Entered by ?tv=1, the TV button or V; left exactly the way
   * kiosk mode is (Escape, the pill, K), because it IS kiosk mode.
   */
  const setTvMode = useCallback(
    (on: boolean) => {
      if (!on) {
        setKioskMode(false);
        return;
      }
      tvRef.current = true;
      tvDirectorRef.current = null;
      void import("@/lib/tv/director").then((m) => {
        if (tvRef.current && !tvDirectorRef.current) tvDirectorRef.current = new m.TvDirector();
      });
      tvAppliedRef.current = null;
      tvLastStepRef.current = 0;
      kioskYieldRef.current = 0;
      setTv(true);
      setKioskMode(true);
    },
    [setKioskMode],
  );

  useEffect(() => {
    kioskModeRef.current = setKioskMode;
    tvModeRef.current = setTvMode;
  }, [setKioskMode, setTvMode]);

  /** Play a sequence (#39). Takes the camera from TV, kiosk and any follow; hides the chrome. */
  const startCinema = useCallback(
    (seq: Sequence, preview: boolean) => {
      if (kioskRef.current) setKioskMode(false);
      followRef.current = null;
      setFollowing(null);
      setAttnPos(null);
      glideRef.current = null;
      setPeek(null);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const tl = buildTimeline(seq, { reduced });
      cinemaRef.current = { seq, tl, elapsed: 0, lastT: null, last: null, done: false, holding: false, shownAt: 0 };
      // Over a replay, the sequence runs on the replay's clock: start it playing.
      if (replay.view.active && !replay.view.playing) replay.play();
      setCinemaElapsed(0);
      setCinema({ title: seq.title, total: tl.total, done: false, preview, holding: false });
      try {
        document.documentElement.setAttribute(KIOSK_ATTR, "1");
      } catch {
        /* the sequence still plays */
      }
    },
    [replay, setKioskMode],
  );
  const stopCinema = useCallback(() => {
    cinemaRef.current = null;
    setCinema(null);
    try {
      if (!kioskRef.current) document.documentElement.removeAttribute(KIOSK_ATTR);
      // Leaving strips ?seq=, so a reload opens the map rather than the film.
      const url = new URL(window.location.href);
      if (url.searchParams.has(SEQUENCE_QUERY)) {
        url.searchParams.delete(SEQUENCE_QUERY);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      /* ignore */
    }
  }, []);
  const againCinema = useCallback(() => {
    const run = cinemaRef.current;
    if (!run) return;
    run.elapsed = 0;
    run.lastT = null;
    run.done = false;
    if (replay.view.active && !replay.view.playing) replay.play();
    setCinemaElapsed(0);
    setCinema((c) => (c ? { ...c, done: false } : c));
  }, [replay]);
  useEffect(() => {
    startCinemaRef.current = startCinema;
    stopCinemaRef.current = stopCinema;
  }, [startCinema, stopCinema]);

  /* The recorder: shots from the viewer's own camera moves. */
  const openRecorder = useCallback(() => {
    if (kioskRef.current) setKioskMode(false);
    setRecorder((d) => d ?? emptyDraft(controlsRef.current?.cameraKey() ?? null));
    setRecNote(null);
    setRecLink(null);
  }, [setKioskMode]);
  const followedSlug = useCallback((): string | null => {
    const id = followRef.current;
    const a = id ? actorsRef.current.find((x) => x.id === id) : undefined;
    return a?.slug ?? null;
  }, []);
  const recordShot = useCallback(() => {
    const cam = controlsRef.current?.cameraKey();
    if (!cam) return;
    setRecorder((d) => (d ? addShot(d, cam, recKind, recSeconds * 1000, followedSlug()) : d));
    setRecLink(null);
    setRecNote(null);
  }, [recKind, recSeconds, followedSlug]);
  const previewDraft = useCallback(() => {
    if (!recorder) return;
    const r = draftSequence(recorder);
    if (!r.ok) {
      setRecNote(r.message);
      return;
    }
    startCinema(r.sequence, true);
  }, [recorder, startCinema]);
  const copyDraftLink = useCallback(async () => {
    if (!recorder) return;
    const r = draftSequence(recorder);
    if (!r.ok) {
      setRecNote(r.message);
      return;
    }
    let link = inlineSequenceLink(window.location.href, r.sequence);
    if (!link) {
      // Too long for a link: store it (signed in), link its id.
      if (!signedIn) {
        setRecNote("Too long for a link. Sign in to save it, or take out a shot or shorten the title.");
        return;
      }
      setRecBusy(true);
      try {
        const res = await api<{ id: string }>("/api/v1/sequences", { method: "POST", body: JSON.stringify({ sequence: r.sequence }) });
        link = storedSequenceLink(window.location.href, res.id);
      } catch (err) {
        setRecNote((err as Error).message || "Could not save the sequence.");
        return;
      } finally {
        setRecBusy(false);
      }
    }
    setRecLink(link);
    try {
      await navigator.clipboard.writeText(link);
      setRecNote("Link copied.");
    } catch {
      setRecNote("Copy the link above.");
    }
  }, [recorder, signedIn]);

  useEffect(() => {
    let wanted = false;
    let wantTv = false;
    const on = (q: string | null) => q !== null && q !== "0" && q !== "false";
    try {
      const params = new URLSearchParams(window.location.search);
      wanted = on(params.get("kiosk"));
      wantTv = on(params.get("tv"));
      const link = parseDeepLink(params);
      if (deepLinkApplies(params) && (link.follow || link.at)) deepLinkRef.current = { ...link, tries: 0 };
      // #59: a link that lands on a plot shows that space's owner default.
      if (deepLinkApplies(params) && link.at && !link.follow) pendingOwnerLinkRef.current = link.at;
      // ?seq=: a sequence inline, or a stored one by id (#39). Plays after the first poll.
      const ref = parseSequenceRef(params.get(SEQUENCE_QUERY));
      const seqLink = (seq: Sequence) => {
        const first = seq.shots[0];
        if (first && !pendingOwnerLinkRef.current) pendingOwnerLinkRef.current = { tx: first.from.tx, ty: first.from.ty };
      };
      if (ref?.kind === "inline") {
        pendingSeqRef.current = ref.sequence;
        seqLink(ref.sequence);
      }
      else if (ref?.kind === "id") {
        void api<{ sequence?: unknown }>(`/api/v1/sequences/${ref.id}`)
          .then((res) => {
            const r = validateSequence(toCamel(res.sequence ?? null));
            if (r.ok) {
              pendingSeqRef.current = r.sequence;
              seqLink(r.sequence);
            }
          })
          .catch(() => {
            /* a stored sequence that is gone: the map simply opens */
          });
      }
    } catch {
      wanted = false;
    }
    if (wantTv) setTvMode(true);
    else if (wanted) setKioskMode(true);
    return () => {
      // The attribute lives on <html>, outside React's tree, so it has to be
      // taken off by hand or navigating away leaves the nav hidden.
      try {
        document.documentElement.removeAttribute(KIOSK_ATTR);
      } catch {
        /* ignore */
      }
    };
  }, [setKioskMode, setTvMode]);

  /* The Stage, for TV only: a live event is a shot. Public, like the Stage signpost. */
  useEffect(() => {
    if (!tv) {
      tvStageRef.current = null;
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api<{
          stage?: { room_id?: string; live?: { title?: string; starts_at?: string } | null };
        }>("/api/v1/civic/stage");
        if (cancelled) return;
        const live = res.stage?.live;
        // Only the civic core's Stage is a landmark on this map.
        tvStageRef.current =
          live?.title && live.starts_at && res.stage?.room_id === "stage"
            ? { title: live.title, startsAt: live.starts_at, region: "stage" }
            : null;
      } catch {
        /* No schedule this time; the other shots still run. */
      }
    };
    const stopPoll = startPoll(() => void load(), TV_STAGE_POLL_MS);
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [tv]);

  /* --- the minimap inset (#38) -------------------------------------- *
   * Folded away on phones unless the viewer opened it; the choice is kept in
   * this browser. A press or drag on it moves the camera there at once.
   * ------------------------------------------------------------------- */
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(INSET_KEY);
    } catch {
      /* private window: fall back to the default */
    }
    setInsetCollapsed(insetCollapsedDefault(stored, window.matchMedia("(max-width: 639px)").matches));
  }, []);
  const toggleInset = useCallback(() => {
    setInsetCollapsed((was) => {
      const next = !was;
      try {
        window.localStorage.setItem(INSET_KEY, next ? "1" : "0");
      } catch {
        /* not remembered; still toggles */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(DEPTH_KEY);
    } catch {
      /* private window: off */
    }
    const on = depthPreference(stored);
    depthRef.current.on = on;
    setDepthOn(on);
  }, []);
  const toggleDepth = useCallback(() => {
    const next = !depthRef.current.on;
    depthRef.current.on = next;
    setDepthOn(next);
    try {
      window.localStorage.setItem(DEPTH_KEY, next ? "1" : "0");
    } catch {
      /* not remembered; still toggles */
    }
  }, []);
  const insetDragRef = useRef(false);
  const insetMove = useCallback((ev: React.PointerEvent<HTMLCanvasElement>) => {
    const xf = insetXformRef.current;
    if (!xf) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const p = xf.fromInset(ev.clientX - rect.left, ev.clientY - rect.top);
    controlsRef.current?.centreLayout(p.x, p.y);
  }, []);

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

  const bookmarks: Array<{ key: string; label: string; title: string }> = [
    ...BOOKMARK_REGIONS.map(({ key, region }) => ({
      key,
      label: lex.regions[region].title,
      title: lex.regions[region].bookmark,
    })),
    { key: "b", label: words.controls.busiest, title: words.controls.busiestTitle },
    ...(hasMySpace ? [{ key: "m", label: words.controls.mySpace, title: words.controls.mySpaceTitle }] : []),
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
        myIdRef.current = (res.human as { id?: string } | undefined)?.id ?? null;
        // The handle is what the public minimap names a plot's owner with, so
        // it is the one field that lets "my space" be resolved without asking
        // a second endpoint for something the map already has.
        myHandleRef.current = res.human?.handle ?? null;
        setSignedIn(true);
        // #59: private plots' owner defaults, for the spaces this viewer is inside only.
        void api<{ plots?: Array<{ plot_index?: number; default_theme?: string }> }>("/api/v1/world/member-default-themes")
          .then((m) => {
            if (cancelled) return;
            memberThemesRef.current = new Map(
              (m.plots ?? []).flatMap((p) => (typeof p.plot_index === "number" && p.default_theme ? [[p.plot_index, p.default_theme] as const] : [])),
            );
          })
          .catch(() => {
            /* no member defaults: private plots show the viewer's own theme */
          });
      })
      .catch(() => {
        if (cancelled) return;
        signedInRef.current = false;
        setSignedIn(false);
        setMeInside(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    /** Which source the last pull drew from, so a switch can drop the old walks. */
    let lastSource: "live" | "replay" = "live";
    const pull = async () => {
      try {
        const replaying = replay.view.active;
        const data: Minimap = replaying
          ? (replay.snapshot(lastLiveRef.current) as unknown as Minimap)
          : await api<Minimap>("/api/v1/world/minimap", {
              headers: { [WATCH_HEADER]: (watchTokenRef.current ??= makeWatchToken()) },
            });
        if (cancelled) return;
        // A live poll that was in flight when replay began must not paint over it.
        if (replay.view.active !== replaying) return;
        if (!replaying) lastLiveRef.current = data as unknown as LiveContext;
        const source = replaying ? "replay" : "live";
        if (source !== lastSource) {
          // Entering or leaving replay is a cut, not a walk: nobody strolls from
          // where they stood at 09:14 to where they stand now.
          lastSource = source;
          actorsRef.current = [];
          departedRef.current.clear();
          motionRef.current = new MotionDirector();
        }
        // Injection flags come from the chronicle, not the minimap, and cost a
        // real query, so they are refreshed every fourth poll rather than every
        // one. The chronicle decides in SQL who may see a moderation row: a
        // signed-out spectator gets an empty page, and the count is then
        // honestly zero rather than withheld.
        if (!replaying && pullNoRef.current % 4 === 0) {
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
        const flaggedIds = replaying ? new Set<string>() : flaggedRef.current;
        const orgList = (data.orgs ?? []).map((o) => ({ id: o.id, name: o.name, colour: o.colour }));
        const orgById = new Map(orgList.map((o) => [o.id, o]));
        const orgMode = data.org_render_mode ?? data.orgRenderMode ?? "shared";
        // #60: who just addressed whom in public. Built server-side from lines the
        // public feed carried (or, in replay, from the same chronicle lines).
        const facingBy = new Map<string, { to: string; until: number }>();
        for (const raw of data.facing ?? []) {
          const h = facingFromWire(raw);
          if (h) facingBy.set(h.from, { to: h.to, until: h.until });
        }
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
            // In replay a body carries a verb only while a historical span covers
            // the playhead, so it is current by construction.
            replaying
              ? Boolean(b.verb)
              : Boolean(pulsedAt) && Date.now() - Date.parse(String(pulsedAt)) < PULSE_FRESH_MS;
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
            slug: b.slug,
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
            addressing: facingBy.get(b.id)?.to ?? null,
            addressingUntil: facingBy.get(b.id)?.until ?? null,
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
            // The server already sends none for a private plot; dropped here too
            // so a stale or hand-made payload still cannot mark a held plot.
            marks: (sp.policy_preset ?? sp.policyPreset) === "private" ? [] : normaliseMarks(sp.marks),
            branding: plotBranding(sp.policy_preset ?? sp.policyPreset, sp.branding),
            estateId: null,
            decor: plotDecor(sp.policy_preset ?? sp.policyPreset, sp.decor),
            // Never trusted for a private plot, whatever the payload says (lib/themes/owner-default).
            defaultTheme: (sp.policy_preset ?? sp.policyPreset) === "private" ? null : (sp.default_theme ?? sp.defaultTheme ?? null),
            supporter: supporterTrim(sp.policy_preset ?? sp.policyPreset ?? "public_write", sp.supporter),
          };
        });
        const estates = readEstates(data.estates, plots);
        for (const e of estates) for (const p of plots) if (e.plotIndices.includes(p.plotIndex)) p.estateId = e.id;
        estateRef.current = estates;
        plotRef.current = plots;
        plotsRef.current = plots.length;
        claimedBlocksRef.current = new Set(plots.map((p) => blockKey(p.rect.x0, p.rect.y0)));
        {
          // Go to ▾ districts: names are the theme's, applied at render.
          const stops = districtStops([], plots);
          const key = districtStopsKey(stops);
          if (key !== districtsKeyRef.current) {
            districtsKeyRef.current = key;
            setDistricts(stops.map(({ name: _n, ...rest }) => rest));
          }
        }
        // Resting at plot is a live-map truth ("nobody runs it now"), so replay
        // shows none. Kept out of `actors` on purpose: see lib/resting.
        restingRef.current = replaying
          ? []
          : restingBodies(data.resting, plots, new Set(grove.map((b) => b.id)));
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
        {
          const book = speechRef.current;
          book.prune(new Set(actors.map((a) => a.id)), SPEECH_MAX_AGE_MS);
          book.seed(
            recent.flatMap((line) => {
              const sid = line.sender_id ?? line.senderId;
              return sid ? [{ actorId: sid, text: line.body }] : [];
            }),
          );
          if (pullNoRef.current <= 1) {
            setHeard(
              recent.slice(-HEARD_KEEP).map((line, i) => ({
                key: line.speech_id ?? line.speechId ?? `seed-${i}`,
                who: line.sender_name ?? line.senderName ?? "someone",
                body: line.body,
              })),
            );
          }
        }
        // New public lines since the last poll, for the TV director. The SSE
        // feed is the Plaza only (and absent on some hosts); the poll is every room.
        if (!replaying) {
          const seen = tvSpeechSeenRef.current;
          const next = new Set<string>();
          for (const line of recent) {
            const sid = line.sender_id ?? line.senderId;
            const key = line.speech_id ?? line.speechId ?? `${sid}|${line.body}`;
            next.add(key);
            if (seen && sid && !seen.has(key)) {
              tvDirectorRef.current?.heard(sid, line.body, Date.now());
              soundscape.heard(sid, Date.now());
            }
          }
          if (seen) for (const key of seen) if (next.size < 200) next.add(key);
          tvSpeechSeenRef.current = next;
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
        // Whether the viewer's own body is standing somewhere: the CTA hides then.
        if (!replaying && myIdRef.current) {
          const mine = myIdRef.current;
          setMeInside(actors.some((a) => a.id === mine));
        }
        // ?at=<tx>,<ty>: centre on that tile, once this poll has said how big
        // the world is, pulled onto the world if it points past the edge
        // (lib/deep-link resolveAt). Skipped when a follow is also asked for,
        // since the follow-cam would take the camera straight back.
        {
          const link = deepLinkRef.current;
          const go = controlsRef.current?.goTo;
          if (link?.at && go && !replaying && !tvRef.current) {
            if (!link.follow) {
              const at = resolveAt(link.at, worldBounds(plots.length));
              go(at.tx, at.ty, BOOKMARK_ZOOM);
            }
            link.at = null;
            if (!link.follow) deepLinkRef.current = null;
          }
        }
        // ?follow=<slug>: hand the body to the follow-cam once it is on the map.
        // A slug the public map does not carry after a few polls is dropped
        // quietly; the link names nothing this viewer may see.
        const link = deepLinkRef.current;
        if (link?.follow && !replaying && !tvRef.current) {
          const body = actors.find((a) => a.slug === link.follow);
          if (body) {
            glideRef.current = null;
            kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
            followRef.current = body.id;
            setFollowing(body.name);
            link.follow = null;
            pendingOwnerLinkRef.current = { bodyId: body.id, since: Date.now() };
          } else if (++link.tries >= 3) link.follow = null;
          if (!link.follow && !link.at) deepLinkRef.current = null;
        }
        // A sequence from the link, now the world has a size (#39).
        if (pendingSeqRef.current && controlsRef.current) {
          const seq = pendingSeqRef.current;
          pendingSeqRef.current = null;
          startCinemaRef.current(seq, false);
        }
        // Replay syncs its own director on historical ticks (lib/replay/motion).
        if (!replaying) motionRef.current?.sync(actors, seatsRef.current, Date.now());
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
          live: !replaying,
          here: grove.length,
          watching: replaying ? null : (data.watching ?? null),
          watchCap: data.audience_cap ?? null,
        });
        setStatus(
          replaying
            ? replay.view.label
            : data.paperclip?.ok
              ? "live map + paperclip"
              : "live map · paperclip quiet",
        );
      } catch {
        if (!cancelled) setStatus("map stream paused");
      }
    };
    pullRef.current = () => void pull();
    void pull();
    // Positions only come from this poll (the SSE carries Plaza pulses and
    // speech, not movement), so it keeps its 8 s while visible; hidden, it stops (#68).
    const stopPoll = startPoll(
      () => {
        if (!replay.view.active) void pull();
      },
      8000,
      { runNow: false },
    );
    const es = new EventSource(gp("/api/v1/sse/plaza"));
    es.addEventListener("pulse", (ev) => {
      if (replay.view.active) return;
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
      if (replay.view.active) return;
      const d = JSON.parse((ev as MessageEvent).data) as { actor_id?: string; tool_call?: Record<string, unknown> };
      const span = d.tool_call ? spanFromWire(d.tool_call) : null;
      if (!d.actor_id || !span) return;
      actorsRef.current = actorsRef.current.map((a) =>
        a.id === d.actor_id ? { ...a, toolCalls: mergeSpan(a.toolCalls, span) } : a,
      );
      motionRef.current?.sync(actorsRef.current, seatsRef.current, Date.now());
    });
    es.addEventListener("speech", (ev) => {
      if (replay.view.active) return;
      const data = JSON.parse((ev as MessageEvent).data) as {
        sender_id?: string;
        sender_name?: string;
        body?: string;
        speech_id?: string;
      };
      if (!data.sender_id || !data.body) return;
      speechRef.current.hear(data.sender_id, data.body);
      {
        const key = data.speech_id ?? `${data.sender_id}|${data.body}`;
        const seen = tvSpeechSeenRef.current;
        if (!seen?.has(key)) tvDirectorRef.current?.heard(data.sender_id, data.body, Date.now());
        seen?.add(key);
      }
      const speaker = actorsRef.current.find((a) => a.id === data.sender_id);
      actorsRef.current = actorsRef.current.map((a) => (a.id === data.sender_id ? { ...a, verb: "say" } : a));
      const who = data.sender_name ?? speaker?.name ?? "someone";
      const body = data.body;
      setHeard((cur) =>
        [...cur, { key: data.speech_id ?? `${data.sender_id}-${Date.now()}`, who, body }].slice(-HEARD_KEEP),
      );
    });
    return () => {
      cancelled = true;
      pullRef.current = () => {};
      stopPoll();
      es.close();
    };
  }, [replay]);

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

    /** Zoomed all the way out, the entire world fits on screen, phone or desktop (lib/camera). */
    const minZoom = () => {
      const { w, h } = origin();
      return zoomRangeTilted(worldBox(), w, h, depthRef.current.k, { nominalMin: NOMINAL_MIN_ZOOM, max: MAX_ZOOM }).min;
    };

    /** The world may be dragged to the edge of the viewport, never past it (lib/camera). */
    const clampPan = () => {
      const v = viewRef.current;
      const { w, h } = origin();
      const next = clampPanTilted(v, worldBox(), w, h, PAN_MARGIN, depthRef.current.k);
      v.px = next.px;
      v.py = next.py;
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
      //
      // Reset glides to the whole world, fitted (#38): as the world grows the
      // old "zoom 1 on the core" left the outer rings off-screen with no hint
      // they were there. `fit` makes the glide re-read the world every frame.
      takeCamera();
      kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
      glideRef.current = { tx: 0, ty: 0, zoom: 1, start: performance.now(), fit: true };
    };

    /** Screen → tile. The exact inverse of how a tile is drawn (Depth view's tilt included, lib/depth). */
    const tileFromClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const { ox, oy, w, h } = origin();
      const l = fromScreen(viewRef.current, w, h, depthRef.current.k, clientX - rect.left, clientY - rect.top);
      const { tx, ty } = unIso(l.x - ox, l.y - oy);
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
      centreLayout: (x, y) => {
        takeCamera();
        kioskYieldRef.current = Date.now() + KIOSK_YIELD_MS;
        const { w, h } = origin();
        const v = viewRef.current;
        const next = centreOn(x, y, v.zoom, w, h);
        v.px = next.px;
        v.py = next.py;
        clampPan();
      },
      centred: () => {
        const { ox, oy, w, h } = origin();
        const v = viewRef.current;
        const points = actorsRef.current.flatMap((a) => {
          const at = lastPosRef.current.get(a.id);
          if (!at) return [];
          const q = iso(at.x, at.y);
          const s = toScreen(v, w, h, depthRef.current.k, ox + q.x, oy + q.y);
          return [{ id: a.id, x: s.x, y: s.y }];
        });
        return nearestToCentre(points, w / 2, h / 2, 72)?.id ?? null;
      },
      cameraKey: () => {
        const { ox, oy, w, h } = origin();
        const v = viewRef.current;
        const { tx, ty } = unIso((w / 2 - v.px) / v.zoom - ox, (h / 2 - v.py) / v.zoom - oy);
        return { tx, ty, zoom: v.zoom };
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
      if (!revealed(tx, ty, radiusRef.current, claimedBlocksRef.current)) return null;
      const body = actorsRef.current.find((a) => standsOn(a, tx, ty));
      if (body) {
        const facts: string[] = [];
        // What it just said, in full. At far zoom the map shows only a pip, and
        // a phone has no hover: the card is where the line can be read.
        const said = speechRef.current.get(body.id);
        if (said) facts.push(`${said.whisper ? "Whispered" : "Just said"}: “${said.text}”`);
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
        if (body.source === "paperclip") facts.push("Runs on Paperclip next door, so it has no Glasshouse body to answer you.");
        return {
          kind: "body",
          title: body.name,
          subtitle: `${body.kind === "human" ? CHROME_WORDS.aHuman : CHROME_WORDS.anAgent} · ${body.detail ?? VERB_LABEL[body.verb]}`,
          identity: identityOf(body.kind),
          region: regionTitle(chosenRef.current, body.region),
          facts,
          org:
            body.orgColour && body.orgName
              ? { id: body.orgId ?? body.orgName, name: body.orgName, colour: body.orgColour }
              : null,
          url: body.url ?? null,
          share: body.slug
            ? { follow: body.slug }
            : (() => {
                const seat = seatsRef.current.get(body.id) ?? seatInRegion(body.id, body.region);
                return { at: { tx: seat.x, ty: seat.y } };
              })(),
          // Paperclip bodies are mirrored onto the map but live next door, so
          // no amount of signing in lets you address one.
          speakable: body.source === "grove",
          room: body.region,
          // A Grove body's card: agents fill theirs from pulses and spans,
          // people write their own. Paperclip bodies have no Grove card.
          card:
            body.source === "grove" && body.slug && (body.kind === "agent" || body.kind === "human")
              ? { subject: body.kind, slug: body.slug }
              : null,
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
          // Access is chrome: Open · Watch only · Private in every theme (DECISIONS #7).
          access: accessLabel(DEFAULT_THEME_OBJ, plot.preset),
          accessBlurb: accessBlurb(DEFAULT_THEME_OBJ, plot.preset),
          ownerHandle: plot.ownerHandle,
          occupancy: plot.occupancy,
          orgs: plot.orgs,
          marks:
            plot.preset === "private"
              ? []
              : plot.marks.map((m) => CHROME_WORDS.marks[m]),
          marksHeading: CHROME_WORDS.marks.heading,
          district: inDistrict(chosenRef.current.lexicon.district.names, plot.plotIndex),
          share: { at: { tx: (plot.rect.x0 + plot.rect.x1) / 2, ty: (plot.rect.y0 + plot.rect.y1) / 2 } },
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
          .map((a) => ({ name: a.name, detail: a.detail ?? VERB_LABEL[a.verb], kind: identityOf(a.kind) })),
        recent: recentRef.current,
        share: { at: { tx, ty } },
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
      // A room opens as a drawer over the running map, for everyone: a body
      // gets the room, a spectator its public face and "Sign in to speak" —
      // never a bounce to a login form. A wall display keeps the card.
      if (target?.kind === "region" && !kioskRef.current) {
        openRoomRef.current(target.region);
        return;
      }
      if (target?.kind === "body") {
        const { tx: bx, ty: by } = tileFromClient(ev.clientX, ev.clientY);
        const tapped = actorsRef.current.find((a) => {
          const seat = seatsRef.current.get(a.id) ?? seatInRegion(a.id, a.region);
          return seat.x === bx && seat.y === by;
        });
        if (tapped) expandRef.current = { id: tapped.id, until: Date.now() + SPEECH_EXPAND_MS };
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
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      // Escape is the way out of whatever the map has put you in, innermost
      // first: release a follow before you leave kiosk mode, so one key does
      // not throw away two states at once.
      // A playing sequence is the innermost thing of all, and owns the keys.
      if (cinemaRef.current) {
        if (ev.key === "Escape") {
          stopCinemaRef.current();
          ev.preventDefault();
        }
        return;
      }
      if (ev.key === "Escape") {
        // In TV the follow is the director's, not the viewer's: Escape leaves TV.
        if (tvRef.current) {
          kioskModeRef.current(false);
          ev.preventDefault();
          return;
        }
        // An open drawer is the innermost thing on the map.
        if (!kioskRef.current && (worldUrlRef.current.room || worldUrlRef.current.history)) {
          closeDrawerRef.current();
          ev.preventDefault();
          return;
        }
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
      else if ((ev.key === "v" || ev.key === "V") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) tvModeRef.current(!tvRef.current);
      // T walks the themes. Works in kiosk mode too, where there is no switcher.
      else if ((ev.key === "t" || ev.key === "T") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) themeKeyRef.current();
      // H opens the History drawer (and closes it again).
      else if ((ev.key === "h" || ev.key === "H") && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !kioskRef.current)
        toggleHistoryRef.current();
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
      const mainCtx = canvas.getContext("2d");
      if (!mainCtx) return;
      /**
       * The context every draw below paints into. It is the map canvas except
       * for one synchronous pass a frame at night, when the depth list is run
       * again into the body mask (#54) — the scene closures read `ctx` when they
       * run, so repointing it for that pass needs no second set of closures.
       */
      let ctx: CanvasRenderingContext2D = mainCtx;

      /* ---- bodies through the night (#54) ---------------------------
       * Two offscreen canvases the size of the map, made once and resized
       * with it: the MASK holds what is visible of every body (bodies drawn,
       * everything in front of them erased by its own silhouette), and the
       * WASH is the hour's tint with the mask cut out of it down to
       * BODY_WASH_CAP. Only used while the wash is past the cap.
       * ---------------------------------------------------------------- */
      const nightLayers: { mask: HTMLCanvasElement; wash: HTMLCanvasElement } | null =
        typeof document === "undefined" ? null : { mask: document.createElement("canvas"), wash: document.createElement("canvas") };

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

      /* ---- Depth view's atmosphere, baked ------------------------------
       * The soft shadow is a radial blob rendered once per theme and stamped
       * stretched; the haze is one gradient per theme and viewport height.
       * ---------------------------------------------------------------- */
      const SHADOW_R = 32;
      const HAZE_SHARE = 0.42;
      const shadowSprites = new Map<string, HTMLCanvasElement>();
      const shadowFor = (theme: Theme): HTMLCanvasElement => {
        let sprite = shadowSprites.get(theme.id);
        if (sprite) return sprite;
        sprite = document.createElement("canvas");
        sprite.width = SHADOW_R * 2;
        sprite.height = SHADOW_R * 2;
        const g = sprite.getContext("2d");
        if (g) {
          const grad = g.createRadialGradient(SHADOW_R, SHADOW_R, 0, SHADOW_R, SHADOW_R, SHADOW_R);
          grad.addColorStop(0, theme.palette.depth.shadow);
          grad.addColorStop(0.55, withAlpha(theme.palette.depth.shadow, 0.3));
          grad.addColorStop(1, withAlpha(theme.palette.depth.shadow, 0));
          g.fillStyle = grad;
          g.fillRect(0, 0, SHADOW_R * 2, SHADOW_R * 2);
        }
        shadowSprites.set(theme.id, sprite);
        return sprite;
      };
      let haze: { key: string; fill: CanvasGradient } | null = null;
      const hazeFor = (theme: Theme, h: number): CanvasGradient => {
        const key = `${theme.id}|${h}`;
        if (haze && haze.key === key) return haze.fill;
        const fill = ctx.createLinearGradient(0, 0, 0, h * HAZE_SHARE);
        fill.addColorStop(0, theme.palette.depth.haze);
        fill.addColorStop(1, withAlpha(theme.palette.depth.haze, 0));
        haze = { key, fill };
        return fill;
      };

      /** Where a body is this frame, in (fractional) tile coords, and what it is doing about its errand. */
      const bodyAt = (id: string, seat: Seat) =>
        replay.view.active
          ? replayMotion.frame(id, seat, replay.view.playhead)
          : motionRef.current!.frame(id, seat, Date.now(), reduceMotion.matches);

      type Label = {
        x: number;
        y: number;
        name: string;
        detail: string;
        nameFill: string;
        detailFill: string;
        alpha: number;
        orgColour: string | null;
        /** Person or agent: the small theme-invariant identity tick after the name (DECISIONS #7). */
        identity: IdentityKind;
        /** Resting at plot: placed after every live caption, so it never hides one. */
        resting?: boolean;
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

        // Depth view (#46, lib/depth): the tilt eases toward the preference and
        // is settled before the camera is clamped, because the tilted world is
        // a different height on screen.
        const depth = depthRef.current;
        const depthDt = depth.lastT ? Math.min(100, Math.max(0, t - depth.lastT)) : 16;
        depth.lastT = t;
        depth.k = easeTilt(depth.k, depth.on ? tiltFor(DEPTH_ANGLE) : 1, depthDt, reduceMotion.matches);
        const k = depth.k;
        const deep = depth.on;

        // Re-clamp every frame: the viewport (and the world) can change size
        // underneath a view that was legal when it was set.
        const v = viewRef.current;
        v.zoom = clamp(v.zoom, minZoom(), MAX_ZOOM);
        clampPan();
        const z = v.zoom;
        // The ground trails a pan by a few px and settles; never under reduced motion.
        const focus = focusOf(v, cssW, cssH);
        depth.lag =
          deep && depth.lastF
            ? stepParallax(depth.lag, { x: (focus.fx - depth.lastF.fx) * z, y: (focus.fy - depth.lastF.fy) * z }, depthDt, reduceMotion.matches)
            : { x: 0, y: 0 };
        depth.lastF = focus;
        /** A layout y placed on the (tilted) ground. Identity when Depth view is off. */
        const T = (y: number) => tiltY(y, focus.fy, k);
        // Everything below is drawn in layout space. Two transforms, both from
        // lib/depth: the GROUND (terrain, fog, plot tints, fences) is drawn raw
        // and tilted by the canvas; the UPRIGHT layer (buildings, bodies, props,
        // signs) is drawn at T()-placed anchors with the plain pan/zoom, so art
        // keeps its height. Flat, the two are the same single transform, and
        // hit-testing (fromScreen) is the exact inverse of the upright layer.
        const ground = groundTransform(v, cssW, cssH, k, depth.lag);
        ctx.setTransform(dpr * ground[0], 0, 0, dpr * ground[3], dpr * ground[4], dpr * ground[5]);
        const upright = () => ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * v.px, dpr * v.py);

        const { ox, oy } = origin();
        const radius = radiusRef.current;

        // Only tiles inside the viewport are candidates: this is what keeps the
        // per-frame cost flat as the world grows and as people zoom out.
        const corners = [
          [0, 0],
          [cssW, 0],
          [0, cssH],
          [cssW, cssH],
        ].map(([sx, sy]) => {
          const l = fromScreen(v, cssW, cssH, k, sx!, sy!);
          return unIso(l.x - ox, l.y - oy);
        });
        const bounds = worldBounds(plotsRef.current);
        const vx0 = Math.max(bounds.x0, Math.floor(Math.min(...corners.map((c) => c.tx))) - 2);
        const vx1 = Math.min(bounds.x1, Math.ceil(Math.max(...corners.map((c) => c.tx))) + 2);
        const vy0 = Math.max(bounds.y0, Math.floor(Math.min(...corners.map((c) => c.ty))) - 2);
        const vy1 = Math.min(bounds.y1, Math.ceil(Math.max(...corners.map((c) => c.ty))) + 2);
        // The horizon widens with the visible area rather than being switched
        // off when zoomed out, so distant land appears instead of a hard edge.
        const horizon = HORIZON + Math.ceil(Math.max(cssW / z / TW, cssH / (z * Math.min(1, k)) / TH));
        const claimed = claimedBlocksRef.current;

        for (let ty = vy0; ty <= vy1; ty++) {
          for (let tx = vx0; tx <= vx1; tx++) {
            // Beyond the horizon there is nothing to see yet; skipping keeps the
            // frame cost flat however large the world gets.
            if (Math.hypot(tx - PLAZA_CENTER.x, ty - PLAZA_CENTER.y) > radius + horizon && !claimed.has(blockKey(tx, ty))) continue;
            const core = isCoreTile(tx, ty);
            const region = regionAt(tx, ty);
            const p = iso(tx, ty);
            const x = ox + p.x;
            const y = oy + p.y;
            const explored = revealed(tx, ty, radius, claimed);
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
        /** `ax`/`ay`: the ground anchor, for Depth view's far-art shrink. */
        type Scene = { s: number; draw: () => void; ax?: number; ay?: number; body?: true };
        const scene: Scene[] = [];
        /** Depth view's soft ground shadows, painted on the ground before the depth list. */
        const shadows: Array<{ x: number; y: number; rx: number; ry: number; dx: number; dy: number; alpha: number }> = [];
        const shadowAt = (tx: number, ty: number, fp: { fw: number; fh: number }, layer: LayerHeight) => {
          // Far out, a prop's shadow is a smudge under a smudge: buildings and bodies keep theirs.
          if (!deep || (layer === "prop" && z < LOD_LABELS)) return;
          const c = iso(tx + fp.fw / 2, ty + fp.fh / 2);
          shadows.push({ x: ox + c.x, y: T(oy + c.y), ...shadowSpec(fp, layer, k, { w: TW, h: TH }) });
        };
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
          layer: LayerHeight | null = null,
        ) => {
          const q = iso(tx, ty);
          const px = ox + q.x;
          const py = T(oy + q.y);
          if (layer) shadowAt(tx, ty, a, layer);
          const foot = deep ? iso(tx + a.fw / 2, ty + a.fh / 2) : null;
          scene.push({
            ax: foot ? ox + foot.x : undefined,
            ay: foot ? T(oy + foot.y) : undefined,
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

        /** Plot signboards, in layout space; laid out and painted after the sky. */
        const signs: Array<{ plot: Plot; x: number; y: number }> = [];
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
              if (!revealed(tx, ty, radius, claimed)) continue;
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
            anchored((px, py) => art.building(ctx, access, px, py), rect.x0 + 2, rect.y0 + 1, BUILDING, 0.96, "building");
            // Decor (#45): world art under the bodies, cut away round any body it would cover.
            for (const d of plot.decor) {
              const at = decorSlotTile(rect, d.slot);
              if (!at || !revealed(at.x, at.y, radius, claimed)) continue;
              anchored(
                (px, py) => paintDecorClear(ctx, () => art.decor(ctx, d.preset, px, py), px, py, bodyBoxes, { zoom: z, px: v.px, py: v.py, dpr }),
                at.x,
                at.y,
                PROP_FOOTPRINT,
                1,
                "prop",
              );
            }
          }

          // Bound orgs colour the FENCE, not the ground: the fill already says
          // who may speak here, so an org takes the edge instead of fighting it.
          // An owner's accent (035) wins the fence; the org keeps a stripe on the sign.
          // A plot in an estate (#37) is fenced with its estate, below.
          const orgColour = plot.estateId ? null : plotEdgeColour(plot);
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
                if (!revealed(tx, ty, radius, claimed)) continue;
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
          // The signboard hangs on the building's front, so it lives and dies
          // with the building. It is only COLLECTED here; it is painted in
          // screen space after the sky, with the other things you read.
          if (!anyExplored || !signboardVisible(z)) continue;
          const front = iso(rect.x0 + 3.5, rect.y0 + 2.5);
          signs.push({ plot, x: ox + front.x, y: T(oy + front.y) + 18 });
        }

        // Estates (#37): one continuous fence round the joined land, and one
        // shared sign on a seam between member plots. Access is untouched:
        // each plot above kept its own tint, building and (smaller) board.
        const estateSigns: Array<{ estate: MapEstate; x: number; y: number }> = [];
        for (const estate of estateRef.current) {
          const rects = estate.plotIndices.map((i) => plotForIndex(i));
          if (rects.every((r) => r.x1 < vx0 || r.x0 > vx1 || r.y1 < vy0 || r.y0 > vy1)) continue;
          const segs: Array<readonly [number, number, number, number]> = [];
          for (const { tx, ty, side } of estatePerimeter(rects)) {
            if (!revealed(tx, ty, radius, claimed)) continue;
            const q = iso(tx, ty);
            const px = ox + q.x;
            const py = oy + q.y;
            if (side === "n") segs.push([px, py, px + TW / 2, py + TH / 2]);
            else if (side === "e") segs.push([px + TW / 2, py + TH / 2, px, py + TH]);
            else if (side === "s") segs.push([px, py + TH, px - TW / 2, py + TH / 2]);
            else segs.push([px - TW / 2, py + TH / 2, px, py]);
          }
          if (!segs.length) continue;
          art.estateFence(ctx, segs, estate.accent, t);
          if (!estateSignVisible(z)) continue;
          const at = estateSignTile(estate.plotIndices, plotForIndex);
          if (!revealed(at.x, at.y, radius, claimed)) continue;
          const q = iso(at.x, at.y);
          estateSigns.push({ estate, x: ox + q.x, y: T(oy + q.y) });
        }
        // The ground is down; everything from here stands on it.
        upright();

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
        /** Each body's reading marks (verb glyph, work bar, outcome, stance), painted in the top pass (#52). */
        const marks: Array<{
          x: number;
          y: number;
          alpha: number;
          /** At an active board table (#42): the fixed checker tile, lit when it is this body's move. */
          playing?: { toMove: boolean } | null;
          verb: Actor["verb"] | null;
          workSpan: BodyFrame["span"];
          mark: BodyFrame["mark"];
          stance: string | null;
        }> = [];
        /** Screen boxes of every body drawn this frame: signs and labels are cut away round them (#52). */
        const bodyBoxes: LayerRect[] = [];
        /** Where the lamps are this frame; lit after the hour's wash goes down. */
        const lamps: Array<{ x: number; y: number; r: number }> = [];
        /** Speech, lifted out of the depth list so the night can never dim it. */
        const speakers: Array<{ id: string; x: number; y: number; text: string; at: number; whisper: boolean }> = [];
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
          anchored((px, py) => art.landmark(ctx, room, px, py), c.tx, c.ty, a, 1, "building");
        }

        // Furniture. Fixed list, computed once from the tile grid, so the same
        // bench is on the same tile in every frame and after every poll.
        if (z >= LOD_DRESSING) {
          for (const p of PROPS) {
            if (!near(p.tx, p.ty, 1, 1)) continue;
            if (!tileExplored(p.tx, p.ty, radius)) continue;
            const key = p.key;
            anchored((px, py) => art.prop(ctx, key, px, py), p.tx, p.ty, PROP_FOOTPRINT, 1, "prop");
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
              lamps.push({ x: ox + q.x, y: T(oy + q.y) - table[i + 2]!, r: table[i + 3]! });
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
            const sy = T(oy + q.y) - 18;
            const flip = f.flip;
            const pose = AMBIENT_POSE[f.pose];
            scene.push({
              s: f.x + f.y - 0.5,
              ax: sx,
              ay: sy + 18,
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
          const feet = T(oy + p.y);
          const y = feet - 18 + bob;
          if (deep) {
            // A body's shadow stays on the ground as it bobs: it shrinks a touch as the body lifts.
            const sh = shadowSpec(PROP_FOOTPRINT, "body", k, { w: TW, h: TH });
            const lift = 1 + Math.min(0, bob) * 0.04;
            shadows.push({ x: ox + p.x + walk, y: feet, rx: sh.rx * lift, ry: sh.ry * lift, dx: sh.dx, dy: sh.dy, alpha: sh.alpha });
          }
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
          bodyBoxes.push(bodyScreenRect(x, y, z, v.px, v.py));
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
              anchored((px, py) => art.scaffold(ctx, stage, px, py), sx, sy, SCAFFOLD, 0.92, "building");
          }
          const workSpan = at.span;
          const mark = at.mark;
          const stance = a.kind === "agent" ? a.stance : null;

          scene.push({
            // Bodies stand on the tile's NORTH vertex while a footprint covers
            // the whole diamond, so a body on tile T is half a tile north of a
            // prop on tile T and must sort just ahead of it.
            s: at.x + at.y - 0.5,
            ax: x,
            ay: feet,
            body: true,
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
              const inTrial = replay.view.active ? undefined : trialRef.current.marks.get(a.id);
              if (inTrial) drawTrialRing(ctx, x, y, inTrial.ticks, inTrial.finished, t, reduceMotion.matches);
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
              const baseKey = spriteKey(a.kind === "paperclip" ? "agent" : a.kind, a.verb);
              // #60: turned toward someone it just addressed in public. A
              // front-facing sprite turns to its side view; the side art faces
              // right, so facing left mirrors it. Nothing else about it changes.
              const face = at.face;
              const key = face !== 0 && baseKey.endsWith("-front") ? (baseKey.replace("-front", "-side") as CharKey) : baseKey;
              if (face < 0) {
                ctx.save();
                ctx.translate(x, 0);
                ctx.scale(-1, 1);
                ctx.translate(-x, 0);
              }
              const drawn = art.body(ctx, key, x, y);
              if (face < 0) ctx.restore();
              if (!drawn) {
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
              const held = Boolean(carried && art.carry(ctx, carried, x + 11, y + 3));
              ctx.restore();
              // The verb glyph and the motion marks are things you READ, so
              // they leave the depth list for the top pass (#52): a building
              // in front, the hour's grade and a signboard never cover them.
              const playing = replay.view.active ? null : playingRef.current.marks.get(a.id) ?? null;
              marks.push({ x, y, alpha, verb: held ? null : a.verb, workSpan, mark, stance: stance ?? null, playing });
            },
          });
          // Speech leaves the depth list. It used to be painted inside the
          // body's own entry, which meant a nearer body could draw over a line
          // someone had just said — and, since this pass, that the hour's wash
          // would have gone down on top of it. It is information, so it is
          // painted after the light, with the nameplates.
          const said = speechRef.current.get(a.id);
          if (said) speakers.push({ id: a.id, x, y, text: said.text, at: said.at, whisper: said.whisper });

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
              identity: identityOf(a.kind),
            });
          }
        }

        /* ---- resting at plot ------------------------------------------
         * Agents nobody runs, lying at their home plot (MOTION.md §3). The
         * `resting` state with `away` set: no bob, no ring, no verb glyph, no
         * carried item — nothing a watcher could read as work. Dimmer than
         * any live body, with the fixed moon mark at readable strength.
         * -------------------------------------------------------------- */
        if (z >= LOD_PLOTS) {
          for (const r of restingRef.current) {
            const { x: tx, y: ty } = r.tile;
            if (!near(tx, ty, 1, 1) || !tileExplored(tx, ty, radius)) continue;
            const q = iso(tx, ty);
            const x = ox + q.x;
            const y = T(oy + q.y) - 18;
            bodyBoxes.push(bodyScreenRect(x, y, z, v.px, v.py));
            if (deep) shadows.push({ x, y: y + 18, ...shadowSpec(PROP_FOOTPRINT, "body", k, { w: TW, h: TH }) });
            scene.push({
              s: tx + ty - 0.5,
              ax: x,
              ay: y + 18,
              body: true,
              draw: () => {
                ctx.save();
                ctx.globalAlpha = AWAY_ALPHA;
                if (!art.body(ctx, "agent-front", x, y)) {
                  ctx.fillStyle = pal.placeholder.agent;
                  ctx.fillRect(x - 6, y - 6, 12, 12);
                }
                ctx.globalAlpha = 0.85;
                drawRestingMark(ctx, x, y);
                ctx.restore();
              },
            });
            if (z >= LOD_LABELS) {
              labels.push({
                x,
                y,
                name: r.name,
                detail: theme.lexicon.resting,
                nameFill: pal.nameFill,
                detailFill: RESTING_MARK_COLOUR,
                alpha: 0.5,
                orgColour: null,
                identity: "agent",
                resting: true,
              });
            }
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
          const gy = T(oy + q.y) - 18 - (reduceMotion.matches ? 0 : 10 * pr);
          const startAlpha = gone.alpha;
          scene.push({
            s: gone.x + gone.y - 0.5,
            body: true,
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
        // Depth view: shadows lie on the ground, under everything that stands.
        // One baked sprite per theme, stamped (THEMES rule 7).
        if (shadows.length) {
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          const sprite = shadowFor(theme);
          for (const sh of shadows) {
            ctx.globalAlpha = sh.alpha;
            ctx.drawImage(sprite, sh.x + sh.dx - sh.rx, sh.y + sh.dy - sh.ry, sh.rx * 2, sh.ry * 2);
          }
          ctx.restore();
        }
        /** One depth-list entry, with Depth view's far-art shrink. Paints into whatever `ctx` is now. */
        const paintItem = (item: Scene) => {
          if (!deep) {
            item.draw();
            return;
          }
          // Far upright art is drawn a touch smaller, about its own ground
          // anchor. Never larger than 1, so the #52 body boxes and decor
          // cut-aways (computed unscaled) still contain it.
          const sc = item.ay === undefined ? 1 : perspectiveScale(item.ay * z + v.py, cssH, 1);
          if (sc > 0.999) {
            item.draw();
            return;
          }
          const ax = item.ax ?? 0;
          const ay = item.ay ?? 0;
          ctx.setTransform(dpr * z * sc, 0, 0, dpr * z * sc, dpr * (ax * z * (1 - sc) + v.px), dpr * (ay * z * (1 - sc) + v.py));
          item.draw();
          upright();
        };
        if (deep) {
          for (const item of scene) paintItem(item);
          // A faint haze toward the far edge: one fill over the top of the view, gradient cached.
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = hazeFor(theme, cssH);
          ctx.fillRect(0, 0, cssW, cssH * HAZE_SHARE);
          upright();
        } else {
          for (const item of scene) item.draw();
        }

        /* ---- the hour -------------------------------------------------
         * The wash goes down over the terrain, the buildings and the bodies —
         * and over nothing else. Everything you READ off this map is painted
         * after it: speech, nameplates, task captions, hazard marks, the
         * heartbeat rings and the hover card. That is what "legibility beats
         * atmosphere" means in practice rather than as a promise, and it is
         * why the deepest hour can be a third of an alpha without any hour
         * making anything unreadable. Bodies are the exception that proves it:
         * they are in the tinted layer, so they take a lighter wash, capped at
         * BODY_WASH_CAP (#54, MOTION.md §10) — the work stays visible at 03:00.
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
            // Bodies take a lighter wash (#54): the mask of what is visible of
            // them is cut out of the tint down to BODY_WASH_CAP, so a body is
            // never dimmed by more than that at any hour.
            const erase = bodyWashErase(hour.washAlpha);
            const firstBody = erase > 0 && bodyBoxes.length && nightLayers ? scene.findIndex((it) => it.body) : -1;
            if (firstBody >= 0 && nightLayers) {
              const { mask, wash } = nightLayers;
              for (const c of [mask, wash]) {
                if (c.width !== el.width || c.height !== el.height) {
                  c.width = el.width;
                  c.height = el.height;
                }
              }
              const m = mask.getContext("2d");
              const w = wash.getContext("2d");
              if (m && w) {
                m.setTransform(1, 0, 0, 1, 0, 0);
                m.globalCompositeOperation = "source-over";
                m.globalAlpha = 1;
                m.clearRect(0, 0, mask.width, mask.height);
                m.save();
                // Only the ground round a body can hold one: clip there so the
                // second run of the list rasterises almost nothing.
                m.setTransform(dpr, 0, 0, dpr, 0, 0);
                m.beginPath();
                for (const r of bodyBoxes) m.rect(r.x0 - 4, r.y0 - 4, r.x1 - r.x0 + 8, r.y1 - r.y0 + 8);
                m.clip();
                m.imageSmoothingEnabled = false;
                ctx = m;
                try {
                  upright();
                  // Nothing earlier in the list than the first body can stand in front of one.
                  for (let i = firstBody; i < scene.length; i++) {
                    const item = scene[i]!;
                    // Bodies paint the mask; anything nearer erases what it covers of them.
                    m.globalCompositeOperation = item.body ? "source-over" : "destination-out";
                    paintItem(item);
                  }
                } finally {
                  ctx = mainCtx;
                }
                m.restore();
                w.setTransform(1, 0, 0, 1, 0, 0);
                w.globalCompositeOperation = "source-over";
                w.globalAlpha = 1;
                w.clearRect(0, 0, wash.width, wash.height);
                w.fillStyle = hour.wash;
                w.fillRect(0, 0, wash.width, wash.height);
                w.globalCompositeOperation = "destination-out";
                w.globalAlpha = erase;
                w.drawImage(mask, 0, 0);
                w.globalCompositeOperation = "source-over";
                w.globalAlpha = 1;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.drawImage(wash, 0, 0);
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              } else {
                ctx.fillStyle = hour.wash;
                ctx.fillRect(0, 0, cssW, cssH);
              }
            } else {
              ctx.fillStyle = hour.wash;
              ctx.fillRect(0, 0, cssW, cssH);
            }
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

        /**
         * Signs and district names are read-things at a fixed screen size, so
         * zoomed out they are bigger than the ground they label. They are cut
         * away round every body (#52): whoever stands in front of a building
         * is never painted over by its board. Even-odd over non-overlapping
         * runs (lib/layering), built once a frame and only when needed.
         */
        let bodyHoles: Path2D | null | undefined;
        const clipOutBodies = () => {
          if (bodyHoles === undefined) {
            if (!bodyBoxes.length) bodyHoles = null;
            else {
              const path = new Path2D();
              path.rect(0, 0, cssW, cssH);
              for (const r of holeRuns(bodyBoxes, Math.max(4, 6 * z), { w: cssW, h: cssH })) path.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
              bodyHoles = path;
            }
          }
          if (bodyHoles) ctx.clip(bodyHoles, "evenodd");
        };

        // District names (#38), zoomed out only: each ring's name hangs just
        // inside its north and south corners, faint, in the theme's words, with
        // the neutral "ring N" the search palette uses underneath. Screen space,
        // so the words stay one size whatever the zoom.
        if (districtLabelsVisible(z)) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          clipOutBodies();
          ctx.textAlign = "center";
          ctx.lineJoin = "round";
          const family = pal.displayFont;
          const names = theme.lexicon.district.names;
          for (const d of worldDistricts(plotsRef.current)) {
            const name = districtName(names, d);
            const sub = ringNumberLabel(d);
            for (const a of ringLabelAnchors(d.ring)) {
              const q = iso(a.tx, a.ty);
              const sx = (ox + q.x) * z + v.px;
              const sy = T(oy + q.y + TH / 2) * z + v.py;
              if (sx < -120 || sx > cssW + 120 || sy < -30 || sy > cssH + 30) continue;
              ctx.globalAlpha = revealed(Math.floor(a.tx), Math.floor(a.ty), radius, claimed) ? 0.62 : 0.4;
              ctx.font = `600 12px ${family}`;
              ctx.strokeStyle = "rgba(0,0,0,0.55)";
              ctx.lineWidth = 3;
              ctx.strokeText(name, sx, sy);
              ctx.fillStyle = pal.plotName;
              ctx.fillText(name, sx, sy);
              ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
              ctx.globalAlpha *= 0.7;
              ctx.strokeText(sub, sx, sy + 12);
              ctx.fillText(sub, sx, sy + 12);
            }
          }
          ctx.restore();
        }

        // Plot signboards: fixed screen size so a name reads at every zoom
        // above the threshold, back-to-front so the nearer board wins. A
        // private plot's board says "held" and never its name (lib/signboard).
        if (signs.length) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          clipOutBodies();
          const signFamily = art.speechFont ?? "ui-sans-serif, system-ui, sans-serif";
          const measure = (text: string, px: number) => {
            ctx.font = `${px >= 11 ? "600 " : ""}${px}px ${signFamily}`;
            return ctx.measureText(text).width;
          };
          signs.sort((p, q) => p.y - q.y);
          for (const sg of signs) {
            const board = layoutSignboard(
              signContent(sg.plot, theme.lexicon),
              { x: sg.x * z + v.px, y: sg.y * z + v.py },
              z,
              measure,
              { compact: Boolean(sg.plot.estateId) },
            );
            if (board && board.x1 > 0 && board.x0 < cssW && board.y1 > 0 && board.y0 < cssH) art.signboard(ctx, board, t);
          }
          ctx.restore();
        }
        // The estate's one shared sign, over its members' boards (#37).
        if (estateSigns.length) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          clipOutBodies();
          const signFamily = art.speechFont ?? "ui-sans-serif, system-ui, sans-serif";
          const measure = (text: string, px: number) => {
            ctx.font = `${px >= 11 ? "600 " : ""}${px}px ${signFamily}`;
            return ctx.measureText(text).width;
          };
          for (const es of estateSigns) {
            const board = layoutEstateSign(
              estateSignContent({ name: es.estate.name, accent: es.estate.accent, plots: es.estate.plotIndices.length }, theme.lexicon),
              { x: es.x * z + v.px, y: es.y * z + v.py },
              z,
              measure,
            );
            if (board && board.x1 > 0 && board.x0 < cssW && board.y1 > 0 && board.y0 < cssH) art.estateSign(ctx, board, t);
          }
          ctx.restore();
        }

        // The reading marks, over every sign and the hour, back to front (#52).
        if (marks.length) {
          const markNow = replay.view.active ? replayMotion.now : Date.now();
          marks.sort((p, q) => p.y - q.y);
          for (const m of marks) {
            ctx.save();
            ctx.globalAlpha = m.alpha;
            if (m.verb) art.glyph(ctx, m.verb, m.x, m.y, t);
            // Motion marks (lib/motion/marks.ts): fixed semantics, not theme art.
            if (m.workSpan && z >= LOD_DRESSING) drawWorkBar(ctx, m.workSpan, m.x, m.y, t, reduceMotion.matches);
            if (m.mark) drawOutcomeMark(ctx, m.mark.outcome, m.x, m.y, (markNow - m.mark.at) / OUTCOME_MARK_MS, reduceMotion.matches);
            if (m.stance && z >= LOD_LABELS) drawStanceMark(ctx, m.stance, m.x, m.y);
            if (m.playing && z >= LOD_LABELS) drawPlayingMark(ctx, m.x, m.y, m.playing.toMove);
            ctx.restore();
          }
        }

        // Captions last, front-most first, skipping any that would collide:
        // a smeared pile of half-readable task titles is worse than a gap.
        const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
        for (const l of [...labels].sort((p, q) => Number(Boolean(p.resting)) - Number(Boolean(q.resting)) || q.y - p.y)) {
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
          // whether this body is Grove's or Paperclip's. The identity tick
          // (person dot / agent diamond, DECISIONS #7) follows it, so the pair
          // stays centred on the body.
          const lead = l.orgColour ? 8 : 0;
          const nameText = fitText(ctx, l.name, CAPTION_W - lead - IDENTITY_TICK_W);
          const nameW = ctx.measureText(nameText).width;
          const nameX = l.x + (lead - IDENTITY_TICK_W) / 2;
          ctx.fillText(nameText, nameX, l.y + 28);
          if (l.orgColour) {
            ctx.fillStyle = l.orgColour;
            ctx.beginPath();
            ctx.arc(nameX - nameW / 2 - 4, l.y + 24.5, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
          drawIdentityTick(ctx, nameX + nameW / 2 + IDENTITY_TICK_W / 2 + 0.5, l.y + 24.5, l.identity);
          ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = l.detailFill;
          ctx.fillText(fitText(ctx, l.detail, CAPTION_W), l.x, l.y + 40);
          ctx.restore();
        }

        // Screen-space overlay: never pans or zooms.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Speech, above the light and the nameplates, laid out in screen space
        // so it is the same readable size at every zoom (lib/speech-render).
        // Hazard marks, heartbeat rings and nameplates are obstacles it moves
        // around, and the hazards are painted after it: speech never outranks
        // a fault. Far out, a line is a pip; hover or tap to read it.
        {
          const toScreen = (lx: number, ly: number) => ({ x: lx * z + v.px, y: ly * z + v.py });
          const obstacles: Rect[] = [];
          for (const h of hazards) {
            const p = toScreen(h.x, h.y);
            obstacles.push(markRect(p.x, p.y - 22 - 5, 12));
          }
          for (const m of meters) {
            const p = toScreen(m.x, m.y);
            obstacles.push(markRect(p.x + 16, p.y - 24, 10));
          }
          for (const r of placed) {
            const a0 = toScreen(r.x0, r.y0);
            const a1 = toScreen(r.x1, r.y1);
            obstacles.push({ x0: a0.x, y0: a0.y, x1: a1.x, y1: a1.y });
          }
          // The HUD, the headline and the controls are HTML over the canvas; a
          // bubble under them would be painted and then hidden. Read their boxes
          // a few times a second rather than every frame.
          const overlay = overlayRectsRef.current;
          if (nowMs - overlay.at > 400) {
            const cr = el.getBoundingClientRect();
            const host = el.parentElement;
            overlay.at = nowMs;
            coverRectsRef.current = host
              ? Array.from(host.querySelectorAll("[data-map-drawer]"))
                  .map((node) => node.getBoundingClientRect())
                  .filter((b) => b.width > 0 && b.height > 0)
                  .map((b) => ({ x0: b.left - cr.left, y0: b.top - cr.top, x1: b.right - cr.left, y1: b.bottom - cr.top }))
              : [];
            overlay.rects = host
              ? Array.from(host.querySelectorAll("h1, p, button, a, select, [data-speech-avoid]"))
                  .map((node) => node.getBoundingClientRect())
                  .filter((b) => b.width > 0 && b.height > 0)
                  .map((b) => ({ x0: b.left - cr.left, y0: b.top - cr.top, x1: b.right - cr.left, y1: b.bottom - cr.top }))
              : [];
          }
          obstacles.push(...overlay.rects);
          const exp = expandRef.current;
          if (exp && exp.until < nowMs) expandRef.current = null;
          const expandId = hoverRef.current?.id ?? expandRef.current?.id ?? null;
          const list: Speaker[] = speakers.map((sp) => {
            const head = toScreen(sp.x, sp.y - 20);
            return {
              id: sp.id,
              ax: head.x,
              ay: head.y,
              text: sp.text,
              at: sp.at,
              whisper: sp.whisper,
              expanded: sp.id === expandId,
            };
          });
          paintSpeech(ctx, speechPaintRef.current, theme, {
            speakers: list,
            viewport: { w: cssW, h: cssH },
            obstacles,
            zoom: z,
            t,
          });
        }
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
            { x: ox + bank.x, y: T(oy + bank.y) },
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
        /* ---- a cinematic sequence (#39) ----------------------------------
         * Owns the camera while it plays: no follow, no glide, no director.
         * The framing is pure (lib/sequence cameraAt), pulled onto the world
         * and into the zoom range, and set outright — the easing is in the
         * shot, not in a chase. A follow target is looked up in the bodies on
         * this map (the public minimap, or the replay's snapshot of it); one
         * that is not there holds the camera where it was.
         * ---------------------------------------------------------------- */
        const run = cinemaRef.current;
        if (run) {
          followRef.current = null;
          glideRef.current = null;
          const dt = run.lastT === null ? 0 : Math.min(250, Math.max(0, t - run.lastT));
          run.lastT = t;
          const rv = replay.view;
          const advancing = !rv.active || (!rv.loading && (rv.playing || rv.playhead >= rv.until));
          if (!run.done && advancing) run.elapsed += dt;
          const frame = cameraAt(
            run.tl,
            run.elapsed,
            (slug) => {
              const body = actors.find((a) => a.slug === slug);
              if (!body) return null;
              const seat = seatsRef.current.get(body.id) ?? seatInRegion(body.id, body.region);
              const at = bodyAt(body.id, seat);
              return { tx: at.x, ty: at.y };
            },
            run.last,
          );
          const cam = clampCamera(frame.camera, worldBounds(plotsRef.current), { min: minZoom(), max: MAX_ZOOM });
          run.last = cam;
          const q = iso(cam.tx, cam.ty);
          v.zoom = cam.zoom;
          v.px = cssW / 2 - (ox + q.x) * v.zoom;
          v.py = cssH / 2 - (oy + q.y) * v.zoom;
          clampPan();
          if ((frame.done && !run.done) || frame.lostFollow !== run.holding) {
            run.done = run.done || frame.done;
            run.holding = frame.lostFollow;
            const done = run.done;
            const holding = run.holding;
            setCinema((c) => (c ? { ...c, done, holding } : c));
          }
          if (t - run.shownAt >= 250 || run.done) {
            run.shownAt = t;
            setCinemaElapsed(Math.min(run.elapsed, run.tl.total));
          }
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
            const followEase = reduceMotion.matches ? 1 : 0.12;
            // TV follows in close-up; a viewer's own follow keeps their zoom.
            if (tvRef.current && tvAppliedRef.current) {
              v.zoom = clamp(v.zoom + (TV_ZOOM - v.zoom) * followEase * 0.5, minZoom(), MAX_ZOOM);
            }
            // The middle of what an open drawer leaves visible (#52).
            const c = clearCentre({ w: cssW, h: cssH }, coverRectsRef.current);
            const wantX = c.x - (ox + q.x) * v.zoom;
            const wantY = aimScreenY(c.y, cssH, k) - (oy + q.y) * v.zoom;
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
        /* ---- Grove TV: the director ------------------------------------
         * Sampled twice a second; the director itself holds each shot for
         * ten seconds or more (lib/tv/director). It keeps watching while a
         * person has the map, and only stops pointing the camera: when they
         * let go, the current shot is re-applied rather than a fresh cut.
         * Under reduced motion it still directs — TV was asked for by name —
         * but every cut is instant and the holds are twice as long.
         * ---------------------------------------------------------------- */
        if (tvRef.current && tvDirectorRef.current && !replay.view.active && nowMs - tvLastStepRef.current >= TV_STEP_MS) {
          tvLastStepRef.current = nowMs;
          const director = tvDirectorRef.current;
          const tvActors: TvActor[] = actors.map((a) => ({
            id: a.id,
            name: a.name,
            kind: a.kind,
            region: a.region,
            verb: a.verb,
            // The verb's own label is not a detail; only a reported one is.
            detail: a.detail && a.detail !== VERB_LABEL[a.verb] ? a.detail : undefined,
            hazard: hazardOf(a),
            errorText: a.errorText ?? null,
            fading: a.fading,
            toolCalls: a.toolCalls,
            addressing: a.addressing && (a.addressingUntil ?? 0) > nowMs ? a.addressing : null,
          }));
          director.observe(tvActors, nowMs);
          const shot = director.step({
            now: nowMs,
            actors: tvActors,
            stage: tvStageRef.current,
            words: { regionTitle: (r) => regionTitle(chosenRef.current, r), inTrial: chosenRef.current.lexicon.inTrial, atTable: chosenRef.current.lexicon.atTable },
            holdScale: reduceMotion.matches ? 2 : 1,
            trial: trialRef.current.tv,
            games: playingRef.current.games(nowMs),
          });
          const paused = nowMs <= kioskYieldRef.current;
          if (paused) {
            tvAppliedRef.current = null;
          } else if (shot.key !== tvAppliedRef.current) {
            tvAppliedRef.current = shot.key;
            if (shot.actorId) {
              glideRef.current = null;
              followRef.current = shot.actorId;
            } else {
              followRef.current = null;
              const rect = shot.region ? REGION_RECTS[shot.region as RoomRegion] : undefined;
              glideRef.current = rect
                ? { tx: (rect.x0 + rect.x1) / 2, ty: (rect.y0 + rect.y1) / 2, zoom: BOOKMARK_ZOOM, start: t }
                : { tx: PLAZA_CENTER.x, ty: PLAZA_CENTER.y, zoom: KIOSK_WIDE_ZOOM, start: t, fit: true };
            }
          }
          const captionKey = `${shot.kind}|${shot.caption}|${paused}`;
          if (captionKey !== tvCaptionKeyRef.current) {
            tvCaptionKeyRef.current = captionKey;
            setTvCaption({ kind: shot.kind, caption: shot.caption, paused });
          }
        }

        // Ambient sound samples the same bodies; it rate-limits itself and is a no-op while off.
        if (soundscape.active && !replay.view.active) {
          soundscape.sample(actors.map((a) => ({ id: a.id, hazard: hazardOf(a), toolCalls: a.toolCalls })), nowMs);
        }

        if (kioskRef.current && !tvRef.current && !reduceMotion.matches && nowMs > kioskYieldRef.current) {
          const stop = Math.floor(nowMs / KIOSK_STOP_MS) % KIOSK_STOPS.length;
          if (stop !== tourStopRef.current) {
            tourStopRef.current = stop;
            const s = KIOSK_STOPS[stop]!;
            // The wide shot is the whole world, fitted, however far it has grown.
            glideRef.current = { tx: s.tx, ty: s.ty, zoom: s.zoom, start: t, fit: s.zoom === KIOSK_WIDE_ZOOM };
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
          // A fitted glide (Reset view, the wide shot) aims at the world as it
          // is this frame; any other target is pulled onto the world first, so
          // a stale link or bookmark cannot aim the camera past the edge.
          const wb = worldBounds(plotsRef.current);
          if (glide.fit) {
            const c = worldCentre(wb);
            glide.tx = c.tx;
            glide.ty = c.ty;
            glide.zoom = clamp(fitZoomTilted(worldBox(), cssW, cssH, depthRef.current.k), minZoom(), MAX_ZOOM);
          } else {
            const at = clampTile(glide, wb);
            glide.tx = at.tx;
            glide.ty = at.ty;
          }
          const q = iso(glide.tx, glide.ty);
          const k = reduceMotion.matches ? 1 : 0.1;
          v.zoom = clamp(v.zoom + (glide.zoom - v.zoom) * k, minZoom(), MAX_ZOOM);
          const gc = glide.fit ? { x: cssW / 2, y: cssH / 2 } : clearCentre({ w: cssW, h: cssH }, coverRectsRef.current);
          const wantX = gc.x - (ox + q.x) * v.zoom;
          const wantY = aimScreenY(gc.y, cssH, k) - (oy + q.y) * v.zoom;
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
          const boxW = Math.min(460, cssW - 24);
          // Never over the body it describes (#52): another corner when it would be.
          const drawn = lastPosRef.current.get(hover.id);
          const hq = drawn ? iso(drawn.x, drawn.y) : null;
          const spot = hoverCardSpot(hq ? bodyScreenRect(ox + hq.x, T(oy + hq.y) - 18, z, v.px, v.py) : null, { w: boxW, h: boxH }, { w: cssW, h: cssH });
          ctx.fillStyle = pal.card.bg;
          ctx.fillRect(spot.x, spot.y, boxW, boxH);
          ctx.textAlign = "left";
          ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
          lines.forEach((ln, i) => {
            ctx.fillStyle = i === 0 ? pal.card.title : hover.stalled && i === 1 ? STALL_RING : pal.card.text;
            ctx.fillText(ln, spot.x + 8, spot.y + 18 + i * 16);
          });
        }
        // The minimap (#38), throttled: an overview a few times a second.
        if (nowMs - insetDrawnRef.current >= INSET_REDRAW_MS) {
          insetDrawnRef.current = nowMs;
          drawInset(theme);
        }
        raf = requestAnimationFrame(draw);
      };

      /**
       * The minimap inset: the whole world, the core, every claimed plot
       * (a private one only as held land, in its access tint, exactly as the
       * main map shows it — the same public minimap payload, nothing more),
       * estate outlines and the rectangle the camera is looking at.
       */
      const drawInset = (theme: Theme) => {
        const el = insetRef.current;
        if (!el) {
          insetXformRef.current = null;
          return;
        }
        const g = el.getContext("2d");
        if (!g) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = INSET_W;
        const h = INSET_H;
        if (el.width !== Math.floor(w * dpr) || el.height !== Math.floor(h * dpr)) {
          el.width = Math.floor(w * dpr);
          el.height = Math.floor(h * dpr);
        }
        const pal = theme.palette;
        const { ox, oy, w: cw, h: ch } = origin();
        const box = worldBox();
        const xf = insetTransform(box, w, h, 6);
        insetXformRef.current = xf;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        /** A tile rect's diamond on the inset. */
        const diamond = (r: { x0: number; y0: number; x1: number; y1: number }) => {
          const pts = [iso(r.x0, r.y0), iso(r.x1 + 1, r.y0), iso(r.x1 + 1, r.y1 + 1), iso(r.x0, r.y1 + 1)].map((p) =>
            xf.toInset(ox + p.x, oy + p.y),
          );
          g.beginPath();
          g.moveTo(pts[0]!.x, pts[0]!.y);
          for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
          g.closePath();
        };
        diamond(worldBounds(plotsRef.current));
        g.fillStyle = `rgb(${pal.chrome.dusk800} / 0.95)`;
        g.fill();
        g.strokeStyle = `rgb(${pal.chrome.lantern400} / 0.25)`;
        g.lineWidth = 1;
        g.stroke();
        diamond({ x0: 0, y0: 0, x1: MAP_COLS - 1, y1: MAP_ROWS - 1 });
        g.fillStyle = `rgb(${pal.chrome.lantern500} / 0.45)`;
        g.fill();
        for (const plot of plotRef.current) {
          const access = plot.preset === "private" || plot.preset === "public_view" ? plot.preset : "public_write";
          diamond(plot.rect);
          g.fillStyle = withAlpha(pal.plotTint[access as AccessLevel] ?? pal.plotTint.public_write, 0.9);
          g.fill();
        }
        g.lineWidth = 1.25;
        for (const estate of estateRef.current) {
          g.strokeStyle = estate.accent ?? `rgb(${pal.chrome.lantern300})`;
          for (const i of estate.plotIndices) {
            diamond(plotForIndex(i));
            g.stroke();
          }
        }
        const vb = viewportBoxTilted(viewRef.current, cw, ch, depthRef.current.k);
        const a = xf.toInset(vb.minX, vb.minY);
        const b = xf.toInset(vb.maxX, vb.maxY);
        const x0 = Math.max(1, a.x);
        const y0 = Math.max(1, a.y);
        const x1 = Math.min(w - 1, b.x);
        const y1 = Math.min(h - 1, b.y);
        if (x1 > x0 && y1 > y0) {
          g.strokeStyle = `rgb(${pal.chrome.lantern300})`;
          g.lineWidth = 1.5;
          g.strokeRect(x0, y0, x1 - x0, y1 - y0);
        }
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
  }, []);

  const drawerOpen = Boolean(worldUrl.room || worldUrl.history);
  const cta = mapCta({ signedIn, inside: meInside === true, roomOpen: Boolean(worldUrl.room) });
  // Once after sign-in: the walk-in sheet opens by itself on a bare map.
  useEffect(() => {
    const store = browserStore();
    if (
      autoWalkIn({
        signedIn,
        inside: meInside !== false,
        seen: readFlag(store, WALK_IN_SEEN_KEY),
        drawerOpen,
        kiosk,
      })
    ) {
      writeFlag(store, WALK_IN_SEEN_KEY);
      setWalkIn(true);
    }
  }, [signedIn, meInside, drawerOpen, kiosk]);
  const roomRegion = worldUrl.room && worldUrl.room in lex.regions ? (worldUrl.room as RoomRegion) : null;
  const publicView: RoomPublicView | null = roomRegion
    ? {
        here: actorsRef.current
          .filter((a) => a.region === roomRegion)
          .map((a) => ({ name: a.name, detail: a.detail ?? VERB_LABEL[a.verb], kind: identityOf(a.kind) })),
        recent: recentRef.current,
      }
    : null;
  const regionsLex = lex.regions;
  const roomTitleFor = useCallback(
    (slug: string) => (slug in regionsLex ? regionsLex[slug as RoomRegion].title : null),
    [regionsLex],
  );
  const drawerWidth = worldUrl.history ? "420px" : roomExpanded ? "min(880px, calc(100% - 2rem))" : "420px";
  /** Kiosk, TV and a playing sequence all take the chrome away. */
  const bare = kiosk || Boolean(cinema);

  return (
    <section
      data-grove-theme={theme.id}
      data-map-chrome
      // Brand chrome over theme world (DECISIONS #7): the section is a
      // .gh-chrome surface (ink, type, focus ring), and only its ground — what
      // shows before the canvas paints — is the theme's world colour.
      style={{ background: `rgb(${theme.palette.chrome.dusk950})` }}
      className={`gh-chrome relative overflow-hidden ${
        bare ? "min-h-[100svh]" : "min-h-[calc(100svh-56px)]"
      }`}
    >
      {kiosk && !cinema ? <TapForSound sound={sound} /> : null}
      <KioskChrome
        active={kiosk}
        onLeave={() => setKioskMode(false)}
        label={tv ? `Leave ${words.controls.tv}` : "Leave kiosk"}
      />
      {/* Grove TV's caption: what the body on screen is doing, in one line.
          Top-centre, where kiosk mode has already cleared the heading away, so
          it never lands on the bell or the way out at the bottom. */}
      {tv && tvCaption ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-4 sm:pt-6">
          <div
            role="status"
            aria-live="polite"
            className={`flex max-w-3xl items-start gap-3 rounded-gh-xl border gh-frost px-4 py-2.5 text-gh-sm shadow-gh-2 transition-opacity duration-500 sm:text-gh-lg ${
              tvCaption.kind === "hazard" ? "border-danger-ink/60 text-danger-ink" : "border-line-strong text-ink"
            } ${tvCaption.paused ? "opacity-50" : "opacity-100"}`}
          >
            <span className="mt-0.5 shrink-0 rounded-gh-pill border border-line-strong px-2 py-0.5 gh-label text-ink">
              {tvCaption.kind === "hazard" ? <span aria-hidden className="mr-1 text-danger-ink">▲</span> : null}
              {tvCaption.paused ? "paused" : words.controls.onAir}
            </span>
            <span className="min-w-0 break-words">{tvCaption.caption}</span>
          </div>
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ imageRendering: "pixelated", touchAction: "none" }}
        role="img"
        aria-label="Glasshouse world map"
        aria-describedby="grove-map-desc"
      />
      <p id="grove-map-desc" className="sr-only">
        A live picture of the world: people and agents, the rooms they are in and what agents are doing. Everything said on the
        map is also read out below as text. Use Go to for rooms, the attention bell for bodies that want a human, and Watch for
        History. Keys: 1 to 6 go to a room, plus and minus zoom, full stop goes to the next body that wants attention, slash
        searches, Escape closes.
      </p>
      {/* Replay frames the whole map in the sky pane, so even a screenshot says it
          (amber is a person now, DECISIONS #7). */}
      {replaying ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 border-4 border-pane/70" />
      ) : null}
      <ReplayBadge controller={replay} />
      {/* Everything said on the map, as text. Visually hidden: the canvas
          shows it as bubbles, and this is the carrier for everyone the canvas
          cannot reach. Polite, so a busy Plaza does not talk over the reader. */}
      <div className="sr-only" role="log" aria-live="polite" aria-label="Heard on the map">
        <ol>
          {heard.map((h) => (
            <li key={h.key}>
              {h.who}: {h.body}
            </li>
          ))}
        </ol>
      </div>
      {/* The one-line HUD: how many bodies, how many watching, the campus hour.
          Everything the old panel said besides is behind ⋯ Legend. Gone in
          kiosk mode, which keeps its own corner line below. */}
      <h1 className="sr-only">{lex.headline}</h1>
      <div
        className={`pointer-events-none absolute left-0 top-0 z-10 flex max-w-full flex-col items-start gap-2 p-3 sm:p-5 ${
          bare ? "hidden sm:hidden" : "flex"
        }`}
      >
        <div
          data-speech-avoid
          data-headcount={hud.live ? "" : undefined}
          className="pointer-events-auto flex max-w-full items-center gap-2 truncate rounded-gh-pill border border-line gh-frost px-3 py-1.5 font-brand-mono text-[11px] tabular-nums text-ink shadow-gh-2 sm:text-xs"
          title="Bodies on the map right now, how many open maps have checked in over the last minute (counted, never named), and the world clock in UTC."
        >
          {hud.live ? (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-signal" />
          ) : null}
          <span className="truncate">
            {hud.live ? formatHeadcount({ here: hud.here, watching: hud.watching, cap: hud.watchCap }, words.hud) : status}
            {sky ? (
              <>
                {" · "}
                {sky.clock} <span className="text-muted">{sky.label}</span>
              </>
            ) : null}
          </span>
        </div>
        {firstVisit && !drawerOpen ? <FirstVisitCard onDismiss={dismissFirstVisit} howHref="/how-it-works" /> : null}
      </div>
      {/* The minimap (#38): top right, clear of the HUD pill (top left) and the
          controls (bottom). Never in kiosk or TV; out of the way of an open
          drawer — beside it on a wide screen, gone under it on a phone. */}
      {!bare ? (
        <div
          className={`pointer-events-none absolute right-0 top-0 z-10 p-3 sm:p-5 ${drawerOpen ? "max-sm:hidden sm:right-[var(--drawer-w)]" : ""}`}
          style={{ "--drawer-w": drawerWidth } as React.CSSProperties}
        >
          {insetCollapsed ? (
            <button
              type="button"
              onClick={toggleInset}
              aria-expanded={false}
              title="Show the minimap: the whole world and where you are looking"
              className={`${CONTROL} w-11 justify-center px-0 sm:w-9`}
            >
              <span aria-hidden>▦</span>
              <span className="sr-only">Show minimap</span>
            </button>
          ) : (
            <div
              data-speech-avoid
              className="pointer-events-auto relative overflow-hidden rounded-gh-lg border border-line gh-frost p-1 shadow-gh-2"
            >
              <canvas
                ref={insetRef}
                width={INSET_W}
                height={INSET_H}
                style={{ width: INSET_W, height: INSET_H, touchAction: "none" }}
                className="block cursor-crosshair"
                role="img"
                aria-label="Minimap of the whole world. Press or drag to move the camera; with a keyboard, use Go to or the zoom keys."
                onPointerDown={(ev) => {
                  ev.currentTarget.setPointerCapture?.(ev.pointerId);
                  insetDragRef.current = true;
                  insetMove(ev);
                }}
                onPointerMove={(ev) => {
                  if (insetDragRef.current) insetMove(ev);
                }}
                onPointerUp={() => {
                  insetDragRef.current = false;
                }}
                onPointerCancel={() => {
                  insetDragRef.current = false;
                }}
              />
              <button
                type="button"
                onClick={toggleInset}
                aria-expanded
                aria-label="Hide minimap"
                title="Hide the minimap"
                className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-gh-pill gh-frost text-sm text-ink hover:bg-tint"
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          )}
        </div>
      ) : null}
      {peek && !cinema ? (
        <SpectatorPeek
          peek={peek}
          signedIn={signedIn}
          lex={words.card}
          onClose={() => setPeek(null)}
          onOpenRoom={(slug) => openRoom(slug)}
        />
      ) : null}
      {!bare && worldUrl.room ? (
        <RoomDrawer
          key="room-drawer"
          room={worldUrl.room}
          signedIn={signedIn}
          arrived={worldUrl.arrived}
          themedTitle={roomRegion ? lex.regions[roomRegion].title : null}
          titleFor={roomTitleFor}
          publicView={publicView}
          signInHref={loginHref({
            next: roomHref(worldUrl.room),
            why: "enter-room",
            what: roomRegion ? lex.regions[roomRegion].title : "",
          })}
          onClose={closeDrawer}
          onOpenRoom={(slug) => openRoom(slug)}
          onExpandedChange={setRoomExpanded}
        />
      ) : null}
      {!bare && worldUrl.history ? <HistoryDrawer controller={replay} onClose={closeDrawer} /> : null}
      {walkIn && !bare ? (
        <WalkInSheet
          placeName={lex.regions.plaza.title}
          onClose={() => setWalkIn(false)}
          onArrived={(a) => {
            setWalkIn(false);
            setMeInside(true);
            setArrival(a);
            openRoom(a.slug, { arrived: true });
          }}
        />
      ) : null}
      {arrival ? <ArrivalToast title={arrival.title} line={arrival.line} onDismiss={() => setArrival(null)} /> : null}
      {panel && !bare ? (
        <MapPanel title={panel === "keys" ? "Keyboard" : "Legend"} onClose={() => setPanel(null)}>
          {panel === "keys" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {MAP_KEYS.map((k) => (
                <div key={k.keys} className="contents">
                  <dt className="text-right font-brand-mono text-ink">{k.keys}</dt>
                  <dd className="text-muted">{k.what}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div className="space-y-2 text-xs text-muted">
              <p className="flex flex-wrap gap-x-3 gap-y-1">
                {words.legend.map((word) => (
                  <span key={word}>{word}</span>
                ))}
              </p>
              {hud.orgs.length ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
                  {hud.orgs.map((o) => (
                    <span key={o.id} className="inline-flex items-center gap-1">
                      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: o.colour }} />
                      {o.name}
                    </span>
                  ))}
                  <span className="text-muted">
                    {hud.orgMode === "dedicated" ? "· everyone here flies it" : "· by membership"}
                  </span>
                </p>
              ) : null}
              <p className="border-t border-line pt-2 tabular-nums">
                {hud.awake} {words.hud.awake} · {hud.asleep} {words.hud.asleep} · {words.hud.fog} {hud.radius}
                {hud.world ? ` · ${words.hud.world} ${hud.world}` : ""}
                {hud.spaces ? ` · ${hud.spaces} ${words.hud.claimed}` : ""}
              </p>
              <p className="text-muted">{status}</p>
              <p className="break-words text-muted">{hud.lastHeard || words.hud.quiet}</p>
            </div>
          )}
        </MapPanel>
      ) : null}
      {/* Bottom overlay: one row of consolidated controls (Go to ▾, the bell,
          Watch ▾, ⋯, zoom on a pointer that has no pinch) and ONE call to
          action that knows where you are. It moves out from under an open
          drawer on a wide screen, so the drawer never covers the way out. */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-end gap-2 p-3 sm:p-5 ${
          kiosk ? "pb-16 sm:pb-20" : ""
        } ${drawerOpen && !kiosk ? "sm:pr-[calc(var(--drawer-w)+1.25rem)]" : ""} ${
          drawerOpen && !kiosk ? "max-sm:hidden" : ""
        } ${cinema ? "hidden" : ""}`}
        style={{ "--drawer-w": drawerWidth } as React.CSSProperties}
      >
        {kiosk ? <AttentionBell counts={hud.attn} position={attnPos} onCycle={cycleAttention} words={words.bell} /> : null}
        <ReplayBar controller={replay} />
        {following && !tv ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-gh-pill border border-line gh-frost py-1.5 pl-4 pr-1.5 text-gh-xs text-ink shadow-gh-2">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-signal" />
            <span className="truncate">
              {words.controls.following} {following}
            </span>
            <button
              type="button"
              onClick={stopFollowing}
              className="shrink-0 rounded-gh-pill border border-line-strong bg-surface-raised px-4 py-2.5 text-ink hover:bg-tint sm:px-3 sm:py-1"
            >
              {words.controls.release}
            </button>
          </div>
        ) : null}
        <div className={`w-full flex-wrap items-center justify-between gap-2 ${kiosk ? "hidden" : "flex"}`}>
          <div className="pointer-events-auto flex gap-2 text-sm">
            {cta === "sign-in" ? (
              // The nav already carries Sign in as the one signal action, so the map's copy is secondary.
              <a href={gp("/login")} className="flex h-11 items-center rounded-gh-pill border border-line-strong bg-surface-raised px-5 font-semibold text-ink shadow-gh-2 hover:bg-tint sm:h-9">
                Sign in
              </a>
            ) : cta === "walk-in" ? (
              <button
                type="button"
                onClick={() => setWalkIn(true)}
                className="flex h-11 items-center rounded-gh-pill border border-signal bg-signal px-5 font-semibold text-signal-ink shadow-gh-2 hover:brightness-[1.06] sm:h-9"
              >
                Walk in
              </button>
            ) : null}
          </div>
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            <MapMenu label={<>{words.controls.goTo} <span aria-hidden>▾</span></>} title="Move the camera to a room, the busiest room or your own ground" align="right">
              {(close) => (
                <>
                  <MenuHeading>Rooms</MenuHeading>
                  {BOOKMARK_REGIONS.map(({ key, region }) => (
                    <MenuItem
                      key={key}
                      hint={key}
                      title={`${lex.regions[region].bookmark} — opens the room`}
                      onSelect={() => {
                        close();
                        jumpTo(key);
                        openRoom(region);
                      }}
                    >
                      {lex.regions[region].title}
                    </MenuItem>
                  ))}
                  {districts.length ? (
                    <>
                      <MenuHeading>{lex.district.heading}</MenuHeading>
                      {districts.map((d) => {
                        const name = districtName(lex.district.names, { ring: d.ordinal + 1, ordinal: d.ordinal });
                        return (
                          <MenuItem
                            key={`district-${d.ordinal}`}
                            title={`${name} (ring ${d.ordinal}) — move the camera there`}
                            onSelect={() => {
                              close();
                              controlsRef.current?.goTo(d.tx, d.ty, DISTRICT_ZOOM);
                            }}
                          >
                            {name}
                          </MenuItem>
                        );
                      })}
                    </>
                  ) : null}
                  <MenuHeading>Camera</MenuHeading>
                  {bookmarks
                    .filter((b) => b.key === "b" || b.key === "m")
                    .map((b) => (
                      <MenuItem
                        key={b.key}
                        hint={b.key}
                        title={b.title}
                        onSelect={() => {
                          close();
                          jumpTo(b.key);
                        }}
                      >
                        {b.label}
                      </MenuItem>
                    ))}
                </>
              )}
            </MapMenu>
            <AttentionBell counts={hud.attn} position={attnPos} onCycle={cycleAttention} words={words.bell} />
            <MapMenu label={<>Watch <span aria-hidden>▾</span></>} title="TV, kiosk, the History with replay, and recorded sequences" align="right">
              {(close) => (
                <>
                  <MenuItem
                    hint="v"
                    title="Kiosk mode with a director: the camera goes to faults, tool-call bursts, conversations, arrivals and the Stage, with a caption. Escape leaves."
                    onSelect={() => {
                      close();
                      setTvMode(true);
                    }}
                  >
                    {words.controls.tv}
                  </MenuItem>
                  <MenuItem
                    hint="k"
                    title="The world with no chrome, for a wall display. Escape leaves."
                    onSelect={() => {
                      close();
                      setKioskMode(true);
                    }}
                  >
                    {words.controls.kiosk}
                  </MenuItem>
                  <MenuItem
                    hint="h"
                    title="What happened: replay it on the map, or read the record"
                    onSelect={() => {
                      close();
                      openHistory();
                    }}
                  >
                    History &amp; replay
                  </MenuItem>
                  <MenuHeading>Sequences</MenuHeading>
                  <MenuItem
                    title="Record a camera path from your own moves — push, path, orbit, hold, up to a minute — and share it as a link. Plays over live or over a replay."
                    onSelect={() => {
                      close();
                      openRecorder();
                    }}
                  >
                    Record a shot
                  </MenuItem>
                </>
              )}
            </MapMenu>
            <MapMenu label={<span aria-hidden>⋯</span>} ariaLabel="More" title="Postcard, theme, reset view, depth view, keyboard, legend" align="right">
              {(close) => (
                <>
                  {signedIn ? (
                    <div className="px-2 pt-1 text-xs">
                      <ResourceBar signedIn={signedIn} />
                    </div>
                  ) : null}
                  <MenuItem
                    title={words.postcard.buttonTitle}
                    onSelect={() => {
                      close();
                      void savePostcard();
                    }}
                  >
                    {words.postcard.button}
                  </MenuItem>
                  <ThemeSwitcher value={themeId} onChange={(id) => applyTheme(id, true)} label={words.controls.theme} />
                  <AppearanceMenuGroup />
                  <MenuItem
                    hint="0"
                    onSelect={() => {
                      close();
                      resetView();
                    }}
                  >
                    {words.controls.resetView}
                  </MenuItem>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={depthOn}
                    title="Tilts the map for a sense of depth: layered height, soft shadows and a haze toward the far edge. A view preference for this browser; with reduced motion, tilt only."
                    onClick={toggleDepth}
                    className={MENU_ROW}
                  >
                    <span>Depth view</span>
                    <span className={`font-brand-mono text-gh-xs ${depthOn ? "text-ink" : "text-muted"}`}>{depthOn ? "on" : "off"}</span>
                  </button>
                  <MenuItem
                    onSelect={() => {
                      close();
                      setPanel("keys");
                    }}
                  >
                    Keyboard help
                  </MenuItem>
                  <MenuItem
                    onSelect={() => {
                      close();
                      setPanel("legend");
                    }}
                  >
                    Legend
                  </MenuItem>
                  <SoundMenuSection sound={sound} />
                  <MenuLink href="/how-it-works#agents" onSelect={close}>
                    Bring an agent
                  </MenuLink>
                  <MenuLink href="/how-it-works" onSelect={close}>
                    How it works
                  </MenuLink>
                </>
              )}
            </MapMenu>
            {/* Zoom buttons only where there is no pinch: a fine pointer that hovers. */}
            <div className="hidden gap-2 [@media(hover:hover)_and_(pointer:fine)]:flex">
              <button type="button" onClick={zoomOut} aria-label="Zoom out" title="Zoom out (−)" className={`${CONTROL} w-9 justify-center px-0 text-lg`}>
                −
              </button>
              <button type="button" onClick={zoomIn} aria-label="Zoom in" title="Zoom in (+)" className={`${CONTROL} w-9 justify-center px-0 text-lg`}>
                +
              </button>
            </div>
          </div>
        </div>
      </div>
      {/* The one line kiosk mode keeps besides the bell: what time it is here
          and how many bodies are up, in the corner, at the weight of a clock on
          a wall rather than of a heading on a page. */}
      {kiosk && sky ? (
        <div className="pointer-events-none absolute bottom-4 left-4 max-w-[calc(100%-12rem)] truncate rounded-gh-pill gh-frost px-3 py-1 font-brand-mono text-gh-xs tabular-nums text-muted sm:max-w-[calc(100%-16rem)]">
          {sky.clock} UTC · {sky.label} · {hud.awake} {words.hud.awake} · {hud.asleep} {words.hud.asleep}
          {hud.live ? ` · ${formatHeadcount({ here: hud.here, watching: hud.watching, cap: hud.watchCap }, words.hud)}` : ""}
        </div>
      ) : null}
      {recorder && !bare ? (
        <SequenceRecorder
          draft={recorder}
          kind={recKind}
          seconds={recSeconds}
          followingName={following}
          note={recNote}
          link={recLink}
          busy={recBusy}
          onKind={setRecKind}
          onSeconds={setRecSeconds}
          onTitle={(title) => {
            setRecorder((d) => (d ? { ...d, title } : d));
            setRecLink(null);
          }}
          onAdd={recordShot}
          onUndo={() => {
            setRecorder((d) => (d ? removeLastShot(d) : d));
            setRecLink(null);
          }}
          onPreview={previewDraft}
          onCopy={() => void copyDraftLink()}
          onClose={() => setRecorder(null)}
        />
      ) : null}
      {cinema ? (
        <CinemaBars
          title={cinema.title}
          elapsed={cinemaElapsed}
          total={cinema.total}
          done={cinema.done}
          preview={cinema.preview}
          holding={cinema.holding}
          onPostcard={() => void savePostcard()}
          onAgain={againCinema}
          onExit={stopCinema}
        />
      ) : null}
      <Suspense fallback={null}>
        <WorldUrlSync onChange={onUrl} />
      </Suspense>
    </section>
  );
}
