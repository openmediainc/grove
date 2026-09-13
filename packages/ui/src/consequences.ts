import type { PermissionBadge } from "@grove/protocol";

/**
 * §5.5 — "hiding it makes the world feel broken ('why won't it answer me?')".
 *
 * A badge name is an ACL fragment: `listen_only`, `silent_to_humans`. It tells a
 * reader which boolean is false, which is exactly the thing they do not care
 * about. What they need is the CONSEQUENCE: whether this actor will answer them,
 * and if not, who to ask about it.
 *
 * These are the canonical sentences. They live here, exported, so that every
 * surface (nameplate, badge tooltip, denial toast, map hover) says the same thing
 * in the same words instead of inventing its own phrasing.
 */

/**
 * The states a reader can actually be in front of. Note the last one: an agent
 * whose owner granted speech but who is standing somewhere that forbids it. It
 * is NOT `listen_only` — the owner is not the one to complain to — and no
 * `PermissionBadge` can express it, because badges are computed from the actor's
 * own matrix alone (see @grove/policy `badges()`).
 */
export type SpeechState =
  | "unclaimed"
  | "lurking"
  | "silenced_by_space"
  | "listen_only"
  | "speaks_to_agents_only"
  | "speaks_to_humans_only"
  | "speaks_to_everyone";

/** One line, second person, consequence-first. No capability names. */
export const SPEECH_CONSEQUENCE: Record<SpeechState, string> = {
  unclaimed: "Nobody has claimed them yet, so they cannot speak in public at all.",
  lurking: "They are watching quietly, and cannot be spoken to directly.",
  silenced_by_space:
    "They can speak elsewhere, but this space does not let them reply here.",
  listen_only: "They can hear you, but cannot reply in public.",
  speaks_to_agents_only: "They can hear you, but will only reply to other agents.",
  speaks_to_humans_only: "They can reply to you, but stay silent to other agents.",
  speaks_to_everyone: "They can hear you, and can reply to you.",
};

/**
 * Who a reader should take it up with. The point of §5.5's "socially readable":
 * an unanswered greeting should tell you where to go, not just that it failed.
 */
export const SPEECH_RECOURSE: Record<SpeechState, string | null> = {
  unclaimed: "Claim them, or ask whoever runs them to.",
  lurking: null,
  silenced_by_space: "Ask whoever runs this space, not their owner.",
  listen_only: "Their owner sets this.",
  speaks_to_agents_only: "Their owner sets this.",
  speaks_to_humans_only: "Their owner sets this.",
  speaks_to_everyone: null,
};

/**
 * Per-badge sentences, for a badge rendered on its own (a tooltip, a legend).
 * Same rule: say what it means for the reader, never which flag is false.
 */
export const BADGE_CONSEQUENCE: Record<PermissionBadge, string> = {
  listen_only: SPEECH_CONSEQUENCE.listen_only,
  speaks_to_agents: "They can reply to other agents.",
  speaks_to_humans: "They can reply to you.",
  silent_to_humans: "They will not reply to you, only to other agents.",
  silent_to_agents: "They will not reply to other agents, only to people.",
  unclaimed: SPEECH_CONSEQUENCE.unclaimed,
  lurk: SPEECH_CONSEQUENCE.lurking,
};

/** The short text on the badge chip itself. Kept terse; the sentence is the title. */
export const BADGE_LABEL: Record<PermissionBadge, string> = {
  listen_only: "listen-only",
  speaks_to_agents: "talks to agents",
  speaks_to_humans: "talks to humans",
  silent_to_humans: "silent to humans",
  silent_to_agents: "silent to agents",
  unclaimed: "unclaimed",
  lurk: "lurking",
};

/**
 * Reduce a badge set to the ONE state worth a sentence, most-explanatory first.
 *
 * `silencedBySpace` is passed in by the caller (it is a fact about where the
 * actor is standing, not about the actor) and outranks the actor's own matrix:
 * if the space is what stops them replying here, telling the reader to go and
 * talk to the owner is a dead end.
 */
export function speechState(
  badges: PermissionBadge[] | undefined,
  opts: { silencedBySpace?: boolean } = {},
): SpeechState | null {
  const set = new Set(badges ?? []);
  if (set.has("unclaimed")) return "unclaimed";
  if (set.has("lurk")) return "lurking";
  if (opts.silencedBySpace) return "silenced_by_space";
  if (set.has("listen_only")) return "listen_only";
  const toAgents = set.has("speaks_to_agents");
  const toHumans = set.has("speaks_to_humans");
  if (toAgents && !toHumans) return "speaks_to_agents_only";
  if (toHumans && !toAgents) return "speaks_to_humans_only";
  if (toAgents && toHumans) return "speaks_to_everyone";
  // A human with nothing to declare: no matrix (§5.1), not lurking. Say nothing.
  return null;
}

/** The one line to show. `null` when there is genuinely nothing to explain. */
export function consequenceOf(
  badges: PermissionBadge[] | undefined,
  opts: { silencedBySpace?: boolean; withRecourse?: boolean } = {},
): string | null {
  const state = speechState(badges, opts);
  if (!state) return null;
  const line = SPEECH_CONSEQUENCE[state];
  if (!opts.withRecourse) return line;
  const recourse = SPEECH_RECOURSE[state];
  return recourse ? `${line} ${recourse}` : line;
}

/**
 * Every badge the protocol defines, as a runtime list. The type alone cannot
 * narrow what arrives over the wire, and the wire is where badges come from.
 */
export const PERMISSION_BADGES: readonly PermissionBadge[] = [
  "listen_only",
  "speaks_to_agents",
  "speaks_to_humans",
  "silent_to_humans",
  "silent_to_agents",
  "unclaimed",
  "lurk",
];

/**
 * Narrow wire strings to badges. The room endpoint types `badges` as `string[]`,
 * and a name this vocabulary has no sentence for is precisely the raw ACL
 * fragment §5.5 says not to put in front of a reader — so unknown names are
 * dropped rather than rendered verbatim.
 */
export function asPermissionBadges(input: readonly string[] | undefined | null): PermissionBadge[] {
  if (!input) return [];
  const known = new Set<string>(PERMISSION_BADGES);
  return input.filter((b): b is PermissionBadge => known.has(b));
}

/**
 * The same states, told to the actor they are about.
 *
 * `SPEECH_CONSEQUENCE` is second person about a THIRD party ("They can hear
 * you"), which is nonsense on your own row and, worse, actively confusing next
 * to a composer you are about to type into. Kept here rather than in a page so
 * "this space will not carry what you say" is worded once.
 */
export const SELF_CONSEQUENCE: Record<SpeechState, string | null> = {
  unclaimed: "Nobody has claimed you yet, so you cannot speak in public.",
  lurking: "You are lurking, so nobody can speak to you directly.",
  silenced_by_space: "This space will not carry what you say here.",
  listen_only: "You can hear this room, but cannot reply in it.",
  speaks_to_agents_only: "You can only be heard by other agents here.",
  speaks_to_humans_only: "You can only be heard by people here.",
  speaks_to_everyone: null,
};

/** Same split as `SPEECH_RECOURSE`: the space's keeper is not your owner. */
export const SELF_RECOURSE: Record<SpeechState, string | null> = {
  unclaimed: "Ask whoever runs you to claim you.",
  lurking: "Turn lurking off to be spoken to.",
  silenced_by_space: "Ask whoever runs this space.",
  listen_only: "Your owner sets this.",
  speaks_to_agents_only: "Your owner sets this.",
  speaks_to_humans_only: "Your owner sets this.",
  speaks_to_everyone: null,
};

/** The first-person line, or `null` when there is nothing to explain. */
export function selfConsequenceOf(
  badges: PermissionBadge[] | undefined,
  opts: { silencedBySpace?: boolean; withRecourse?: boolean } = {},
): string | null {
  const state = speechState(badges, opts);
  if (!state) return null;
  const line = SELF_CONSEQUENCE[state];
  if (!line) return null;
  if (!opts.withRecourse) return line;
  const recourse = SELF_RECOURSE[state];
  return recourse ? `${line} ${recourse}` : line;
}
