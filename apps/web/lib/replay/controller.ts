/**
 * Replay mode's client half: fetch a window, hold the playhead, and hand the
 * map a snapshot shaped EXACTLY like GET /world/minimap.
 *
 * That last part is the design. The map already turns a minimap payload into
 * bodies, seats, walks, verbs and bubbles; whatever drives motion (see
 * docs/design/MOTION.md) and whatever draws (lib/themes) consumes that same
 * payload. Replay does not get its own renderer or its own movement rules — it
 * swaps the SOURCE of the payload, so a replayed body walks, idles and speaks
 * through precisely the code a live one does. When the map's motion adapter
 * changes, replay moves with it for free.
 *
 * The time model is the pure timeline in @grove/protocol (checkpointed, no
 * clock), so the same window at the same playhead produces the same snapshot.
 * The only wall-clock value in a snapshot is `pulsed_at`, stamped "now" for a
 * body whose historical span covers the playhead, because the map judges a
 * pulse's freshness against the wall clock and a replayed span is, for the
 * frame being drawn, exactly as fresh as the moment it replays.
 */
import {
  ReplayTimeline,
  normaliseKeyframeBody,
  normaliseReplayEvent,
  type ReplayEvent,
  type ReplayKeyframeBodyInput,
  type ReplayMarker,
} from "@grove/protocol";
import { TOOL_RESULT_VISIBLE_SECONDS, type ToolCallView } from "@grove/protocol";
import { api } from "@/lib/api";
import { spanFromWire } from "@/lib/motion/director";

/** The server's stall threshold (presence.STALL_AFTER_SECONDS); the minimap publishes the same number. */
const STALL_AFTER_SECONDS_WIRE = 180;

export type LiveContext = {
  rooms?: Array<{ id: string; slug: string }>;
  spaces?: unknown[];
  orgs?: unknown[];
  stall_after_seconds?: number;
  stallAfterSeconds?: number;
  org_render_mode?: string;
  orgRenderMode?: string;
  claimed_agents?: number;
  claimedAgents?: number;
};

export type ReplayWireBody = Record<string, unknown> & {
  id: string;
  kind: "human" | "agent";
  room_slug: string;
  activity: string;
  connection: string;
  verb: string | null;
  pulsed_at: string | null;
  stalled: boolean;
  tool_calls: ToolCallView[];
};

type HistoricalSpan = ToolCallView & { actorId: string };

/**
 * A span as it looked at `t`: absent before it started, open (no outcome yet)
 * until it finished, then finished for TOOL_RESULT_VISIBLE_SECONDS — exactly
 * the list the live minimap would have carried at that moment.
 */
export function toolCallsAt(spans: readonly HistoricalSpan[], t: number): ToolCallView[] {
  const out: ToolCallView[] = [];
  for (const s of spans) {
    const started = Date.parse(s.startedAt);
    if (!(started <= t)) continue;
    const finished = s.finishedAt ? Date.parse(s.finishedAt) : null;
    const { actorId: _a, ...view } = s;
    void _a;
    if (finished !== null && finished <= t) {
      if (t - finished < TOOL_RESULT_VISIBLE_SECONDS * 1000) out.push({ ...view, stalled: false });
      continue;
    }
    const updated = Date.parse(s.updatedAt);
    out.push({
      ...view,
      finishedAt: null,
      outcome: null,
      result: null,
      durationMs: null,
      // Last report known to have happened by t. A later report is future news.
      updatedAt: updated <= t ? s.updatedAt : s.startedAt,
      stalled: t - (updated <= t ? updated : started) > STALL_AFTER_SECONDS_WIRE * 1000,
    });
  }
  return out.sort((p, q) => Number(q.finishedAt === null) - Number(p.finishedAt === null) || Date.parse(q.startedAt) - Date.parse(p.startedAt)).slice(0, 6);
}

/** Every instant at which some span's view changes. */
function spanEdgesOf(spans: readonly HistoricalSpan[]): number[] {
  const edges: number[] = [];
  for (const s of spans) {
    const started = Date.parse(s.startedAt);
    edges.push(started);
    const updated = Date.parse(s.updatedAt);
    if (Number.isFinite(updated)) {
      edges.push(updated);
      edges.push(updated + STALL_AFTER_SECONDS_WIRE * 1000 + 1);
    }
    edges.push(started + STALL_AFTER_SECONDS_WIRE * 1000 + 1);
    if (s.finishedAt) {
      const f = Date.parse(s.finishedAt);
      edges.push(f, f + TOOL_RESULT_VISIBLE_SECONDS * 1000);
    }
  }
  return edges.filter(Number.isFinite).sort((a, b) => a - b);
}

function countAtOrBefore(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Enough for a busy day; beyond it the window says it was truncated. */
const MAX_PAGES = 60;
const PAGE_LIMIT = 1000;
/** A spoken line stays up this long on screen, whatever the speed. */
const LINE_WALL_MS = 8_000;
/** How often playback re-asks the map to draw from the timeline. */
const FRAME_WALL_MS = 250;
export const LAST_VISIT_KEY = "grove-last-visit";
export const MAX_WINDOW_MS = 24 * 3600 * 1000;

type RawPage = {
  window?: { since: string; until: string };
  keyframe?: { at: string; bodies: Array<Record<string, unknown>> } | null;
  density?: { bucket_seconds?: number; bucketSeconds?: number; buckets: Array<{ at: string; n: number; by_kind?: Record<string, number>; byKind?: Record<string, number> }> } | null;
  trailing?: Array<Record<string, unknown>>;
  entries?: Array<Record<string, unknown>>;
  next_cursor?: string | null;
  nextCursor?: string | null;
  tool_calls?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
  viewer?: { signed_in?: boolean; signedIn?: boolean; operator?: boolean };
};

export type ReplayRoom = { id: string; slug: string };

export type ReplayDensityBucket = { at: number; n: number; byKind: Record<string, number> };

export interface ReplayView {
  active: boolean;
  loading: boolean;
  error: string | null;
  since: number;
  until: number;
  playhead: number;
  playing: boolean;
  speed: ReplaySpeed;
  loaded: number;
  truncated: boolean;
  bucketMs: number;
  density: ReplayDensityBucket[];
  markers: ReplayMarker[];
  signedIn: boolean;
  label: string;
}

/** The minimap-shaped payload the map already knows how to draw. */
export interface ReplaySnapshot {
  bodies: Array<Record<string, unknown>>;
  recent_speech: Array<{ speech_id: string; sender_id: string; sender_name: string; body: string }>;
  spaces: unknown[];
  rooms: unknown[];
  claimed_agents: number;
  stall_after_seconds?: number;
  org_render_mode?: string;
  orgs: unknown[];
  paperclip: { ok: boolean; agents: []; issues: [] };
}

/** "09:14" in UTC — the world's clock — with the date when it is not today's. */
export function replayClock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  if (sameDay) return hm;
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${mon} ${d.getUTCDate()} ${hm}`;
}

/**
 * The replay window as one label. Each end drops its date only when it is today,
 * so a "last day" window read "Sept 12 14:49–14:49" — a day that looked like a
 * minute. When the ends fall on different UTC days, both carry their date.
 */
export function replayWindowLabel(since: number, until: number, now: number = Date.now()): string {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (day(since) === day(until)) return `${replayClock(since, now)}–${replayClock(until, now)}`;
  return `${replayClock(since, until)}–${replayClock(until, since)}`;
}

/**
 * "Since my last visit", per browser. The value that matters is the one from
 * BEFORE this page load, so it is read once and kept, and only then is the
 * clock started that stamps this visit (every minute and when the tab hides).
 * Browser storage is a convenience here, not a record: a private window simply
 * does not get the button.
 */
let previousVisitAtLoad: number | null | undefined;

function readStoredVisit(): number | null {
  try {
    const v = Number(window.localStorage.getItem(LAST_VISIT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function stampVisit(): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  } catch {
    /* no storage: nothing to remember */
  }
}

/** The visit before this one, or null. Stable for the life of the page. */
export function previousVisit(): number | null {
  if (previousVisitAtLoad === undefined) previousVisitAtLoad = readStoredVisit();
  return previousVisitAtLoad;
}

/** Start stamping this visit. Returns the cleanup. */
export function startVisitClock(): () => void {
  previousVisit();
  stampVisit();
  const t = window.setInterval(stampVisit, 60_000);
  const onHide = () => {
    if (document.visibilityState === "hidden") stampVisit();
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    window.clearInterval(t);
    document.removeEventListener("visibilitychange", onHide);
  };
}

export class ReplayController {
  private timeline: ReplayTimeline | null = null;
  private entries: ReplayEvent[] = [];
  private keyframe: ReplayKeyframeBodyInput[] = [];
  private spansByActor = new Map<string, HistoricalSpan[]>();
  private spanEdges: number[] = [];
  /** Bumped whenever the loaded window changes, so motion knows to start over. */
  epoch = 0;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastTick = 0;
  private lastFrame = 0;
  private loadToken = 0;
  view: ReplayView = {
    active: false,
    loading: false,
    error: null,
    since: 0,
    until: 0,
    playhead: 0,
    playing: false,
    speed: 10,
    loaded: 0,
    truncated: false,
    bucketMs: 60_000,
    density: [],
    markers: [],
    signedIn: false,
    label: "",
  };

  /** Called whenever the map should redraw from the playhead. */
  constructor(private onFrame: () => void) {}

  /** Test and first-page hook: historical spans off the wire. */
  loadSpans(raw: ReadonlyArray<Record<string, unknown>>): void {
    const byActor = new Map<string, HistoricalSpan[]>();
    const all: HistoricalSpan[] = [];
    for (const r of raw) {
      const view = spanFromWire(r as Record<string, unknown>);
      const actorId = String((r as Record<string, unknown>).actor_id ?? (r as Record<string, unknown>).actorId ?? "");
      if (!view || !actorId) continue;
      const span = { ...view, actorId };
      all.push(span);
      byActor.set(actorId, [...(byActor.get(actorId) ?? []), span]);
    }
    this.spansByActor = byActor;
    this.spanEdges = spanEdgesOf(all);
  }

  /** Test hook: install a window without the network. */
  loadWindow(input: { since: number; until: number; timeline: ReplayTimeline; spans?: ReadonlyArray<Record<string, unknown>> }): void {
    this.timeline = input.timeline;
    this.loadSpans(input.spans ?? []);
    this.epoch++;
    this.emit({ active: true, loading: false, since: input.since, until: input.until, playhead: input.since, markers: input.timeline.markers });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<ReplayView>) {
    this.view = { ...this.view, ...patch };
    this.view.label = this.view.active ? `REPLAY · ${replayClock(this.view.playhead)}` : "";
    for (const fn of this.listeners) fn();
  }

  /** Enter replay over [since, until). Starts paused at `since` once the window is loaded. */
  async open(since: number, until: number): Promise<void> {
    const token = ++this.loadToken;
    const lo = Math.max(since, until - MAX_WINDOW_MS);
    this.pause();
    this.timeline = null;
    this.entries = [];
    this.keyframe = [];
    this.emit({
      active: true,
      loading: true,
      error: null,
      since: lo,
      until,
      playhead: lo,
      loaded: 0,
      truncated: false,
      density: [],
      markers: [],
    });
    this.onFrame();
    try {
      let cursor: string | null = null;
      const seen = new Map<string, ReplayEvent>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const qs = new URLSearchParams({
          since: new Date(lo).toISOString(),
          until: new Date(until).toISOString(),
          limit: String(PAGE_LIMIT),
        });
        if (cursor) qs.set("cursor", cursor);
        const res = await api<RawPage>(`/api/v1/replay?${qs.toString()}`);
        if (token !== this.loadToken) return;
        if (page === 0) {
          this.keyframe = (res.keyframe?.bodies ?? []).map(normaliseKeyframeBody);
          this.loadSpans(res.tool_calls ?? res.toolCalls ?? []);
          const d = res.density;
          const bucketMs = ((d?.bucket_seconds ?? d?.bucketSeconds ?? 60) as number) * 1000;
          const density = (d?.buckets ?? []).map((b) => ({
            at: Date.parse(b.at),
            n: b.n,
            byKind: b.by_kind ?? b.byKind ?? {},
          }));
          for (const raw of res.trailing ?? []) {
            const e = normaliseReplayEvent(raw);
            seen.set(e.id, e);
          }
          this.emit({ bucketMs, density, signedIn: Boolean(res.viewer?.signed_in ?? res.viewer?.signedIn) });
        }
        for (const raw of res.entries ?? []) {
          const e = normaliseReplayEvent(raw);
          seen.set(e.id, e);
        }
        this.emit({ loaded: seen.size });
        cursor = res.next_cursor ?? res.nextCursor ?? null;
        if (!cursor) break;
        if (page === MAX_PAGES - 1) this.emit({ truncated: true });
      }
      this.entries = [...seen.values()];
      this.timeline = ReplayTimeline.build({
        since: new Date(lo).toISOString(),
        until: new Date(until).toISOString(),
        keyframe: this.keyframe,
        entries: this.entries,
      });
      this.epoch++;
      this.emit({ loading: false, markers: this.timeline.markers });
      this.onFrame();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.emit({ loading: false, error: (err as Error).message || "Replay could not be loaded." });
    }
  }

  /** Leave replay. The map goes back to polling the live minimap. */
  close(): void {
    this.loadToken++;
    this.pause();
    this.timeline = null;
    this.entries = [];
    this.epoch++;
    this.emit({ active: false, loading: false, error: null, playing: false, markers: [], density: [] });
    this.onFrame();
  }

  seek(ms: number): void {
    if (!this.view.active) return;
    const t = Math.max(this.view.since, Math.min(this.view.until, ms));
    this.emit({ playhead: t });
    this.onFrame();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.emit({ speed });
  }

  play(): void {
    if (!this.view.active || this.view.loading || !this.timeline) return;
    if (this.view.playhead >= this.view.until) this.emit({ playhead: this.view.since });
    this.emit({ playing: true });
    this.lastTick = performance.now();
    this.lastFrame = 0;
    const tick = (now: number) => {
      if (!this.view.playing) return;
      const dt = Math.min(1000, now - this.lastTick);
      this.lastTick = now;
      const next = this.view.playhead + dt * this.view.speed;
      if (next >= this.view.until) {
        this.view = { ...this.view, playhead: this.view.until };
        this.pause();
        this.onFrame();
        return;
      }
      // The playhead advances every frame; listeners and the map hear about
      // it a few times a second, which is all a scrubber or a walk needs.
      this.view = { ...this.view, playhead: next };
      if (now - this.lastFrame >= FRAME_WALL_MS) {
        this.lastFrame = now;
        this.emit({});
        this.onFrame();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    cancelAnimationFrame(this.raf);
    if (this.view.playing) this.emit({ playing: false });
  }

  /** The last real minimap: rooms (id -> slug), plots, orgs, stall threshold. */
  private live: LiveContext | null = null;

  setLive(live: LiveContext | null): void {
    this.live = live;
  }

  /**
   * A value that changes exactly when the motion inputs at `t` change: a
   * timeline step or a tool-call boundary. Between two changes every body's
   * signals are identical, so the motion model is re-synced only on a change.
   */
  signalKey(t: number): string {
    if (!this.timeline) return "empty";
    return `${this.timeline.stepIndexAt(t)}|${countAtOrBefore(this.spanEdges, t)}`;
  }

  /** The first instant after `t` at which `signalKey` changes, or null. */
  nextSignalChange(t: number): number | null {
    const step = this.timeline?.nextStepAfter(t) ?? null;
    const i = countAtOrBefore(this.spanEdges, t);
    const edge = i < this.spanEdges.length ? this.spanEdges[i]! : null;
    if (step === null) return edge;
    if (edge === null) return step;
    return Math.min(step, edge);
  }

  /** The loaded window's start. */
  get windowStart(): number {
    return this.view.since;
  }

  /**
   * Minimap-shaped bodies at historical time `t`. Pure in (window, t, speed):
   * no wall clock. `pulsed_at` is the span's real start, the way a batch pulse
   * dates its errand live; `pulse_age_seconds` 0 marks it current at `t`.
   */
  bodiesAt(t: number): ReplayWireBody[] {
    const lineMs = LINE_WALL_MS * this.view.speed;
    const frame = this.timeline ? this.timeline.frameAt(t, { lineMs }) : [];
    const slugOf = new Map((this.live?.rooms ?? []).map((r) => [r.id, r.slug]));
    return frame.map((b) => {
      const roomSlug =
        (b.roomId && slugOf.get(b.roomId)) ||
        (b.roomId?.includes(":") ? b.roomId.split(":").pop() : b.roomId) ||
        "plaza";
      const phase = b.phase;
      const tool_calls = toolCallsAt(this.spansByActor.get(b.id) ?? [], t);
      return {
        id: b.id,
        kind: b.kind === "human" ? "human" : "agent",
        display_name: b.name,
        slug: b.slug ?? b.id,
        room_id: b.roomId,
        room_slug: roomSlug ?? "plaza",
        // Presence activity is not in the ledger. A fresh line is the one
        // activity history can vouch for; everything else rests.
        activity: b.line ? "chatting" : "idle",
        connection: phase?.verb === "offline" ? "offline" : "async",
        badges: [],
        verb: phase?.verb ?? (tool_calls.some((c) => c.finishedAt === null) ? "tool" : null),
        detail: phase?.detail ?? null,
        pulsed_at: phase ? new Date(phase.startedAt).toISOString() : null,
        pulse_age_seconds: phase ? 0 : null,
        stalled: tool_calls.some((c) => c.stalled),
        url: phase?.url ?? null,
        error_text: phase?.errorText ?? null,
        org_id: null,
        org_colour: null,
        source: "grove",
        stance: null,
        tool_calls,
      };
    });
  }

  /** The map's payload at the playhead, shaped like GET /world/minimap. */
  snapshot(live: LiveContext | null): ReplaySnapshot {
    if (live) this.live = live;
    const t = this.view.playhead;
    const lineMs = LINE_WALL_MS * this.view.speed;
    const bodies = this.bodiesAt(t);
    const frame = this.timeline ? this.timeline.frameAt(t, { lineMs }) : [];
    const recent_speech = frame
      .filter((b) => b.line && b.line.body !== null)
      .sort((p, q) => p.line!.at - q.line!.at || (p.id < q.id ? -1 : 1))
      .map((b) => ({ speech_id: `${b.id}@${b.line!.at}`, sender_id: b.id, sender_name: b.name, body: b.line!.body! }));
    const l = this.live;
    return {
      bodies,
      recent_speech,
      spaces: l?.spaces ?? [],
      rooms: l?.rooms ?? [],
      // Not historical; carried so the fog and the HUD do not jump on entry.
      claimed_agents: l?.claimed_agents ?? l?.claimedAgents ?? 0,
      stall_after_seconds: l?.stall_after_seconds ?? l?.stallAfterSeconds,
      org_render_mode: l?.org_render_mode ?? l?.orgRenderMode,
      orgs: l?.orgs ?? [],
      paperclip: { ok: false, agents: [], issues: [] },
    };
  }

  dispose(): void {
    this.loadToken++;
    cancelAnimationFrame(this.raf);
    this.listeners.clear();
  }
}
