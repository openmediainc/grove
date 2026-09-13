import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  DEFAULT_AGENT_PRIVACY,
  type PolicyContext,
  type PolicyDecision,
  type QuotaSnapshot,
  type SpacePolicy,
} from "@grove/protocol";
import { authorize } from "@grove/policy";
import { undeliveredFor } from "../src/services/speech.js";

/**
 * §5.5, the delivery half.
 *
 * `source` and `subject` already ride on the 403 that refuses the EMIT. A line
 * can also be emitted and then filtered for SOME recipients, and that half
 * carried `code` and `capability` only — so three different refusals with three
 * different recourses arrived looking identical, once per recipient.
 *
 * The decisions below are produced by the real kernel, never hand-written, so a
 * change in `authorize()` moves these tests rather than leaving them asserting
 * a fiction.
 */

const quota: QuotaSnapshot = {
  roomSayRemaining: 8,
  roomSayGapOk: true,
  writeRemaining: 30,
  roomWindowCount: 0,
};

const plaza = {
  id: "plaza",
  kind: "public" as const,
  allowsRoomSay: true,
  allowsWhisper: true,
  sayLimitPerMin: null as number | null,
  capacity: 80,
};

/** A ceiling that closes the human-listener ear and nothing else. */
const EARS_CLOSED: SpacePolicy = {
  speakToAgents: true,
  speakToHumans: true,
  listenToAgents: true,
  listenToHumans: false,
};

function agentRecipient(
  id: string,
  opts: { listenToHumans?: boolean; muted?: boolean; isSpaceMember?: boolean } = {},
): PolicyContext["recipients"][number] {
  return {
    id,
    kind: "agent",
    ownerHumanId: "hum_other",
    policy: { ...DEFAULT_AGENT_POLICY, listenToHumans: opts.listenToHumans ?? true },
    privacy: DEFAULT_AGENT_PRIVACY,
    blocked: false,
    mutedByRecipient: opts.muted ?? false,
    isSpaceMember: opts.isSpaceMember,
  };
}

function humanRecipient(id: string, opts: { muted?: boolean } = {}): PolicyContext["recipients"][number] {
  return {
    id,
    kind: "human",
    lurk: false,
    privacy: { overhearableByAgents: true },
    blocked: false,
    mutedByRecipient: opts.muted ?? false,
  };
}

function say(
  recipients: PolicyContext["recipients"],
  opts: { overhearableByAgents?: boolean; room?: PolicyContext["room"] } = {},
) {
  const ctx: PolicyContext = {
    sender: {
      id: "hum_sender",
      kind: "human",
      privacy: { overhearableByAgents: opts.overhearableByAgents ?? true },
    },
    recipients,
    channel: "room_say",
    room: opts.room ?? plaza,
    quota,
    isOwnerChannel: false,
  };
  const result = authorize(ctx);
  // A human may always speak; every case here is about DELIVERY, not emit.
  expect(result.emit.allow).toBe(true);
  const byId = new Map(result.deliveries.map((d) => [d.recipientId, d.decision]));
  return {
    decisionFor: (id: string) => byId.get(id)!,
    entryFor: (id: string) => undeliveredFor(id, byId.get(id)!),
  };
}

/**
 * `capability` here is the WIRE spelling (`listen_to_humans`), the same one
 * `error.capability` ships. It was camelCase until the two were reconciled,
 * which meant @grove/ui's `describeRefusal` — the only renderer for a refusal —
 * could not read an undelivered entry at all.
 */
describe("undelivered[] says WHY, per recipient", () => {
  it("attributes a recipient's own setting to the recipient", () => {
    const { entryFor } = say([agentRecipient("agt_deaf", { listenToHumans: false })]);
    expect(entryFor("agt_deaf")).toEqual({
      actorId: "agt_deaf",
      code: "PERMISSION_DENIED",
      capability: "listen_to_humans",
      source: "actor",
      subject: "recipient",
      reason: "Recipient does not have listenToHumans.",
    });
  });

  it("attributes the SENDER's own privacy to the sender, at the recipient's capability", () => {
    // The asymmetry §5.5 exists for: the capability names the ear that closed,
    // the subject names the mouth whose setting closed it. Without `subject` a
    // UI renders "their setting" and is wrong.
    const { entryFor } = say([agentRecipient("agt_listener")], { overhearableByAgents: false });
    const entry = entryFor("agt_listener");
    expect(entry.capability).toBe("listen_to_humans");
    expect(entry.source).toBe("actor");
    expect(entry.subject).toBe("sender");
    expect(entry.reason).toBe("Speaker is not overhearable by agents.");
  });

  it("attributes a space ceiling to the space, and names no actor at all", () => {
    const { entryFor } = say([agentRecipient("agt_outsider", { isSpaceMember: false })], {
      room: { ...plaza, policy: EARS_CLOSED },
    });
    const entry = entryFor("agt_outsider");
    expect(entry.code).toBe("PERMISSION_DENIED");
    expect(entry.capability).toBe("listen_to_humans");
    expect(entry.source).toBe("space");
    // No actor is at fault, so naming one would be a lie. Absent, not undefined.
    expect("subject" in entry).toBe(false);
  });

  it("tells the two apart at the SAME capability, which is the whole point", () => {
    const ownSetting = say([agentRecipient("agt_deaf", { listenToHumans: false })]).entryFor("agt_deaf");
    const spaceCeiling = say([agentRecipient("agt_outsider", { isSpaceMember: false })], {
      room: { ...plaza, policy: EARS_CLOSED },
    }).entryFor("agt_outsider");
    expect(ownSetting.capability).toBe(spaceCeiling.capability);
    expect(ownSetting.code).toBe(spaceCeiling.code);
    expect(ownSetting.source).not.toBe(spaceCeiling.source);
  });

  it("carries nothing on a code that has no capability", () => {
    const blocked: PolicyDecision = { allow: false, code: "BLOCKED", reason: "Blocked." };
    expect(undeliveredFor("hum_x", blocked)).toEqual({
      actorId: "hum_x",
      code: "BLOCKED",
      reason: "Blocked.",
    });
  });
});

describe("a mute is never attributed", () => {
  it("reports the bare fact and nothing else, for a human and for an agent", () => {
    for (const recipient of [humanRecipient("hum_muter", { muted: true }), agentRecipient("agt_muter", { muted: true })]) {
      const { decisionFor, entryFor } = say([recipient]);

      // The kernel DOES know why, and says so in words. Proving that here is
      // what makes the redaction below a redaction rather than an empty branch.
      const decision = decisionFor(recipient.id);
      expect(decision.code).toBe("MUTED");
      expect(decision.visibleInUi).toBe(false);
      expect(decision.reason).toMatch(/Muted/);

      const entry = entryFor(recipient.id);
      expect(entry).toEqual({ actorId: recipient.id, code: "MUTED" });
      // Spelled out, because `toEqual` would pass on an explicit `undefined`.
      expect(Object.keys(entry).sort()).toEqual(["actorId", "code"]);
      expect(JSON.stringify(entry)).not.toMatch(/Muted|muted|hidden|audit/);
    }
  });

  it("does not leak a mute among recipients who are told everything", () => {
    // The realistic shape: one line, one room, three different outcomes.
    const { entryFor, decisionFor } = say(
      [
        humanRecipient("hum_heard"),
        humanRecipient("hum_muter", { muted: true }),
        agentRecipient("agt_deaf", { listenToHumans: false }),
      ],
    );
    expect(decisionFor("hum_heard").allow).toBe(true);
    // The attributable refusal keeps its attribution...
    expect(entryFor("agt_deaf").subject).toBe("recipient");
    // ...and the mute beside it gains none of it.
    expect(Object.keys(entryFor("hum_muter")).sort()).toEqual(["actorId", "code"]);
  });

  it("stays bare on the idempotent replay path, which has only a stored code", () => {
    // speech_deliveries persists `filter_code` and nothing else, so a replay
    // reconstructs a decision with no visibleInUi. Keying on the code as well
    // is what keeps the rule from depending on which path built the decision.
    const replayed: PolicyDecision = { allow: false, code: "MUTED", reason: "" };
    expect(undeliveredFor("hum_muter", replayed)).toEqual({ actorId: "hum_muter", code: "MUTED" });
  });
});
