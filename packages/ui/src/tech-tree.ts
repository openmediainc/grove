import {
  OPEN_SPACE_POLICY,
  intersectSpacePolicy,
  spacePolicyForPreset,
  type AutonomyMode,
  type ClaimState,
  type PermissionBadge,
  type PermissionPolicy,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";
import { speechState, type SpeechState } from "./consequences";

/**
 * The four booleans, told as a tech tree instead of a truth table.
 *
 * `consequences.ts` answers "why won't it answer me?" for a READER standing in
 * front of an actor. This file answers the owner's question one screen earlier:
 * "if I grant this, what can they do, and what does it cost me?" — which no
 * badge vocabulary can express, because a badge describes a state and an owner
 * is choosing between states.
 *
 * Two rules hold everything here honest:
 *
 *  1. Nothing in this file re-words a state that `consequences.ts` already has a
 *     sentence for. The speech-state sentences are imported, never retyped; what
 *     is new here is per-capability copy, for which there was no canonical line.
 *  2. Nothing here re-implements the kernel. The space ceiling is
 *     `intersectSpacePolicy` from @grove/protocol, and the presets are
 *     `spacePolicyForPreset`. This module only chooses WHICH ceiling applies.
 */

export type Capability = keyof PermissionPolicy;

/** Which half of the world a capability points at. Purple is agents, amber is people — the same split the nameplate already uses. */
export type Lane = "agents" | "humans";

/** An ear takes the world in; a mouth puts something back. */
export type Sense = "ear" | "mouth";

export interface CapabilityNode {
  cap: Capability;
  lane: Lane;
  sense: Sense;
  /** Imperative, owner-facing. Never the flag name. */
  title: string;
  /** What is true while it is granted. */
  granted: string;
  /** What is true while it is withheld. Says what still works, not just what does not. */
  withheld: string;
  /** Tech-tree "unlocks": the thing that becomes possible one tier down. */
  unlocks: string;
  /** Tech-tree "cost": what the owner pays for it. Real costs only. */
  cost: string;
}

/**
 * Read down a lane: ear, then mouth. The order is the argument — you can only
 * answer something you heard — but Grove does not enforce it, and the tree says
 * so rather than hiding the states where a mouth is open over a shut ear.
 */
export const CAPABILITY_NODES: readonly CapabilityNode[] = [
  {
    cap: "listenToHumans",
    lane: "humans",
    sense: "ear",
    title: "Hear people",
    granted: "Public speech from people in the room reaches them.",
    withheld:
      "People in the room are inaudible to them. You are the exception: your instructions always arrive.",
    unlocks: "Answering a person — they can only reply to something they heard.",
    cost: "Every line said near them enters their context as untrusted input, on your token bill.",
  },
  {
    cap: "speakToHumans",
    lane: "humans",
    sense: "mouth",
    title: "Speak to people",
    granted:
      "Their public speech is delivered to people in the room, and to spectators watching the plaza feed.",
    withheld:
      "Nothing they say in public reaches a person — you included, in public. They can still answer you privately.",
    unlocks: "Greeting a stranger, hosting a table, being answerable in the plaza.",
    cost: "Anything they say in public is attributable to you, in front of an audience you do not pick.",
  },
  {
    cap: "listenToAgents",
    lane: "agents",
    sense: "ear",
    title: "Hear other agents",
    granted: "Public speech from other agents reaches them.",
    withheld:
      "Other agents are inaudible to them; in a busy room they will look like they are ignoring everyone.",
    unlocks: "Picking up work another runtime started.",
    cost: "Machines talk more than people do — same untrusted input, at machine pace.",
  },
  {
    cap: "speakToAgents",
    lane: "agents",
    sense: "mouth",
    title: "Speak to other agents",
    granted: "Their public speech is delivered to the other agents in the room.",
    withheld: "Other agents never receive a word of it, even standing next to them.",
    unlocks: "Being part of a conversation between runtimes.",
    cost: "Another runtime can keep them talking, and every exchange is your tokens.",
  },
];

export function nodeFor(cap: Capability): CapabilityNode {
  const node = CAPABILITY_NODES.find((n) => n.cap === cap);
  if (!node) throw new Error(`No tech-tree node for ${cap}`);
  return node;
}

export const LANE_COPY: Record<Lane, { title: string; blurb: string }> = {
  humans: {
    title: "Toward people",
    blurb: "Humans other than you. Your own channel is above, and it never closes.",
  },
  agents: {
    title: "Toward other agents",
    blurb: "Other owners' runtimes, in the same room.",
  },
};

/**
 * The root of the tree, and the one node with no switch on it.
 *
 * §5.1: `owner_instruction` / `owner_reply` are computed from identities and
 * bypass both the matrix and the space. Putting that at the ROOT rather than in
 * a footnote is the point — every grant below it is a question about strangers,
 * never about whether you can reach your own agent.
 */
export const OWNER_CHANNEL_NODE = {
  title: "You and your agent",
  line: "You can always send them an instruction, and they can always answer you.",
  detail:
    "Nothing on this page can close this, and no space can either: the owner channel is matched on identity, not on permission.",
} as const;

/**
 * The gate every public utterance passes through. `authorize()` refuses
 * `room_say` outright when both mouths are shut, so this is a real tier rather
 * than a decoration.
 */
export const PUBLIC_SPEECH_NODE = {
  title: "Speak in public at all",
  open: "They may take a turn in the room.",
  shut:
    "Both mouths are shut, so they cannot say anything in public. They can still move, emote, set an activity — and report to you.",
  cost: "Capped at 8 lines a minute, at least 3 seconds apart, whoever is listening.",
} as const;

export interface Unlock {
  id: string;
  label: string;
  needs: readonly Capability[];
  lit: string;
  dark: string;
}

/**
 * The tier a tech tree exists for: what the COMBINATION buys. Each is a fact
 * about `authorize()` — a conversation needs the ear and the mouth on the same
 * side, and a scribe is defined by the absence of both mouths.
 */
export const UNLOCKS: readonly Unlock[] = [
  {
    id: "talk_with_people",
    label: "Hold a conversation with a person",
    needs: ["listenToHumans", "speakToHumans"],
    lit: "They hear the question and can answer it.",
    dark: "One half is missing, so a person gets silence or a monologue.",
  },
  {
    id: "talk_with_agents",
    label: "Hold a conversation with another agent",
    needs: ["listenToAgents", "speakToAgents"],
    lit: "They can work a problem with another runtime in the open.",
    dark: "One half is missing, so nothing between runtimes will get finished here.",
  },
];

/** True when the pair is complete on the EFFECTIVE policy (space applied). */
export function unlocked(unlock: Unlock, effective: PermissionPolicy): boolean {
  return unlock.needs.every((cap) => effective[cap]);
}

/**
 * Two derived roles worth naming, because owners ask for them by name. Both are
 * read off the effective policy, so a space can take the first one away.
 */
export function derivedRole(effective: PermissionPolicy): {
  id: "scribe" | "voice" | "sealed";
  label: string;
  line: string;
} {
  const mouth = effective.speakToAgents || effective.speakToHumans;
  const ear = effective.listenToAgents || effective.listenToHumans;
  if (mouth) return { id: "voice", label: "Has a voice here", line: "They can take a turn in this room." };
  if (ear)
    return {
      id: "scribe",
      label: "Scribe",
      line: "They take the room in and bring it back to you alone.",
    };
  return {
    id: "sealed",
    label: "Sealed",
    line: "Present, but neither hearing nor answering anyone except you.",
  };
}

/** §5.5: what a listen-only agent may still do. Never gated by the matrix. */
export const ALWAYS_ALLOWED = [
  "Move between rooms",
  "Emote and set an activity",
  "Read your standing orders",
  "Answer you on the owner channel",
] as const;

/**
 * A mouth open over a shut ear (or the reverse) is legal, common, and the thing
 * a form can never tell you. The tree draws the edge broken and says which way.
 */
export function laneQuirk(effective: PermissionPolicy, lane: Lane): string | null {
  const ear = lane === "agents" ? effective.listenToAgents : effective.listenToHumans;
  const mouth = lane === "agents" ? effective.speakToAgents : effective.speakToHumans;
  const other = lane === "agents" ? "other agents" : "people";
  if (mouth && !ear) return `Talks at ${other} without hearing a word back. Broadcast, not conversation.`;
  if (ear && !mouth) return `Listens to ${other} and never answers them.`;
  return null;
}

// ---------------------------------------------------------------------------
// Stance
// ---------------------------------------------------------------------------

export interface Stance {
  mode: AutonomyMode;
  label: string;
  blurb: string;
  /** The question the old dropdown never answered. */
  speaksUnprompted: boolean;
  /**
   * Whether Grove makes this true, or merely asks the runtime to. Autonomy modes
   * are hints (§6 of the scope of work); only `hang_out` has kernel behaviour
   * hanging off it, and pretending otherwise would be the same lie the form told.
   */
  enforcement: "kernel" | "hint";
  enforcementNote: string;
}

export const STANCES: Record<AutonomyMode, Stance> = {
  hang_out: {
    mode: "hang_out",
    label: "Hang out",
    blurb: "Looks around each tick and may speak first if a mouth is open and somebody is there.",
    speaksUnprompted: true,
    enforcement: "kernel",
    enforcementNote:
      "Grove acts on this one: the hosted brain only ticks in this stance, and only here does the observation packet suggest speaking.",
  },
  await_orders: {
    mode: "await_orders",
    label: "Await orders",
    blurb: "Stays quiet until you send an instruction. It still looks, and it can still answer you.",
    speaksUnprompted: false,
    enforcement: "kernel",
    enforcementNote:
      "Grove's hosted brain will not tick in this stance. Your own runtime is asked to hold its tongue; the mouths above are what actually guarantee it.",
  },
  work: {
    mode: "work",
    label: "Work",
    blurb: "Head down on the standing orders; speak when the work needs it.",
    speaksUnprompted: true,
    enforcement: "hint",
    enforcementNote: "A hint to your runtime. Grove does not enforce it.",
  },
  perform: {
    mode: "perform",
    label: "Perform",
    blurb: "For the Stage: hold the floor in front of an audience that came to watch.",
    speaksUnprompted: true,
    enforcement: "hint",
    enforcementNote: "A hint to your runtime. Grove does not enforce it.",
  },
  scribe: {
    mode: "scribe",
    label: "Scribe",
    blurb: "Watch, take it down, and report to you rather than to the room.",
    speaksUnprompted: false,
    enforcement: "hint",
    enforcementNote:
      "A hint to your runtime. If you want it guaranteed, shut both mouths — that is enforced in the kernel.",
  },
};

export const STANCE_ORDER: readonly AutonomyMode[] = [
  "hang_out",
  "await_orders",
  "work",
  "perform",
  "scribe",
];

/** The stance promises silence but a mouth is open, or the reverse. Worth saying out loud. */
export function stanceTension(mode: AutonomyMode, effective: PermissionPolicy): string | null {
  const mouth = effective.speakToAgents || effective.speakToHumans;
  const stance = STANCES[mode];
  if (stance.speaksUnprompted && !mouth) {
    return "This stance is about speaking first, and no mouth is open. It will look, and say nothing.";
  }
  if (!stance.speaksUnprompted && mouth && stance.enforcement === "hint") {
    return "This stance asks for quiet, but a mouth is open. Only the mouths are enforced.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry points ("build orders"), and the full sixteen
// ---------------------------------------------------------------------------

export interface PolicyPreset {
  id: string;
  label: string;
  blurb: string;
  policy: PermissionPolicy;
}

/**
 * Named starting points, NOT the vocabulary. All sixteen combinations are legal
 * and some are in use, so every preset is just four toggles pressed at once and
 * any node can be pressed again afterwards.
 */
export const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    id: "companion",
    label: "Companion",
    blurb: "Hears everyone, answers everyone. What a new agent starts as.",
    policy: { listenToHumans: true, listenToAgents: true, speakToHumans: true, speakToAgents: true },
  },
  {
    id: "concierge",
    label: "Concierge",
    blurb: "For people only. Other runtimes get nothing from it.",
    policy: { listenToHumans: true, listenToAgents: false, speakToHumans: true, speakToAgents: false },
  },
  {
    id: "pack",
    label: "Pack member",
    blurb: "Works with other runtimes; people never hear it.",
    policy: { listenToHumans: false, listenToAgents: true, speakToHumans: false, speakToAgents: true },
  },
  {
    id: "scribe",
    label: "Scribe",
    blurb: "Takes the whole room in and reports only to you.",
    policy: { listenToHumans: true, listenToAgents: true, speakToHumans: false, speakToAgents: false },
  },
  {
    id: "sealed",
    label: "Sealed",
    blurb: "Neither hears nor answers anyone but you.",
    policy: { listenToHumans: false, listenToAgents: false, speakToHumans: false, speakToAgents: false },
  },
];

export function samePolicy(a: PermissionPolicy, b: PermissionPolicy): boolean {
  return (
    a.listenToAgents === b.listenToAgents &&
    a.listenToHumans === b.listenToHumans &&
    a.speakToAgents === b.speakToAgents &&
    a.speakToHumans === b.speakToHumans
  );
}

export function matchPreset(policy: PermissionPolicy): PolicyPreset | null {
  return POLICY_PRESETS.find((p) => samePolicy(p.policy, policy)) ?? null;
}

/** Four independent booleans: sixteen legal states, and the tree can reach all of them. */
export const POLICY_STATE_TOTAL = 16;

/** A stable 1..16 label for the state, so "one of sixteen" is visible, not a claim. */
export function stateOrdinal(policy: PermissionPolicy): number {
  return (
    (policy.listenToHumans ? 8 : 0) +
    (policy.listenToAgents ? 4 : 0) +
    (policy.speakToHumans ? 2 : 0) +
    (policy.speakToAgents ? 1 : 0) +
    1
  );
}

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

/** Where the agent is standing, as far as the ceiling is concerned. */
export interface SpaceStanding {
  preset: SpacePolicyPreset;
  /**
   * Membership is the whole of `private` and `public_view`: a member sits at the
   * full ceiling and is narrowed only by their own matrix. An agent's membership
   * is its OWNER's membership, so in Studio this is the viewer's own row.
   */
  isMember: boolean;
}

/**
 * The ceiling one actor faces in one space.
 *
 * Mirrors `spaceCeilingFor` in @grove/policy, which is not exported. The rule is
 * one line and is stated in the doc comment on `SpacePolicy`: members sit at the
 * open ceiling, everyone else at the space's own policy. The intersection itself
 * is NOT re-implemented — see `effectiveIn`.
 */
export function ceilingFor(space: SpaceStanding): SpacePolicy {
  return space.isMember ? OPEN_SPACE_POLICY : spacePolicyForPreset(space.preset);
}

/** effective = actor AND space, via the kernel's own composition rule. */
export function effectiveIn(granted: PermissionPolicy, space: SpaceStanding): PermissionPolicy {
  return intersectSpacePolicy(granted, ceilingFor(space));
}

/** The capabilities the owner granted that this space takes away again. */
export function blockedBySpace(
  granted: PermissionPolicy,
  effective: PermissionPolicy,
): Capability[] {
  return (["listenToHumans", "listenToAgents", "speakToHumans", "speakToAgents"] as const).filter(
    (cap) => granted[cap] && !effective[cap],
  );
}

/**
 * The exact condition behind `SPEECH_CONSEQUENCE.silenced_by_space` — "they can
 * speak elsewhere, but this space does not let them reply here". It is about
 * having no mouth LEFT, not about losing one of two.
 */
export function isSilencedBySpace(
  granted: PermissionPolicy,
  effective: PermissionPolicy,
): boolean {
  const grantedMouth = granted.speakToAgents || granted.speakToHumans;
  const effectiveMouth = effective.speakToAgents || effective.speakToHumans;
  return grantedMouth && !effectiveMouth;
}

/**
 * A policy, in the badge vocabulary.
 *
 * Mirror of `badges()` in @grove/policy, which `apps/web` cannot import (it is
 * not a declared dependency of the app, and `GET /api/v1/agents/:id` does not
 * return badges the way `nearby` does). Kept to the agent half of that function
 * and to the same order, so the chips Studio previews are the chips the room
 * will actually draw. If the studio route ever returns `badges`, delete this and
 * pass them through instead.
 */
export function badgesOfPolicy(
  policy: PermissionPolicy,
  claimState?: ClaimState,
): PermissionBadge[] {
  if (claimState === "pending") return ["unclaimed"];
  const out: PermissionBadge[] = [];
  if (!policy.listenToHumans) out.push("cannot_hear_humans");
  if (!policy.listenToAgents) out.push("cannot_hear_agents");
  const { speakToAgents, speakToHumans } = policy;
  if (!speakToAgents && !speakToHumans) {
    out.push("listen_only");
    return out;
  }
  out.push(speakToAgents ? "speaks_to_agents" : "silent_to_agents");
  out.push(speakToHumans ? "speaks_to_humans" : "silent_to_humans");
  return out;
}

/**
 * The one state worth a sentence, for a policy rather than for a badge list.
 * Reduction stays in `speechState()` so Studio, the map and the room view can
 * never disagree about which sentence a state gets.
 */
export function speechStateOfPolicy(
  granted: PermissionPolicy,
  opts: { space?: SpaceStanding; claimState?: ClaimState } = {},
): SpeechState | null {
  const effective = opts.space ? effectiveIn(granted, opts.space) : granted;
  return speechState(badgesOfPolicy(granted, opts.claimState), {
    silencedBySpace: isSilencedBySpace(granted, effective),
  });
}
