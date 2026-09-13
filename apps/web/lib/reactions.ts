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
