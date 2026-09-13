import { api } from "./api";
import { refusalFromWire, type UndeliveredWire, type WhisperLine } from "./whisper";

/**
 * Whisper history: the reader's own whispers in one room, read back so the log
 * survives a reload. Kept out of the room page so any surface that shows a
 * room's log (the page today, the map's room drawer next) fetches and merges
 * the same way. Who may read what is decided by the server
 * (`GET /api/v1/rooms/:slug/whispers`, kernel-checked); nothing here filters.
 */

/** One entry of `GET /api/v1/rooms/:slug/whispers`, in wire spelling. */
export type WhisperHistoryWire = {
  id: string;
  body: string;
  direction: "out" | "in";
  other_id: string;
  other_kind: "human" | "agent";
  created_at: string;
  undelivered?: UndeliveredWire | null;
};

export function whisperLineFromWire(w: WhisperHistoryWire): WhisperLine {
  const kind = w.other_kind === "agent" ? "agent" : "human";
  return {
    id: w.id,
    body: w.body,
    direction: w.direction === "in" ? "in" : "out",
    other_id: w.other_id,
    other_kind: kind,
    created_at: w.created_at,
    undelivered: w.direction === "out" && w.undelivered ? refusalFromWire(w.undelivered, kind) : null,
  };
}

/**
 * Stored lines merged into what the page already holds, by id, oldest first.
 *
 *  - A line in both keeps the SERVER's time (a live push only knew "just now")
 *    and the LIVE refusal when there is one: the send ack carries the kernel's
 *    full attribution, the history only the code.
 *  - A line only held locally (sent or heard after the fetch started) is kept.
 *  - `replaceBefore` (ms, taken just before the fetch) drops local lines the
 *    server did not return that are older than it, so a block since hides lines
 *    already on screen; anything sent or heard while the fetch ran is kept.
 */
export function mergeWhisperLines(
  current: WhisperLine[],
  stored: WhisperLine[],
  opts: { replaceBefore?: number } = {},
): WhisperLine[] {
  const byId = new Map<string, WhisperLine>();
  const storedIds = new Set(stored.map((s) => s.id));
  for (const line of current) {
    if (opts.replaceBefore !== undefined && !storedIds.has(line.id) && at(line.created_at) < opts.replaceBefore) continue;
    byId.set(line.id, line);
  }
  for (const s of stored) {
    const local = byId.get(s.id);
    byId.set(s.id, local ? { ...s, undelivered: local.undelivered ?? s.undelivered ?? null } : s);
  }
  return [...byId.values()]
    .map((line, i) => ({ line, i }))
    .sort((a, b) => at(a.line.created_at) - at(b.line.created_at) || a.i - b.i)
    .map((x) => x.line);
}

/** Fetch one room's whisper history for the signed-in reader. */
export async function fetchWhisperHistory(
  roomSlug: string,
  get: <T>(path: string) => Promise<T> = api,
): Promise<WhisperLine[]> {
  const r = await get<{ whispers?: WhisperHistoryWire[] }>(`/api/v1/rooms/${encodeURIComponent(roomSlug)}/whispers`);
  return (r.whispers ?? []).map(whisperLineFromWire);
}

function at(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}
