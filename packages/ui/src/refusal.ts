import { SPEECH_RECOURSE } from "./consequences";

/**
 * §5.5, the other half. `consequences.ts` explains why someone will not answer
 * you BEFORE you speak; this explains why what you just said went nowhere.
 *
 * The input is the error body a refused write returns, which is a flattened
 * `PolicyDecision`: `code`, plus (on `PERMISSION_DENIED`) `capability` in its
 * wire spelling, `source` and `subject`.
 *
 * The rule these sentences exist to enforce: a denial must name the RIGHT
 * person to take it up with. `source: "space"` and `source: "actor"` lead to
 * different doors, and the nameplate's "owned by @x" byline points at the wrong
 * one whenever the space is what refused.
 */

export type RefusalSource = "actor" | "space";
export type RefusalSubject = "sender" | "recipient";

/** Capability names as `capabilityWire()` spells them on the wire. */
export type CapabilityWire =
  | "speak_to_agents"
  | "speak_to_humans"
  | "listen_to_agents"
  | "listen_to_humans";

export interface RefusalInput {
  code?: string;
  /** Wire spelling, e.g. `speak_to_humans`. */
  capability?: string;
  source?: RefusalSource;
  subject?: RefusalSubject;
  /** The server's own prose. Used only as a last resort. */
  message?: string;
  hint?: string;
  /** The kind of actor that tried to speak. Only used for the §5.1 inference. */
  senderKind?: "human" | "agent";
}

export interface Refusal {
  /** One line, second person, saying what happened. */
  headline: string;
  /** Where to go about it, or `null` when there is nowhere to go. */
  recourse: string | null;
  /**
   * How we know who refused.
   * - `reported`  — the API said so (`source`), or the code is self-explaining.
   * - `inferred`  — derived the way the kernel derives it; see below.
   * - `unknown`   — a `PERMISSION_DENIED` with no `source`. We refuse to guess.
   */
  attribution: "reported" | "inferred" | "unknown";
  /** The server's hint, passed through when it adds something we do not say. */
  hint?: string;
}

/** Shown alongside an `unknown` attribution so the gap is visible, not papered over. */
export const UNATTRIBUTED_NOTE =
  "This refusal did not say whether their settings or this space stopped it.";

const NON_PERMISSION: Record<string, { headline: string; recourse: string | null }> = {
  BLOCKED: {
    headline: "One of you has blocked the other, so nothing you say reaches them.",
    recourse: "Unblock them, or ask them to unblock you.",
  },
  MUTED: {
    headline: "They have muted you, so this did not reach them.",
    recourse: "Only they can lift that.",
  },
  NOT_ADDRESSABLE: {
    headline: "They are not accepting messages addressed to them.",
    recourse: SPEECH_RECOURSE.listen_only,
  },
  ROOM_FORBIDDEN: {
    headline: "You are not allowed to speak in this room.",
    recourse: SPEECH_RECOURSE.silenced_by_space,
  },
  ROOM_FULL: {
    headline: "This room is full.",
    recourse: "Wait for a seat, or try another room.",
  },
  UNCLAIMED: {
    headline: "Unclaimed agents cannot speak in public.",
    recourse: SPEECH_RECOURSE.unclaimed,
  },
  RATE_LIMITED: {
    headline: "You have said too much too quickly, so this one was dropped.",
    recourse: "Wait a moment and say it again.",
  },
  NOT_FOUND: {
    headline: "That room or person is not here any more.",
    recourse: null,
  },
};

/** subject: "recipient" — their ear or their mouth is what closed. */
const RECIPIENT_HEADLINE: Record<CapabilityWire, string> = {
  listen_to_humans: "They do not listen to people, so this did not reach them.",
  listen_to_agents: "They do not listen to agents, so this did not reach them.",
  speak_to_humans: "They cannot reply to people, so there was nothing to deliver.",
  speak_to_agents: "They cannot reply to other agents, so there was nothing to deliver.",
};

/** subject: "sender" — YOUR stored setting is what refused, whatever ear it names. */
const SENDER_HEADLINE: Record<CapabilityWire, string> = {
  listen_to_humans: "Your own privacy setting stopped this, not theirs.",
  listen_to_agents: "Your own privacy setting stopped this, not theirs.",
  speak_to_humans: "Your own settings do not let you speak to people.",
  speak_to_agents: "Your own settings do not let you speak to agents.",
};

const SPACE_HEADLINE: Record<CapabilityWire, string> = {
  speak_to_humans: "This space does not let that be said to people here.",
  speak_to_agents: "This space does not let that be said to agents here.",
  listen_to_humans: "This space does not let people hear that here.",
  listen_to_agents: "This space does not let agents hear that here.",
};

function wire(capability: string | undefined): CapabilityWire | null {
  return capability === "speak_to_humans" ||
    capability === "speak_to_agents" ||
    capability === "listen_to_humans" ||
    capability === "listen_to_agents"
    ? capability
    : null;
}

export function describeRefusal(input: RefusalInput): Refusal {
  const hint = input.hint;
  const code = input.code ?? "PERMISSION_DENIED";

  if (code !== "PERMISSION_DENIED") {
    const known = NON_PERMISSION[code];
    // An unrecognised code still has to say something true. The server's own
    // message is the only honest fallback; inventing recourse would be worse
    // than offering none.
    return known
      ? { ...known, attribution: "reported", hint }
      : {
          headline: input.message ?? "That was refused.",
          recourse: null,
          attribution: "reported",
          hint,
        };
  }

  const cap = wire(input.capability);

  if (input.source === "space") {
    return {
      headline: (cap && SPACE_HEADLINE[cap]) ?? "This space does not allow that here.",
      // The whole point of the split: the owner is the wrong door.
      recourse: SPEECH_RECOURSE.silenced_by_space,
      attribution: "reported",
      hint,
    };
  }

  if (input.source === "actor") {
    if (input.subject === "sender") {
      return {
        headline: (cap && SENDER_HEADLINE[cap]) ?? "Your own settings stopped this, not theirs.",
        recourse: "Change it in your own settings.",
        attribution: "reported",
        hint,
      };
    }
    return {
      headline: (cap && RECIPIENT_HEADLINE[cap]) ?? "Their settings stopped this.",
      recourse: SPEECH_RECOURSE.listen_only,
      attribution: "reported",
      hint,
    };
  }

  // No `source`. One inference is available, and it is the kernel's own
  // (@grove/protocol policy.ts): humans carry no capability matrix (§5.1), so
  // their actor half is implicitly all-true and a SPEAK capability they were
  // refused can only have been removed by the space. Anything else is a guess,
  // and a guess here sends someone to the wrong door.
  if (input.senderKind === "human" && (cap === "speak_to_humans" || cap === "speak_to_agents")) {
    return {
      headline: SPACE_HEADLINE[cap],
      recourse: SPEECH_RECOURSE.silenced_by_space,
      attribution: "inferred",
      hint,
    };
  }

  return {
    headline: input.message ?? "That was refused.",
    recourse: null,
    attribution: "unknown",
    hint,
  };
}
