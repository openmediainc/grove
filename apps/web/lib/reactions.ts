import { REACTION_GLYPH, REACTION_KEYS, REACTION_LABEL, type ReactionKey } from "@grove/protocol";

/** The wire shape (`toSnake` leaves these keys as they are). */
export type ReactionSummaryWire = { counts: Partial<Record<ReactionKey, number>>; mine: ReactionKey[] };
export type ReactionTargetWire = { kind: "speech" | "event"; id: string };

export const EMPTY_REACTIONS: ReactionSummaryWire = { counts: {}, mine: [] };

export type ReactionChip = { key: ReactionKey; glyph: string; label: string; count: number; mine: boolean };

/** Chips for the reactions a line already has, in the fixed vocabulary order. Zero counts are dropped. */
export function reactionChips(summary: ReactionSummaryWire | null | undefined): ReactionChip[] {
  const s = summary ?? EMPTY_REACTIONS;
  return REACTION_KEYS.flatMap((key) => {
    const count = s.counts[key] ?? 0;
    if (count <= 0) return [];
    return [{ key, glyph: REACTION_GLYPH[key], label: REACTION_LABEL[key], count, mine: s.mine.includes(key) }];
  });
}

/**
 * The optimistic answer to a click, before the server's. Never below zero, never
 * double-counted: turning on a reaction you already hold changes nothing, as the
 * server's ON CONFLICT DO NOTHING does.
 */
export function applyReaction(summary: ReactionSummaryWire | null | undefined, key: ReactionKey, on: boolean): ReactionSummaryWire {
  const s = summary ?? EMPTY_REACTIONS;
  const held = s.mine.includes(key);
  if (on === held) return s;
  const count = Math.max(0, (s.counts[key] ?? 0) + (on ? 1 : -1));
  const counts = { ...s.counts };
  if (count > 0) counts[key] = count;
  else delete counts[key];
  const mine = on ? REACTION_KEYS.filter((k) => k === key || s.mine.includes(k)) : s.mine.filter((k) => k !== key);
  return { counts, mine };
}

/** One sentence for a refused reaction. The server's 404 says nothing about why, and neither does this. */
export function reactionRefusalText(code: string | undefined): string {
  switch (code) {
    case "NOT_FOUND":
      return "You can react only to what reached you.";
    case "RATE_LIMITED":
      return "Slow down a moment.";
    case "BLOCKED":
      return "You cannot react to this.";
    case "FROZEN":
      return "Reactions are paused right now.";
    case "UNAUTHORIZED":
      return "Sign in to react.";
    default:
      return "This space does not let you react here.";
  }
}

/**
 * Live counts from a room-stream `reaction_counts` frame onto a line's summary.
 * The frame carries counts only; which ones are the reader's own stays as the
 * reader last knew it, minus any the counts say no longer exist.
 */
export function withLiveCounts(summary: ReactionSummaryWire | null | undefined, counts: unknown): ReactionSummaryWire {
  const raw = counts && typeof counts === "object" ? (counts as Record<string, unknown>) : {};
  const next: Partial<Record<ReactionKey, number>> = {};
  for (const key of REACTION_KEYS) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) next[key] = Math.trunc(n);
  }
  const mine = (summary?.mine ?? []).filter((k) => (next[k] ?? 0) > 0);
  return { counts: next, mine };
}

/**
 * Put polled or pushed summaries onto the lines that have them. Lines the update
 * does not name are left alone, and so is the array when nothing changed, so a
 * quiet poll does not re-render the transcript.
 */
export function mergeLineReactions<L extends { id: string; reactions?: ReactionSummaryWire | null }>(
  lines: L[],
  updates: Map<string, ReactionSummaryWire>,
): L[] {
  let changed = false;
  const out = lines.map((l) => {
    const u = updates.get(l.id);
    if (!u || sameSummary(l.reactions, u)) return l;
    changed = true;
    return { ...l, reactions: u };
  });
  return changed ? out : lines;
}

function sameSummary(a: ReactionSummaryWire | null | undefined, b: ReactionSummaryWire): boolean {
  const x = a ?? EMPTY_REACTIONS;
  return (
    REACTION_KEYS.every((k) => (x.counts[k] ?? 0) === (b.counts[k] ?? 0)) &&
    x.mine.length === b.mine.length &&
    x.mine.every((k) => b.mine.includes(k))
  );
}

/**
 * How long until the room page next polls counts, or null for not at all. A
 * hidden tab never polls. With the room socket open, pushes carry the news and
 * the poll only catches lines the push could not (a reader who was not there
 * when the line was said); without it (Vercel), the poll is the live path.
 */
export function reactionPollDelay(socketLive: boolean, tabVisible: boolean): number | null {
  if (!tabVisible) return null;
  return socketLive ? 60_000 : 15_000;
}
