import {
  resolveCeiling,
  roomAdmitsNonMembers,
  spacePolicyForPreset,
  type CeilingScope,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";

/**
 * SPC-07 / SPC-10 for the OWNER, one screen before anyone is refused: "if I set
 * this room like this, what does a member get, and what does a visitor get?"
 *
 * Nothing here decides anything. Both audiences are resolved by
 * `resolveCeiling` — the same function `authorize()` calls — and this module
 * only turns the answer into a sentence. Precedence is documented there.
 */

export interface RoomAccessInput {
  spacePreset: SpacePolicyPreset;
  spaceMemberPolicy?: SpacePolicy | null;
  roomPreset?: SpacePolicyPreset | null;
  roomMemberPolicy?: SpacePolicy | null;
  /** The civic core narrows nobody and admits everybody. */
  isCivicCore?: boolean;
}

export interface AudienceView {
  ceiling: SpacePolicy;
  /** Which setting decided it: this room's own, the space's, or nothing narrowing. */
  decidedBy: CeilingScope | null;
  /** One line, consequence first, no flag names. */
  line: string;
}

export interface RoomAccessView {
  member: AudienceView;
  visitor: AudienceView & { mayEnter: boolean };
  /** True when this room will be listed publicly as a way in, even on a private plot. */
  isLobby: boolean;
}

/** A ceiling as what someone standing under it can do. */
export function ceilingPhrase(c: SpacePolicy): string {
  const hears = c.listenToHumans && c.listenToAgents ? "hear everyone" : c.listenToHumans ? "hear people only" : c.listenToAgents ? "hear agents only" : null;
  const speaks = c.speakToHumans && c.speakToAgents ? "speak to everyone" : c.speakToHumans ? "speak to people only" : c.speakToAgents ? "speak to agents only" : null;
  if (hears && speaks) return `can ${hears} and ${speaks}`;
  if (hears) return `can ${hears}, but not speak`;
  if (speaks) return `can ${speaks}, but hear nothing`;
  return "can neither hear nor speak";
}

function layers(input: RoomAccessInput) {
  return {
    policy: spacePolicyForPreset(input.spacePreset),
    ...(input.spaceMemberPolicy ? { memberPolicy: input.spaceMemberPolicy } : {}),
    ...(input.roomPreset ? { roomPolicy: spacePolicyForPreset(input.roomPreset) } : {}),
    ...(input.roomMemberPolicy ? { roomMemberPolicy: input.roomMemberPolicy } : {}),
  };
}

export function describeRoomAccess(input: RoomAccessInput): RoomAccessView {
  if (input.isCivicCore) {
    const open = spacePolicyForPreset("public_write");
    const line = "Everyone is a member of the commons: they can hear everyone and speak to everyone.";
    return {
      member: { ceiling: open, decidedBy: null, line },
      visitor: { ceiling: open, decidedBy: null, line, mayEnter: true },
      isLobby: false,
    };
  }
  const l = layers(input);
  const m = resolveCeiling(l, true);
  const v = resolveCeiling(l, false);
  const mayEnter = roomAdmitsNonMembers(input.roomPreset);
  return {
    member: { ceiling: m.ceiling, decidedBy: m.scope, line: `Members ${ceilingPhrase(m.ceiling)}.` },
    visitor: {
      ceiling: v.ceiling,
      decidedBy: v.scope,
      mayEnter,
      // Only an opened room admits a non-member at all; saying what they could
      // do "if they were here" about a room they cannot enter would be a lie by
      // implication.
      line: mayEnter
        ? `Visitors can walk in and ${ceilingPhrase(v.ceiling).replace(/^can /, "")}.`
        : "Visitors cannot come in. Only members enter this room.",
    },
    isLobby: mayEnter,
  };
}
