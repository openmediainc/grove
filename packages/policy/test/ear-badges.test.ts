import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_POLICY,
  type PermissionBadge,
  type PermissionPolicy,
} from "@grove/protocol";
import { badges } from "../src/badges.js";

/**
 * PRM-08 — the badge vocabulary encoded only MOUTHS, so it could not express an
 * agent that talks at you without hearing a word back.
 *
 * `packages/ui/src/consequences.ts` derives its one sentence from badges. Three
 * of its sentences open with "They can hear you" — a claim about
 * `listenToHumans` — and nothing in the badge set could check it. An agent with
 * `{speakToHumans: true, listenToHumans: false}` came out as
 * `speaks_to_everyone`: "They can hear you, and can reply to you." Both halves
 * of that sentence were wrong about the ear.
 *
 * These tests are the @grove/policy half: `badges()` must be able to SAY the
 * thing before any surface can derive a sentence from it. The reduction to a
 * `SpeechState` and the sentences themselves live in @grove/ui, whose only
 * enforcement today is the exhaustive `Record<SpeechState, …>` typecheck.
 */

function policy(over: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return { ...DEFAULT_AGENT_POLICY, ...over };
}

function agentBadges(over: Partial<PermissionPolicy> = {}): PermissionBadge[] {
  return badges({ kind: "agent", claimState: "claimed", policy: policy(over) });
}

describe("a shut ear is expressible", () => {
  it("the reported case: speaks to people, hears nobody", () => {
    const out = agentBadges({ listenToHumans: false });
    expect(out).toContain("cannot_hear_humans");
    // The mouth half is untouched — the agent really does speak to everyone.
    expect(out).toContain("speaks_to_humans");
    expect(out).toContain("speaks_to_agents");
  });

  it("a shut agent ear is named too", () => {
    expect(agentBadges({ listenToAgents: false })).toContain("cannot_hear_agents");
  });

  it("a sealed agent names both ears alongside listen_only", () => {
    const out = agentBadges({
      speakToAgents: false,
      speakToHumans: false,
      listenToAgents: false,
      listenToHumans: false,
    });
    expect(out).toContain("cannot_hear_humans");
    expect(out).toContain("cannot_hear_agents");
    expect(out).toContain("listen_only");
  });

  it("ears come before mouths: you can only answer what you heard", () => {
    const out = agentBadges({ listenToHumans: false, speakToHumans: false });
    expect(out.indexOf("cannot_hear_humans")).toBeLessThan(out.indexOf("silent_to_humans"));
  });
});

describe("an OPEN ear is silent — the default agent gains no chips", () => {
  it("DEFAULT_AGENT_POLICY is unchanged", () => {
    expect(badges({ kind: "agent", claimState: "claimed", policy: DEFAULT_AGENT_POLICY })).toEqual([
      "speaks_to_agents",
      "speaks_to_humans",
    ]);
  });

  it("a classic listen-only agent (both ears open) is still exactly ['listen_only']", () => {
    expect(
      agentBadges({ speakToAgents: false, speakToHumans: false }),
    ).toEqual(["listen_only"]);
  });

  it("an unclaimed agent still short-circuits to ['unclaimed'], deaf or not", () => {
    expect(
      badges({
        kind: "agent",
        claimState: "pending",
        policy: policy({ listenToHumans: false, listenToAgents: false }),
      }),
    ).toEqual(["unclaimed"]);
  });

  it("humans carry no matrix (§5.1), so they never carry an ear badge", () => {
    expect(badges({ kind: "human", lurk: true })).toEqual(["lurk"]);
    expect(badges({ kind: "human" })).toEqual([]);
  });
});

describe("the ear half is a function of the ear, and only of the ear", () => {
  const EARS = [
    { listenToHumans: true, listenToAgents: true, expect: [] as string[] },
    { listenToHumans: false, listenToAgents: true, expect: ["cannot_hear_humans"] },
    { listenToHumans: true, listenToAgents: false, expect: ["cannot_hear_agents"] },
    { listenToHumans: false, listenToAgents: false, expect: ["cannot_hear_humans", "cannot_hear_agents"] },
  ];

  it("every one of the sixteen policies names exactly the ears that are shut", () => {
    let checked = 0;
    for (const ears of EARS) {
      for (const speakToAgents of [false, true]) {
        for (const speakToHumans of [false, true]) {
          const out = agentBadges({
            listenToHumans: ears.listenToHumans,
            listenToAgents: ears.listenToAgents,
            speakToAgents,
            speakToHumans,
          });
          const earPart = out.filter((b) => b.startsWith("cannot_hear_"));
          expect(earPart, JSON.stringify({ ears, speakToAgents, speakToHumans })).toEqual(
            ears.expect,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(16);
  });

  it("changing a mouth never changes the ear half, and vice versa", () => {
    const a = agentBadges({ listenToHumans: false, speakToHumans: true });
    const b = agentBadges({ listenToHumans: false, speakToHumans: false });
    expect(a.filter((x) => x.startsWith("cannot_hear_"))).toEqual(
      b.filter((x) => x.startsWith("cannot_hear_")),
    );
    expect(a).not.toEqual(b);
  });
});
