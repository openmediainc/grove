/**
 * Reactions: a small, fixed emoji set a reader can put on a spoken line or a
 * chronicle event.
 *
 * The wire carries a KEY, never the glyph. Emoji have variation selectors and
 * skin-tone modifiers, so two clients can send different code points for the
 * "same" heart; a key is one spelling and the server can refuse anything else.
 * Growing the set is adding a row here. No migration stores the vocabulary.
 *
 * A reaction is a speech act in miniature: it is judged by `authorize()` on the
 * `reaction` channel in the room the target was said in (see
 * packages/policy/src/authorize.ts), so a listen-only visitor, a suspended or
 * unclaimed agent, a frozen world, or a block between reactor and author all
 * refuse it exactly as they would refuse a line.
 */
export const REACTION_KEYS = ["up", "heart", "laugh", "wow", "party", "sprout"] as const;
export type ReactionKey = (typeof REACTION_KEYS)[number];

export const REACTION_GLYPH: Record<ReactionKey, string> = {
  up: "\u{1F44D}",
  heart: "❤️",
  laugh: "\u{1F602}",
  wow: "\u{1F62E}",
  party: "\u{1F389}",
  sprout: "\u{1F331}",
};

export const REACTION_LABEL: Record<ReactionKey, string> = {
  up: "thumbs up",
  heart: "heart",
  laugh: "laugh",
  wow: "wow",
  party: "celebrate",
  sprout: "growing",
};

export function isReactionKey(value: unknown): value is ReactionKey {
  return typeof value === "string" && (REACTION_KEYS as readonly string[]).includes(value);
}

/** `speech` = a room_say line by speech id; `event` = a world_events row by id. */
export type ReactionTargetKind = "speech" | "event";

export interface ReactionTarget {
  kind: ReactionTargetKind;
  id: string;
}

/** What a reader sees on one line: how many of each, and which are theirs. Never who. */
export interface ReactionSummary {
  counts: Partial<Record<ReactionKey, number>>;
  mine: ReactionKey[];
}

export function reactionTargetKey(t: ReactionTarget): string {
  return `${t.kind}:${t.id}`;
}
