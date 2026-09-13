import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  OPEN_SPACE_POLICY,
  resolveCeiling,
  roomAdmitsNonMembers,
  roomAdmitsVisitors,
  spacePolicyForPreset,
  type CeilingLayers,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
  type SpacePolicy,
  type SpacePolicyPreset,
} from "@grove/protocol";
import { authorize } from "../src/authorize.js";

/**
 * SPC-07 (per-room override) + SPC-10 (member vs non-member ceilings).
 *
 * The precedence this file pins down, stated once in @grove/protocol
 * `resolveCeiling`:
 *
 *     nonMember = room.roomPolicy ?? space.policy ?? OPEN
 *     member    = (room.roomMemberPolicy ?? space.memberPolicy ?? OPEN) OR nonMember
 *     effective = actor AND (isMember ? member : nonMember)
 *
 * The ORACLE below re-states that rule independently in plain code, and the
 * matrix walks every actor matrix x membership x room override x space preset
 * x member-ceiling layer, asserting the kernel's answer AND its attribution.
 */

const quota: QuotaSnapshot = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const baseRoom = {
  id: "sp:lobby",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 40,
};

const CAPS = ["speakToAgents", "speakToHumans", "listenToAgents", "listenToHumans"] as const;
type Cap = (typeof CAPS)[number];

const LISTEN_ONLY: SpacePolicy = { speakToAgents: false, speakToHumans: false, listenToAgents: true, listenToHumans: true };
const NOTHING: SpacePolicy = spacePolicyForPreset("private");

function allPolicies(): PermissionPolicy[] {
  const out: PermissionPolicy[] = [];
  for (const speakToAgents of [false, true])
    for (const speakToHumans of [false, true])
      for (const listenToAgents of [false, true])
        for (const listenToHumans of [false, true])
          out.push({ speakToAgents, speakToHumans, listenToAgents, listenToHumans });
  return out;
}

const SPACE_PRESETS: Array<SpacePolicyPreset | null> = [null, "private", "public_view", "public_write"];
const ROOM_PRESETS: Array<SpacePolicyPreset | null> = [null, "private", "public_view", "public_write"];
const MEMBER_LAYERS: Array<SpacePolicy | null> = [null, LISTEN_ONLY, NOTHING];

function layersFor(o: {
  space: SpacePolicyPreset | null;
  room: SpacePolicyPreset | null;
  spaceMember: SpacePolicy | null;
  roomMember: SpacePolicy | null;
}): CeilingLayers {
  const l: CeilingLayers = {};
  if (o.space) l.policy = spacePolicyForPreset(o.space);
  if (o.room) l.roomPolicy = spacePolicyForPreset(o.room);
  if (o.spaceMember) l.memberPolicy = o.spaceMember;
  if (o.roomMember) l.roomMemberPolicy = o.roomMember;
  return l;
}

/** Independent restatement of the precedence rule. Returns the ceiling's value and who set it. */
function oracle(l: CeilingLayers, isMember: boolean, cap: Cap): { allowed: boolean; scope: "room" | "space" | null } {
  const nonMemberScope = l.roomPolicy ? "room" : l.policy ? "space" : null;
  const nonMemberValue = l.roomPolicy ? l.roomPolicy[cap] : l.policy ? l.policy[cap] : true;
  if (!isMember) return { allowed: nonMemberValue, scope: nonMemberScope };
  const memberScope = l.roomMemberPolicy ? "room" : l.memberPolicy ? "space" : null;
  const memberValue = l.roomMemberPolicy ? l.roomMemberPolicy[cap] : l.memberPolicy ? l.memberPolicy[cap] : true;
  return { allowed: memberValue || nonMemberValue, scope: memberScope };
}

function agentSender(policy: PermissionPolicy, isSpaceMember: boolean): PolicyContext["sender"] {
  return {
    id: "agt_sender",
    kind: "agent",
    ownerHumanId: "hum_owner",
    claimState: "claimed",
    policy,
    privacy: DEFAULT_AGENT_PRIVACY,
    isSpaceMember,
  };
}

function recipient(kind: "agent" | "human", opts: { policy?: PermissionPolicy; isSpaceMember: boolean }): PolicyContext["recipients"][number] {
  return kind === "agent"
    ? {
        id: "agt_recipient",
        kind: "agent",
        ownerHumanId: "hum_other",
        policy: opts.policy ?? DEFAULT_AGENT_POLICY,
        privacy: DEFAULT_AGENT_PRIVACY,
        blocked: false,
        mutedByRecipient: false,
        isSpaceMember: opts.isSpaceMember,
      }
    : {
        id: "hum_recipient",
        kind: "human",
        lurk: false,
        privacy: { overhearableByAgents: true },
        blocked: false,
        mutedByRecipient: false,
        isSpaceMember: opts.isSpaceMember,
      };
}

function each(fn: (o: {
  space: SpacePolicyPreset | null;
  room: SpacePolicyPreset | null;
  spaceMember: SpacePolicy | null;
  roomMember: SpacePolicy | null;
  layers: CeilingLayers;
  label: string;
}) => void): number {
  let n = 0;
  for (const space of SPACE_PRESETS)
    for (const room of ROOM_PRESETS)
      for (const spaceMember of MEMBER_LAYERS)
        for (const roomMember of MEMBER_LAYERS) {
          const layers = layersFor({ space, room, spaceMember, roomMember });
          const label = `space=${space} room=${room} spaceMember=${JSON.stringify(spaceMember)} roomMember=${JSON.stringify(roomMember)}`;
          fn({ space, room, spaceMember, roomMember, layers, label });
          n += 1;
        }
  return n;
}

// ---------------------------------------------------------------------------
// 1. resolveCeiling against the oracle
// ---------------------------------------------------------------------------

describe("resolveCeiling — the precedence rule", () => {
  it("matches the oracle for every layer combination, both memberships, every capability", () => {
    const n = each(({ layers, label }) => {
      for (const isMember of [false, true]) {
        const got = resolveCeiling(layers, isMember);
        expect(got.membership, label).toBe(isMember ? "member" : "non_member");
        for (const cap of CAPS) {
          const want = oracle(layers, isMember, cap);
          expect(got.ceiling[cap], `${label} member=${isMember} ${cap}`).toBe(want.allowed);
          expect(got.scope, `${label} member=${isMember}`).toBe(want.scope);
        }
      }
    });
    expect(n).toBe(4 * 4 * 3 * 3);
  });

  it("no layers at all is the open ceiling for both audiences (today's kernel)", () => {
    expect(resolveCeiling(undefined, false)).toEqual({ ceiling: OPEN_SPACE_POLICY, scope: null, membership: "non_member" });
    expect(resolveCeiling({}, true)).toEqual({ ceiling: OPEN_SPACE_POLICY, scope: null, membership: "member" });
  });

  it("membership only ever adds: member ceiling is a superset of the non-member ceiling in the same room", () => {
    each(({ layers, label }) => {
      const m = resolveCeiling(layers, true).ceiling;
      const nm = resolveCeiling(layers, false).ceiling;
      for (const cap of CAPS) if (nm[cap]) expect(m[cap], `${label} ${cap}`).toBe(true);
    });
  });

  it("a room override replaces the space value for its audience only", () => {
    const l: CeilingLayers = { policy: NOTHING, roomPolicy: spacePolicyForPreset("public_view"), memberPolicy: LISTEN_ONLY };
    // Non-member: the room's public_view, not the space's private.
    expect(resolveCeiling(l, false)).toMatchObject({ scope: "room", ceiling: spacePolicyForPreset("public_view") });
    // Member: no room member override, so the SPACE member ceiling still applies.
    expect(resolveCeiling(l, true)).toMatchObject({ scope: "space", ceiling: LISTEN_ONLY });
  });
});

// ---------------------------------------------------------------------------
// 2. The full matrix through authorize()
// ---------------------------------------------------------------------------

describe("authorize — actor x membership x room override x space preset x member ceilings", () => {
  it("emit (whisper, one capability at a time) equals actor AND oracle, with true attribution", () => {
    let checked = 0;
    each(({ layers, label }) => {
      for (const actor of allPolicies()) {
        for (const isMember of [false, true]) {
          for (const target of ["agent", "human"] as const) {
            const cap: Cap = target === "agent" ? "speakToAgents" : "speakToHumans";
            const res = authorize({
              sender: agentSender(actor, isMember),
              recipients: [recipient(target, { isSpaceMember: true })],
              channel: "whisper",
              requestedTargetId: target === "agent" ? "agt_recipient" : "hum_recipient",
              room: { ...baseRoom, ...layers },
              quota,
              isOwnerChannel: false,
            });
            const want = oracle(layers, isMember, cap);
            const where = `${label} member=${isMember} actor=${JSON.stringify(actor)} ${cap}`;
            expect(res.emit.allow, where).toBe(actor[cap] && want.allowed);
            if (!res.emit.allow) {
              expect(res.emit.code, where).toBe("PERMISSION_DENIED");
              expect(res.emit.capability, where).toBe(cap);
              if (!actor[cap]) {
                expect(res.emit.source, where).toBe("actor");
                expect(res.emit.subject, where).toBe("sender");
                expect(res.emit.membership, where).toBeUndefined();
              } else {
                expect(res.emit.source, where).toBe(want.scope);
                expect(res.emit.membership, where).toBe(isMember ? "member" : "non_member");
                expect(res.emit.subject, where).toBeUndefined();
              }
            }
            checked += 1;
          }
        }
      }
    });
    expect(checked).toBe(4 * 4 * 3 * 3 * 16 * 2 * 2);
  });

  it("delivery (recipient's ear) equals recipient actor AND oracle, with true attribution", () => {
    let checked = 0;
    each(({ layers, label }) => {
      for (const rp of allPolicies()) {
        for (const isMember of [false, true]) {
          // A human sender is at the ceiling only; make them a member of a room
          // with no member layers restricting speech so only the ear is tested.
          const res = authorize({
            sender: { id: "hum_sender", kind: "human", privacy: { overhearableByAgents: true }, isSpaceMember: true },
            recipients: [recipient("agent", { policy: rp, isSpaceMember: isMember })],
            channel: "room_say",
            room: { ...baseRoom, ...layers },
            quota,
            isOwnerChannel: false,
          });
          if (!res.emit.allow) continue; // sender's own ceiling closed every mouth; covered by the emit test
          const d = res.deliveries[0]!.decision;
          const want = oracle(layers, isMember, "listenToHumans");
          const where = `${label} recipientMember=${isMember} rp=${JSON.stringify(rp)}`;
          if (!rp.listenToHumans) {
            expect(d, where).toMatchObject({ allow: false, capability: "listenToHumans", source: "actor", subject: "recipient" });
          } else if (!want.allowed) {
            expect(d, where).toMatchObject({
              allow: false,
              capability: "listenToHumans",
              source: want.scope,
              membership: isMember ? "member" : "non_member",
            });
            expect(d.subject, where).toBeUndefined();
          } else if (!d.allow) {
            // Only the SENDER's mouth may refuse now, and it must say so.
            expect(d.capability, where).toBe("speakToAgents");
            expect(d.source, where).not.toBe("actor");
          }
          checked += 1;
        }
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("safety: no layer combination ever grants a capability the actor's own matrix lacks", () => {
    each(({ layers, label }) => {
      for (const actor of allPolicies()) {
        for (const isMember of [false, true]) {
          for (const target of ["agent", "human"] as const) {
            const cap: Cap = target === "agent" ? "speakToAgents" : "speakToHumans";
            const res = authorize({
              sender: agentSender(actor, isMember),
              recipients: [recipient(target, { isSpaceMember: true })],
              channel: "whisper",
              requestedTargetId: target === "agent" ? "agt_recipient" : "hum_recipient",
              room: { ...baseRoom, ...layers },
              quota,
              isOwnerChannel: false,
            });
            if (res.emit.allow) expect(actor[cap], `${label} ${cap}`).toBe(true);
          }
        }
      }
    });
  });

  it("the owner channel still bypasses every layer", () => {
    const res = authorize({
      sender: agentSender({ speakToAgents: false, speakToHumans: false, listenToAgents: false, listenToHumans: false }, false),
      recipients: [recipient("human", { isSpaceMember: false })],
      channel: "owner_reply",
      room: { ...baseRoom, policy: NOTHING, roomPolicy: NOTHING, memberPolicy: NOTHING, roomMemberPolicy: NOTHING },
      quota,
      isOwnerChannel: true,
    });
    expect(res.emit.allow).toBe(true);
    expect(res.deliveries[0]?.decision.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The named scenarios an owner actually sets up
// ---------------------------------------------------------------------------

function say(o: {
  layers: CeilingLayers;
  senderMember: boolean;
  recipientMember?: boolean;
}) {
  return authorize({
    sender: { id: "hum_sender", kind: "human", privacy: { overhearableByAgents: true }, isSpaceMember: o.senderMember },
    recipients: [recipient("human", { isSpaceMember: o.recipientMember ?? true })],
    channel: "room_say",
    room: { ...baseRoom, ...o.layers },
    quota,
    isOwnerChannel: false,
  });
}

describe("named scenarios", () => {
  const lobbyView: CeilingLayers = { policy: NOTHING, roomPolicy: spacePolicyForPreset("public_view") };
  const lobbyWrite: CeilingLayers = { policy: NOTHING, roomPolicy: spacePolicyForPreset("public_write") };
  const closedRoom: CeilingLayers = { policy: OPEN_SPACE_POLICY, roomPolicy: NOTHING };

  it("public_view lobby in a private space: a visitor hears, but cannot speak — and the ROOM is named", () => {
    const res = say({ layers: lobbyView, senderMember: false });
    expect(res.emit).toMatchObject({ allow: false, source: "room", membership: "non_member", capability: "speakToHumans" });
    expect(res.emit.reason).toBe("This room does not grant non-members speakToHumans.");
    const heard = say({ layers: lobbyView, senderMember: true, recipientMember: false });
    expect(heard.deliveries[0]?.decision.allow).toBe(true);
  });

  it("public_write lobby in a private space: a visitor may speak", () => {
    expect(say({ layers: lobbyWrite, senderMember: false }).emit.allow).toBe(true);
  });

  it("the private space's OTHER rooms stay dark to the same visitor", () => {
    const res = say({ layers: { policy: NOTHING }, senderMember: false });
    expect(res.emit).toMatchObject({ allow: false, source: "space", membership: "non_member" });
    expect(res.emit.reason).toBe("This space does not grant speakToHumans.");
  });

  it("a closed room in a public space: non-members refused by the room, members untouched", () => {
    expect(say({ layers: closedRoom, senderMember: false }).emit).toMatchObject({ allow: false, source: "room", membership: "non_member" });
    const heard = say({ layers: closedRoom, senderMember: true, recipientMember: false });
    expect(heard.emit.allow).toBe(true);
    expect(heard.deliveries[0]?.decision).toMatchObject({ allow: false, source: "room", membership: "non_member", capability: "listenToHumans" });
  });

  it("SPC-10: a space whose members listen but do not speak names the MEMBER ceiling", () => {
    const res = say({ layers: { policy: NOTHING, memberPolicy: LISTEN_ONLY }, senderMember: true });
    expect(res.emit).toMatchObject({ allow: false, source: "space", membership: "member", capability: "speakToHumans" });
    expect(res.emit.reason).toBe("This space does not grant members speakToHumans.");
  });

  it("SPC-10 at room grain: a members-listen-only room inside an open-to-members space", () => {
    const res = say({ layers: { policy: spacePolicyForPreset("public_view"), roomMemberPolicy: LISTEN_ONLY }, senderMember: true });
    expect(res.emit).toMatchObject({ allow: false, source: "room", membership: "member" });
    expect(res.emit.reason).toBe("This room does not grant members speakToHumans.");
  });

  it("a room member override replaces the space member ceiling (it can re-open a room for members)", () => {
    const res = say({ layers: { policy: NOTHING, memberPolicy: LISTEN_ONLY, roomMemberPolicy: OPEN_SPACE_POLICY }, senderMember: true });
    expect(res.emit.allow).toBe(true);
  });

  it("members are never below visitors: listen-only members in a public_write lobby may still speak", () => {
    const res = say({ layers: { policy: NOTHING, memberPolicy: NOTHING, roomPolicy: OPEN_SPACE_POLICY }, senderMember: true });
    expect(res.emit.allow).toBe(true);
  });
});

describe("roomAdmitsNonMembers — only an explicit, non-private room override opens a door", () => {
  it("inherit and private admit nobody; public_view and public_write admit", () => {
    expect(roomAdmitsNonMembers(null)).toBe(false);
    expect(roomAdmitsNonMembers(undefined)).toBe(false);
    expect(roomAdmitsNonMembers("private")).toBe(false);
    expect(roomAdmitsNonMembers("public_view")).toBe(true);
    expect(roomAdmitsNonMembers("public_write")).toBe(true);
  });
});

describe("roomAdmitsVisitors — the door rule: a room override replaces the space", () => {
  const view = spacePolicyForPreset("public_view");
  const write = spacePolicyForPreset("public_write");
  const priv = spacePolicyForPreset("private");
  it("an inheriting room follows its space: public presets admit, private does not", () => {
    expect(roomAdmitsVisitors(null, view)).toBe(true);
    expect(roomAdmitsVisitors(null, write)).toBe(true);
    expect(roomAdmitsVisitors(null, priv)).toBe(false);
    expect(roomAdmitsVisitors(undefined, undefined)).toBe(false);
  });
  it("a private room stays closed inside a public space; a lobby opens on a private plot", () => {
    expect(roomAdmitsVisitors("private", write)).toBe(false);
    expect(roomAdmitsVisitors("private", view)).toBe(false);
    expect(roomAdmitsVisitors("public_view", priv)).toBe(true);
    expect(roomAdmitsVisitors("public_write", priv)).toBe(true);
  });
});
