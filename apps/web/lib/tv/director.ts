/**
 * Grove TV: the map, directed.
 *
 * Kiosk mode tours the six landmarks on a wall clock, which is fair to the
 * rooms and blind to the world: it will hold on an empty Garden while an agent
 * faults in the Workshop. Grove TV points the camera at what is actually
 * happening, and says what that is in one caption.
 *
 * Everything it looks at is already public on the map — the idle bell's
 * attention ranks (hazards first), tool-call spans, pulses, public speech,
 * bodies appearing in a poll, and the Stage's schedule — so a caption can
 * never say more than a spectator hovering the same body would read. It never
 * invents a signal either: no candidate exists without data behind it, and
 * when nothing is going on it says so and pulls wide.
 *
 * Pure: time comes in as an argument, so the same inputs always cut the same
 * way (test/tv-director.test.ts). The map owns the camera; this only decides
 * which shot is on and what its caption says.
 */
import { describeToolCall, type ToolCallView } from "@grove/protocol";

export type TvShotKind = "hazard" | "burst" | "conversation" | "arrival" | "stage" | "working" | "idle" | "wide";

export type TvHazard = "flag" | "fault" | "stall" | null;

/** What the director needs to know about a body, straight off the map's actor. */
export interface TvActor {
  id: string;
  name: string;
  kind: "human" | "agent" | "paperclip";
  region: string;
  verb: string;
  detail?: string;
  hazard: TvHazard;
  errorText?: string | null;
  /** Asleep and counting down to eviction. */
  fading?: boolean;
  toolCalls?: ToolCallView[];
}

export interface TvStage {
  title: string;
  startsAt: string;
  region: string;
}

export interface TvWords {
  regionTitle: (region: string) => string;
}

export interface TvShot {
  /** Stable identity of the subject: a shot with the same key is the same shot. */
  key: string;
  kind: TvShotKind;
  /** Follow this body. Null = frame `region` (or the whole campus when that is null too). */
  actorId: string | null;
  region: string | null;
  caption: string;
  score: number;
}

/** A shot holds at least this long before anything but a hazard may cut away. */
export const TV_MIN_HOLD_MS = 10_000;
/** And at most this long when something else is worth a look. */
export const TV_MAX_HOLD_MS = 25_000;
/** A subject that has just been on is rested this long, so one busy body cannot own the channel. */
export const TV_COOLDOWN_MS = 60_000;
/** Spans started inside this window count toward a burst. */
export const TV_BURST_WINDOW_MS = 60_000;
/** This many spans in the window is a burst, not just a call. */
export const TV_BURST_MIN = 3;
/** Two voices inside this window are a conversation. */
export const TV_CONVO_WINDOW_MS = 90_000;
/** A lone line is worth a look for this long. */
export const TV_LINE_WINDOW_MS = 30_000;
/** An arrival is news for this long. */
export const TV_ARRIVAL_WINDOW_MS = 45_000;
/** A Stage event that started this recently is breaking news rather than background. */
export const TV_STAGE_FRESH_MS = 3 * 60_000;

/** Scores. Only their order matters; a hazard outranks everything and may cut in early. */
const SCORE = {
  flag: 100,
  fault: 95,
  stall: 80,
  stageFresh: 70,
  burst: 60,
  conversation: 55,
  arrival: 45,
  stage: 40,
  line: 35,
  working: 20,
  pondering: 14,
  fading: 10,
  idle: 8,
  wide: 0,
} as const;
const HAZARD_FLOOR = SCORE.stall;

const QUOTE_MAX = 60;
const SPEECH_KEEP = 40;

type Line = { actorId: string; body: string; at: number };

function quote(body: string): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX - 1)}…` : s;
}

function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export class TvDirector {
  private known: Set<string> | null = null;
  private arrivals = new Map<string, number>();
  /** actorId → callId → when the span started, kept past the minimap's 30 s window. */
  private spans = new Map<string, Map<string, number>>();
  private lines: Line[] = [];
  private current: TvShot | null = null;
  private since = 0;
  private cooldown = new Map<string, number>();

  /** Somebody said something in public. */
  heard(actorId: string, body: string, now: number): void {
    this.lines.push({ actorId, body, at: now });
    if (this.lines.length > SPEECH_KEEP) this.lines.splice(0, this.lines.length - SPEECH_KEEP);
  }

  /**
   * Read the bodies on the map now. The first read is the baseline: a body
   * already here when the channel came on did not just arrive.
   */
  observe(actors: readonly TvActor[], now: number): void {
    const ids = new Set(actors.map((a) => a.id));
    if (this.known) {
      for (const id of ids) if (!this.known.has(id)) this.arrivals.set(id, now);
    }
    this.known = ids;
    for (const [id, at] of this.arrivals) {
      if (!ids.has(id) || now - at > TV_ARRIVAL_WINDOW_MS) this.arrivals.delete(id);
    }
    for (const a of actors) {
      const calls = a.toolCalls ?? [];
      if (!calls.length) continue;
      let seen = this.spans.get(a.id);
      if (!seen) this.spans.set(a.id, (seen = new Map()));
      for (const c of calls) {
        const started = Date.parse(c.startedAt);
        if (!seen.has(c.callId)) seen.set(c.callId, Number.isFinite(started) ? started : now);
      }
    }
    for (const [id, seen] of this.spans) {
      for (const [call, at] of seen) if (now - at > TV_BURST_WINDOW_MS) seen.delete(call);
      if (!seen.size || !ids.has(id)) this.spans.delete(id);
    }
  }

  /** Everything worth a look right now, best first. Always ends with the wide shot. */
  candidates(actors: readonly TvActor[], stage: TvStage | null, words: TvWords, now: number): TvShot[] {
    const out: TvShot[] = [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    const where = (a: TvActor) => words.regionTitle(a.region);

    for (const a of actors) {
      const doing = a.detail ? ` · ${a.detail}` : "";
      // Hazards: the same three the idle bell ranks first.
      if (a.hazard === "flag") {
        out.push(shot(`hazard:${a.id}`, "hazard", a, `${a.name} is flagged for prompt injection, in ${where(a)}`, SCORE.flag));
        continue;
      }
      if (a.hazard === "fault") {
        const caption =
          a.verb === "blocked"
            ? `${a.name} is blocked and waiting for a human${doing}`
            : `${a.name} hit a fault${a.errorText ? `: ${quote(a.errorText)}` : doing}`;
        out.push(shot(`hazard:${a.id}`, "hazard", a, caption, SCORE.fault));
        continue;
      }
      if (a.hazard === "stall") {
        out.push(shot(`hazard:${a.id}`, "hazard", a, `${a.name} says it is working, but has gone quiet`, SCORE.stall));
        continue;
      }

      const calls = a.toolCalls ?? [];
      const open = calls.find((c) => c.finishedAt === null && !c.stalled);
      const recent = [...(this.spans.get(a.id)?.values() ?? [])].filter((at) => now - at <= TV_BURST_WINDOW_MS).length;
      if (recent >= TV_BURST_MIN) {
        const latest = open ?? calls[0];
        const what = latest ? `: ${describeToolCall(latest)}` : "";
        out.push(shot(`burst:${a.id}`, "burst", a, `${a.name} is on a run of ${recent} tool calls${what}`, SCORE.burst + recent));
        continue;
      }

      const arrived = this.arrivals.get(a.id);
      if (arrived !== undefined) {
        const noun = a.kind === "human" ? "a person" : "an agent";
        out.push(shot(`arrival:${a.id}`, "arrival", a, `${a.name} (${noun}) just arrived in ${where(a)}`, SCORE.arrival));
        continue;
      }

      if (open) {
        out.push(shot(`working:${a.id}`, "working", a, `${a.name} is running ${describeToolCall(open)}`, SCORE.working + 5));
      } else if (a.verb === "tool" || a.verb === "read") {
        out.push(shot(`working:${a.id}`, "working", a, `${a.name} is ${a.verb === "read" ? "reading" : "working"} in ${where(a)}${doing}`, SCORE.working));
      } else if (a.verb === "think" || a.verb === "wait" || a.verb === "say") {
        const how = a.verb === "think" ? "thinking" : a.verb === "wait" ? "waiting" : "speaking";
        out.push(shot(`working:${a.id}`, "working", a, `${a.name} is ${how} in ${where(a)}`, SCORE.pondering));
      } else if (a.fading) {
        out.push(shot(`idle:${a.id}`, "idle", a, `${a.name} is asleep in ${where(a)}, and fading`, SCORE.fading));
      } else if (a.verb === "idle" || a.verb === "offline") {
        out.push(shot(`idle:${a.id}`, "idle", a, `${a.name} is idle in ${where(a)}`, SCORE.idle));
      }
    }

    // Conversations, per room: the voices heard there lately.
    const byRegion = new Map<string, Line[]>();
    for (const line of this.lines) {
      if (now - line.at > TV_CONVO_WINDOW_MS) continue;
      const a = byId.get(line.actorId);
      if (!a) continue;
      const list = byRegion.get(a.region) ?? [];
      list.push(line);
      byRegion.set(a.region, list);
    }
    for (const [region, list] of byRegion) {
      const last = list[list.length - 1]!;
      const speaker = byId.get(last.actorId)!;
      const voices = [...new Set(list.map((l) => l.actorId))].map((id) => byId.get(id)!.name);
      if (voices.length >= 2) {
        out.push({
          key: `conversation:${region}`,
          kind: "conversation",
          actorId: speaker.id,
          region,
          caption: `${names(voices.slice(-3))} are talking in ${words.regionTitle(region)}: ${speaker.name}: “${quote(last.body)}”`,
          score: SCORE.conversation + Math.min(voices.length, 5),
        });
      } else if (now - last.at <= TV_LINE_WINDOW_MS) {
        out.push({
          key: `conversation:${region}`,
          kind: "conversation",
          actorId: speaker.id,
          region,
          caption: `${speaker.name}, in ${words.regionTitle(region)}: “${quote(last.body)}”`,
          score: SCORE.line,
        });
      }
    }

    if (stage) {
      const started = Date.parse(stage.startsAt);
      const fresh = Number.isFinite(started) && now - started <= TV_STAGE_FRESH_MS;
      out.push({
        key: `stage:${stage.title}:${stage.startsAt}`,
        kind: "stage",
        actorId: null,
        region: stage.region,
        caption: `${fresh ? "Starting now" : "On now"} in ${words.regionTitle(stage.region)}: ${quote(stage.title)}`,
        score: fresh ? SCORE.stageFresh : SCORE.stage,
      });
    }

    const awake = actors.filter((a) => !a.fading && a.verb !== "idle" && a.verb !== "offline").length;
    out.push({
      key: "wide",
      kind: "wide",
      actorId: null,
      region: null,
      caption: actors.length ? `The whole campus · ${actors.length} here, ${awake} busy` : "The whole campus · nobody is here yet",
      score: SCORE.wide,
    });

    return out.sort((p, q) => q.score - p.score || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  }

  /**
   * Which shot is on now. Holds a shot for TV_MIN_HOLD_MS; a hazard may cut in
   * sooner. After the minimum, a better subject wins; after TV_MAX_HOLD_MS any
   * other subject does. A shot whose body has left the map ends at once.
   * `holdScale` stretches the holds (reduced motion: fewer cuts).
   */
  step(input: { now: number; actors: readonly TvActor[]; stage: TvStage | null; words: TvWords; holdScale?: number }): TvShot {
    const { now } = input;
    const scale = input.holdScale ?? 1;
    const cands = this.candidates(input.actors, input.stage, input.words, now);
    const cur = this.current;
    const live = cur ? cands.find((c) => c.key === cur.key) : undefined;
    const eligible = cands.filter((c) => c.key !== cur?.key && !((this.cooldown.get(c.key) ?? 0) > now));
    const best = eligible[0] ?? cands.find((c) => c.key !== cur?.key) ?? cands[cands.length - 1]!;
    const elapsed = now - this.since;

    if (!cur) return this.take(best, now);
    const gone = cur.actorId !== null && !input.actors.some((a) => a.id === cur.actorId);
    if (gone) return this.take(best, now);
    if (best.score >= HAZARD_FLOOR && (live?.score ?? cur.score) < HAZARD_FLOOR) return this.take(best, now);
    if (elapsed >= TV_MAX_HOLD_MS * scale && best.key !== cur.key) return this.take(best, now);
    if (elapsed >= TV_MIN_HOLD_MS * scale && (!live || best.score > live.score)) return this.take(best, now);
    // Holding: the caption still follows the truth (a span finishes, a new line is said).
    if (live) this.current = { ...live };
    return this.current!;
  }

  private take(next: TvShot, now: number): TvShot {
    if (this.current && this.current.key !== next.key) this.cooldown.set(this.current.key, now + TV_COOLDOWN_MS);
    for (const [k, until] of this.cooldown) if (until <= now) this.cooldown.delete(k);
    if (!this.current || this.current.key !== next.key) this.since = now;
    this.current = { ...next };
    return this.current;
  }
}

function shot(key: string, kind: TvShotKind, a: TvActor, caption: string, score: number): TvShot {
  return { key, kind, actorId: a.id, region: a.region, caption, score };
}
