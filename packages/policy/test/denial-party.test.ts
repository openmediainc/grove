import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  spacePolicyForPreset,
  type CeilingLayers,
  type PermissionPolicy,
  type PolicyContext,
  type QuotaSnapshot,
} from "@grove/protocol";
import { authorize, explainCapabilities } from "../src/index.js";

/**
 * #62 — `party` names WHICH SIDE of the act a refusal is about, including the
 * ceiling refusals `subject` deliberately stays silent on. The property that
 * makes it load-bearing: open everything the OTHER party has (matrix, privacy,
 * membership) and the decision does not move; open everything the NAMED party
 * has and it does.
 *
 * Swept across the sixteen legal matrices for BOTH actors, both kinds each,
 * every ceiling layer shape and both memberships.
 */

const quota: QuotaSnapshot = { roomSayRemaining: 8, roomSayGapOk: true, writeRemaining: 30, roomWindowCount: 0 };
const base = { id: "r1", kind: "public" as const, allowsRoomSay: true, allowsWhisper: true, sayLimitPerMin: null, capacity: 80 };

const SIXTEEN: PermissionPolicy[] = [];
for (let i = 0; i < 16; i++) {
  SIXTEEN.push({ speakToAgents: !!(i & 1), speakToHumans: !!(i & 2), listenToAgents: !!(i & 4), listenToHumans: !!(i & 8) });
}

const LISTEN_ONLY = spacePolicyForPreset("public_view");
const LAYERS: Array<{ name: string; layers?: CeilingLayers }> = [
  { name: "commons" },
  { name: "private", layers: { policy: spacePolicyForPreset("private") } },
  { name: "public_view", layers: { policy: LISTEN_ONLY } },
  { name: "public_write", layers: { policy: spacePolicyForPreset("public_write") } },
  { name: "listen-only members", layers: { policy: spacePolicyForPreset("private"), memberPolicy: LISTEN_ONLY } },
  { name: "public_view room in private space", layers: { policy: spacePolicyForPreset("private"), roomPolicy: LISTEN_ONLY } },
  {
    name: "private room with deaf members",
    layers: {
      policy: spacePolicyForPreset("public_write"),
      roomPolicy: spacePolicyForPreset("private"),
      roomMemberPolicy: { speakToAgents: true, speakToHumans: true, listenToAgents: false, listenToHumans: false },
    },
  },
];

type Kind = "agent" | "human";

function sender(kind: Kind, policy: PermissionPolicy, member: boolean, overhearable = true): PolicyContext["sender"] {
  return kind === "agent"
    ? {
        id: "agt_s",
        kind,
        ownerHumanId: "hum_o",
        claimState: "claimed",
        policy,
        privacy: { ...DEFAULT_AGENT_PRIVACY, overhearableByAgents: overhearable, overhearableByHumans: overhearable },
        isSpaceMember: member,
      }
    : { id: "hum_s", kind, privacy: { overhearableByAgents: overhearable }, isSpaceMember: member };
}

function recipient(kind: Kind, policy: PermissionPolicy, member: boolean): PolicyContext["recipients"][number] {
  return kind === "agent"
    ? { id: "agt_r", kind, ownerHumanId: "hum_x", policy, privacy: DEFAULT_AGENT_PRIVACY, blocked: false, mutedByRecipient: false, isSpaceMember: member }
    : { id: "hum_r", kind, lurk: false, privacy: { overhearableByAgents: true }, blocked: false, mutedByRecipient: false, isSpaceMember: member };
}

function judge(ctx: PolicyContext) {
  const res = authorize(ctx);
  return res.emit.allow ? res.deliveries[0]!.decision : res.emit;
}

describe("PolicyDecision.party — sender vs recipient across the 16 combos", () => {
  it("names the side whose settings or ceiling decided, and only that side is load-bearing", () => {
    const counts = { sender: 0, recipient: 0, ceilingSender: 0, ceilingRecipient: 0 };
    for (const channel of ["room_say", "whisper"] as const) {
      for (const sk of ["agent", "human"] as Kind[]) {
        for (const rk of ["agent", "human"] as Kind[]) {
          for (const { name, layers } of LAYERS) {
            for (const sm of [false, true]) {
              for (const rm of [false, true]) {
                for (const sp of sk === "agent" ? SIXTEEN : [DEFAULT_AGENT_POLICY]) {
                  for (const rp of rk === "agent" ? SIXTEEN : [DEFAULT_AGENT_POLICY]) {
                    const r = recipient(rk, rp, rm);
                    const ctx: PolicyContext = {
                      sender: sender(sk, sp, sm),
                      recipients: [r],
                      channel,
                      requestedTargetId: r.id,
                      room: { ...base, ...(layers ?? {}) },
                      quota,
                      isOwnerChannel: false,
                    };
                    const d = judge(ctx);
                    const where = `${channel} ${sk}->${rk} ${name} sm=${sm} rm=${rm} sp=${JSON.stringify(sp)} rp=${JSON.stringify(rp)}: ${d.reason}`;
                    if (!d.source) {
                      expect(d, where).not.toHaveProperty("party");
                      continue;
                    }
                    expect(["sender", "recipient"], where).toContain(d.party);
                    if (d.source === "actor") expect(d.subject, where).toBe(d.party);
                    else expect(d, where).not.toHaveProperty("subject");

                    const openSender: PolicyContext = { ...ctx, sender: sender(sk, DEFAULT_AGENT_POLICY, true) };
                    const openRecipient: PolicyContext = { ...ctx, recipients: [recipient(rk, DEFAULT_AGENT_POLICY, true)] };
                    if (d.party === "sender") {
                      expect(judge(openRecipient), `opening the recipient moved a sender denial: ${where}`).toEqual(d);
                      // A MEMBER ceiling holds however open the actor is, so it is
                      // only the other party's independence that can be checked there.
                      if (d.membership !== "member") {
                        expect(judge(openSender), `the sender was not load-bearing: ${where}`).not.toEqual(d);
                      }
                      counts.sender += 1;
                      if (d.source !== "actor") counts.ceilingSender += 1;
                    } else {
                      expect(judge(openSender), `opening the sender moved a recipient denial: ${where}`).toEqual(d);
                      if (d.membership !== "member") {
                        expect(judge(openRecipient), `the recipient was not load-bearing: ${where}`).not.toEqual(d);
                      }
                      counts.recipient += 1;
                      if (d.source !== "actor") counts.ceilingRecipient += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // No arm is vacuous: both sides are blamed, and both through a ceiling.
    expect(counts.sender).toBeGreaterThan(0);
    expect(counts.recipient).toBeGreaterThan(0);
    expect(counts.ceilingSender).toBeGreaterThan(0);
    expect(counts.ceilingRecipient).toBeGreaterThan(0);
  });

  it("the gap it closes: a visitor who cannot speak vs a visitor who cannot hear, same source", () => {
    const view = { ...base, policy: LISTEN_ONLY };
    const mute = judge({
      sender: sender("human", DEFAULT_AGENT_POLICY, false),
      recipients: [recipient("human", DEFAULT_AGENT_POLICY, true)],
      channel: "room_say",
      room: view,
      quota,
      isOwnerChannel: false,
    });
    const deaf = judge({
      sender: sender("agent", DEFAULT_AGENT_POLICY, true),
      recipients: [recipient("human", DEFAULT_AGENT_POLICY, false)],
      channel: "room_say",
      room: { ...base, policy: spacePolicyForPreset("private") },
      quota,
      isOwnerChannel: false,
    });
    expect(mute).toMatchObject({ source: "space", membership: "non_member", party: "sender" });
    expect(deaf).toMatchObject({ source: "space", membership: "non_member", party: "recipient" });
  });

  it("NOT_ADDRESSABLE is always the recipient's side; BLOCKED and ALLOW carry no party", () => {
    const lurker = { ...recipient("human", DEFAULT_AGENT_POLICY, true), lurk: true };
    const d = authorize({ sender: sender("agent", DEFAULT_AGENT_POLICY, true), recipients: [lurker], channel: "whisper", requestedTargetId: lurker.id, room: base, quota, isOwnerChannel: false }).emit;
    expect(d).toMatchObject({ code: "NOT_ADDRESSABLE", party: "recipient" });
    const blocked = { ...recipient("human", DEFAULT_AGENT_POLICY, true), blocked: true };
    const b = authorize({ sender: sender("agent", DEFAULT_AGENT_POLICY, true), recipients: [blocked], channel: "room_say", room: base, quota, isOwnerChannel: false });
    expect(b.emit).not.toHaveProperty("party");
    expect(b.deliveries[0]!.decision).not.toHaveProperty("party");
  });
});

describe("explainCapabilities — Settings reads the kernel's own attribution", () => {
  it("agrees with authorize() on every sender-side capability, for all 16 matrices and every layer shape", () => {
    for (const { layers } of LAYERS) {
      for (const member of [false, true]) {
        for (const policy of SIXTEEN) {
          const v = explainCapabilities(policy, layers, member);
          for (const rk of ["agent", "human"] as Kind[]) {
            const cap = rk === "agent" ? "speakToAgents" : "speakToHumans";
            // A whisper names exactly one mouth, so it is the per-capability probe.
            const r = recipient(rk, DEFAULT_AGENT_POLICY, true);
            const d = authorize({ sender: sender("agent", policy, member), recipients: [r], channel: "whisper", requestedTargetId: r.id, room: { ...base, ...(layers ?? {}) }, quota, isOwnerChannel: false }).emit;
            expect(d.allow).toBe(v[cap].allowed);
            if (!d.allow) {
              expect(d.source).toBe(v[cap].source);
              expect(d.membership).toBe(v[cap].membership);
            }
          }
          for (const sk of ["agent", "human"] as Kind[]) {
            const cap = sk === "agent" ? "listenToAgents" : "listenToHumans";
            const r = recipient("agent", policy, member);
            const d = judge({ sender: sender(sk, DEFAULT_AGENT_POLICY, true), recipients: [r], channel: "room_say", room: { ...base, ...(layers ?? {}) }, quota, isOwnerChannel: false });
            // A room where even members cannot speak refuses the probe itself; the ear is untested there.
            if (d.party === "sender") continue;
            expect(d.allow).toBe(v[cap].allowed);
            if (!d.allow) {
              expect(d.source).toBe(v[cap].source);
              expect(d.membership).toBe(v[cap].membership);
            }
          }
        }
      }
    }
  });

  it("an actor refusal says whether the ceiling would have refused too", () => {
    const v = explainCapabilities({ ...DEFAULT_AGENT_POLICY, speakToHumans: false }, { policy: LISTEN_ONLY }, false);
    expect(v.speakToHumans).toEqual({ allowed: false, source: "actor", ceilingAllows: false });
    expect(v.speakToAgents).toEqual({ allowed: false, source: "space", membership: "non_member", ceilingAllows: false });
    expect(v.listenToHumans).toEqual({ allowed: true, ceilingAllows: true });
  });
});
