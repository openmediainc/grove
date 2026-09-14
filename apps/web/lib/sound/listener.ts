/**
 * What the soundscape hears: a diff of the map the canvas already has.
 *
 * No new server load. Each sample of the map's bodies (their tool-call spans
 * and hazards) is compared with the last one, and public speech lines come in
 * from the same poll diff Grove TV uses. The first sample is the baseline: a
 * body already on the map when sound came on did not just arrive, and a span
 * already running did not just start.
 *
 * Pure: time is an argument (test/sound.test.ts). Sound never carries
 * information the map does not already show — every event here is drawn.
 */
import type { ToolCallView } from "@grove/protocol";

export type SoundHazard = "flag" | "fault" | "stall" | null;

export interface SoundActor {
  id: string;
  hazard: SoundHazard;
  toolCalls?: readonly ToolCallView[];
}

export type ToolVerb = "read" | "write" | "run" | "think" | "other";

export type SoundEvent =
  | { kind: "start"; actorId: string; verb: ToolVerb; at: number }
  | { kind: "finish"; actorId: string; verb: ToolVerb; ok: boolean; at: number }
  | { kind: "speech"; actorId: string; at: number }
  | { kind: "arrival"; actorId: string; at: number }
  | { kind: "hazard"; actorId: string; at: number };

export type SoundEventKind = SoundEvent["kind"];

/** A span first seen this long after it started (or finished) is old news, not an event. */
export const SOUND_FRESH_MS = 15_000;
/** A body that left and came back inside this window has not arrived again. */
export const SOUND_REARRIVE_MS = 5 * 60_000;

const VERB_PATTERNS: ReadonlyArray<[ToolVerb, RegExp]> = [
  ["think", /think|plan|reason|analy[sz]|reflect|todo/i],
  ["write", /write|edit|create|update|patch|put|post|save|delete|remove|insert|apply|commit|move|rename/i],
  ["run", /bash|shell|run|exec|test|build|deploy|invoke|call|spawn|task|agent/i],
  ["read", /read|get|fetch|list|view|open|\bcat\b|grep|glob|search|find|query|look|browse|ls\b/i],
];

/** Which family a tool name belongs to, for its pitch. */
export function toolVerb(name: string | null | undefined): ToolVerb {
  const s = String(name ?? "");
  for (const [verb, re] of VERB_PATTERNS) if (re.test(s)) return verb;
  return "other";
}

export class SoundListener {
  private known: Set<string> | null = null;
  /** Bodies seen, with when they were last on the map. */
  private lastSeen = new Map<string, number>();
  /** callId -> finished yet, per span we have already sounded or baselined. */
  private spans = new Map<string, boolean>();
  private hazards = new Map<string, SoundHazard>();
  private pending: SoundEvent[] = [];

  /** Forget everything; the next sample is a fresh baseline. */
  reset(): void {
    this.known = null;
    this.lastSeen.clear();
    this.spans.clear();
    this.hazards.clear();
    this.pending = [];
  }

  /** A new public line from the poll diff. */
  heard(actorId: string, now: number): void {
    if (this.known) this.pending.push({ kind: "speech", actorId, at: now });
  }

  observe(actors: readonly SoundActor[], now: number): SoundEvent[] {
    const baseline = this.known === null;
    const out: SoundEvent[] = this.pending;
    this.pending = [];
    const ids = new Set<string>();
    const liveSpans = new Set<string>();
    for (const a of actors) {
      ids.add(a.id);
      if (!baseline && !this.known!.has(a.id)) {
        const last = this.lastSeen.get(a.id);
        if (last === undefined || now - last > SOUND_REARRIVE_MS) out.push({ kind: "arrival", actorId: a.id, at: now });
      }
      this.lastSeen.set(a.id, now);

      const prevHazard = this.hazards.get(a.id) ?? null;
      // Only a body going INTO trouble sounds, and flag/fault only: a stall is
      // silence already, and the map's bell is the carrier for all three.
      if (!baseline && a.hazard && a.hazard !== "stall" && prevHazard !== a.hazard && (prevHazard === null || prevHazard === "stall")) {
        out.push({ kind: "hazard", actorId: a.id, at: now });
      }
      this.hazards.set(a.id, a.hazard);

      for (const c of a.toolCalls ?? []) {
        const key = `${a.id}|${c.callId}`;
        liveSpans.add(key);
        const finished = Boolean(c.finishedAt);
        const was = this.spans.get(key);
        this.spans.set(key, finished);
        if (baseline) continue;
        const verb = toolVerb(c.name);
        if (was === undefined) {
          const started = Date.parse(c.startedAt);
          const freshStart = Number.isFinite(started) ? now - started <= SOUND_FRESH_MS : true;
          if (!finished) {
            if (freshStart) out.push({ kind: "start", actorId: a.id, verb, at: now });
          } else {
            const ended = Date.parse(c.finishedAt!);
            const freshEnd = Number.isFinite(ended) ? now - ended <= SOUND_FRESH_MS : freshStart;
            if (freshEnd) out.push({ kind: "finish", actorId: a.id, verb, ok: c.outcome !== "error", at: now });
          }
        } else if (!was && finished) {
          out.push({ kind: "finish", actorId: a.id, verb, ok: c.outcome !== "error", at: now });
        }
      }
    }
    for (const key of this.spans.keys()) if (!liveSpans.has(key)) this.spans.delete(key);
    for (const id of this.hazards.keys()) if (!ids.has(id)) this.hazards.delete(id);
    for (const [id, at] of this.lastSeen) if (now - at > SOUND_REARRIVE_MS) this.lastSeen.delete(id);
    this.known = ids;
    return baseline ? [] : out;
  }
}

/** How busy the map is, 0..1, for the bed: open spans and speaking bodies, saturating. */
export function activityLevel(actors: readonly SoundActor[]): number {
  let open = 0;
  for (const a of actors) for (const c of a.toolCalls ?? []) if (!c.finishedAt) open++;
  return Math.min(1, open / 8);
}
