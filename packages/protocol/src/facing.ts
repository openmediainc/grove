/**
 * Facing hints (queue #60): "walk toward the person you're talking to".
 *
 * A hint says that body `from` just addressed body `to` in PUBLIC, so the map
 * may turn the speaker toward the addressee and take a step or two over, then
 * walk back. MOTION.md §7 is the design; this file is the whole rule, pure, so
 * the server (live minimap) and the client (replay) derive the SAME hints from
 * the same lines.
 *
 * The one thing it must never do is publish who spoke to whom privately. So the
 * only input is a line the public feed already carried: a `room_say` that the
 * synthetic spectator was delivered (speech.ts writes that row exactly when
 * `sse:plaza` broadcasts the line to every signed-out viewer). Whispers, owner
 * channels, messages (#9), private rooms, private spaces and owner lounges never
 * produce a public line, so they never produce a hint. The addressee comes from
 * the words alone — an `@handle` naming a body standing in the same room — which
 * every spectator could read off the line themselves. Speech has no reply-to, so
 * a mention is the only public addressee there is.
 */

/** How long a hint lasts after the line was said. Bounded well under 20 s. */
export const FACING_HINT_MS = 15_000;

/** The furthest a speaker steps toward the addressee, in tiles (Chebyshev). */
export const FACING_STEP_TILES = 2;

/** A line the public feed carried, as far as a hint needs it. */
export interface PublicLine {
  speechId: string;
  senderId: string;
  roomId: string | null;
  body: string | null;
  /** When it was said (ms). */
  at: number;
  /**
   * True only for a room_say the public spectator feed carried. Anything else
   * (a whisper, a line only its recipients heard, a withheld body) is ignored.
   */
  public: boolean;
}

/** A body that could be addressed: who it is, what it answers to, where it stands. */
export interface FacingBody {
  id: string;
  slug: string | null;
  roomId: string | null;
}

export interface FacingHint {
  from: string;
  to: string;
  /** The line that made it (stable identity; replay keys off it). */
  speechId: string;
  /** When the line was said (ms). */
  at: number;
  /** When the hint lapses (ms): `at + FACING_HINT_MS`. */
  until: number;
}

/** Wire shape inside the minimap payload. Ids and times only. */
export interface FacingHintWire {
  from: string;
  to: string;
  until: string;
}

/** A handle: a human handle, or an agent slug (`owner/name`), as speech.ts wakes mentions. */
const MENTION = /(^|[^a-z0-9_])@([a-z0-9][a-z0-9_/-]*)/gi;

/** The handles a line mentions, lower-cased, in order, without duplicates. */
export function mentionsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION)) {
    const h = m[2]!.toLowerCase().replace(/[-_/]+$/, "");
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * The hints in force at `now`. For each speaker, its newest public line said in
 * (now − FACING_HINT_MS, now] that @mentions another body standing in the same
 * room; the first such mention in the line is the addressee. Order-independent
 * in its inputs: the output is sorted by speaker id.
 */
export function deriveFacingHints(lines: readonly PublicLine[], bodies: readonly FacingBody[], now: number): FacingHint[] {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const bySlug = new Map<string, FacingBody[]>();
  for (const b of bodies) {
    if (!b.slug) continue;
    const k = b.slug.toLowerCase();
    bySlug.set(k, [...(bySlug.get(k) ?? []), b]);
  }
  const newest = new Map<string, FacingHint>();
  const ordered = [...lines].sort((p, q) => p.at - q.at || (p.speechId < q.speechId ? -1 : p.speechId > q.speechId ? 1 : 0));
  for (const line of ordered) {
    if (!line.public || !line.body || !line.roomId) continue;
    if (!(line.at <= now && now < line.at + FACING_HINT_MS)) continue;
    const speaker = byId.get(line.senderId);
    // The speaker must still be standing in the room it spoke in.
    if (!speaker || speaker.roomId !== line.roomId) continue;
    let to: string | null = null;
    for (const handle of mentionsIn(line.body)) {
      const hit = (bySlug.get(handle) ?? []).find((b) => b.id !== speaker.id && b.roomId === line.roomId);
      if (hit) {
        to = hit.id;
        break;
      }
    }
    // A newer line that addresses nobody ends the older hint: the speaker moved on.
    if (!to) {
      newest.delete(speaker.id);
      continue;
    }
    newest.set(speaker.id, { from: speaker.id, to, speechId: line.speechId, at: line.at, until: line.at + FACING_HINT_MS });
  }
  return [...newest.values()].sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
}

/** Every instant a line can start or end a hint: the edges replay must re-sync on. */
export function facingEdges(lines: readonly PublicLine[]): number[] {
  const out: number[] = [];
  for (const l of lines) {
    if (!l.public || !l.body || !l.roomId) continue;
    out.push(l.at, l.at + FACING_HINT_MS);
  }
  return out.sort((a, b) => a - b);
}

export function facingToWire(h: FacingHint): FacingHintWire {
  return { from: h.from, to: h.to, until: new Date(h.until).toISOString() };
}

/** A wire hint back to (from, to, until ms); malformed ones are dropped. */
export function facingFromWire(raw: unknown): { from: string; to: string; until: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const until = typeof r.until === "string" ? Date.parse(r.until) : typeof r.until === "number" ? r.until : NaN;
  if (typeof r.from !== "string" || typeof r.to !== "string" || !Number.isFinite(until) || r.from === r.to) return null;
  return { from: r.from, to: r.to, until };
}

/**
 * Where a speaker steps to face the addressee: a free tile at most
 * `maxStep` tiles from where it stands, strictly nearer the addressee, never
 * the addressee's own tile or any tile in `occupied` (seats, work slots, other
 * speakers' steps). Nearest the addressee wins; ties go to the shorter step,
 * then north-to-south, west-to-east. No such tile = stay put (face only).
 */
export function facingStepTile(
  from: { x: number; y: number },
  target: { x: number; y: number },
  grid: { blocked(tx: number, ty: number): boolean },
  occupied: ReadonlySet<string> = new Set(),
  maxStep: number = FACING_STEP_TILES,
): { x: number; y: number } {
  const fx = Math.round(from.x);
  const fy = Math.round(from.y);
  const d = (x: number, y: number) => Math.hypot(x - target.x, y - target.y);
  const here = d(fx, fy);
  let best: { x: number; y: number; dt: number; ds: number } | null = null;
  for (let dy = -maxStep; dy <= maxStep; dy++) {
    for (let dx = -maxStep; dx <= maxStep; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = fx + dx;
      const y = fy + dy;
      if (x === Math.round(target.x) && y === Math.round(target.y)) continue;
      if (grid.blocked(x, y) || occupied.has(`${x},${y}`)) continue;
      const dt = d(x, y);
      // Never closer than beside the addressee, and it must actually be nearer.
      if (dt < 1 || dt >= here - 1e-9) continue;
      const ds = Math.hypot(dx, dy);
      if (
        !best ||
        dt < best.dt - 1e-9 ||
        (Math.abs(dt - best.dt) <= 1e-9 && (ds < best.ds - 1e-9 || (Math.abs(ds - best.ds) <= 1e-9 && (y < best.y || (y === best.y && x < best.x)))))
      ) {
        best = { x, y, dt, ds };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : { x: fx, y: fy };
}

/** Screen direction to face in the isometric view: -1 left, 1 right, 0 no turn. */
export function facingScreenDir(from: { x: number; y: number }, to: { x: number; y: number }): -1 | 0 | 1 {
  const sx = to.x - to.y - (from.x - from.y);
  return Math.abs(sx) < 1e-6 ? 0 : sx < 0 ? -1 : 1;
}
