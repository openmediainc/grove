import { describe, expect, it } from "vitest";
import { toCamel, toSnake } from "../src/codec.js";
import { graphemeCount } from "../src/graphemes.js";
import {
  DEFAULT_AGENT_POLICY,
  SPACE_POLICY_PRESETS,
  type PolicyDecision,
  type SpacePolicyPreset,
} from "../src/policy.js";

describe("codec", () => {
  it("maps permission policy camel ↔ snake", () => {
    const snake = toSnake(DEFAULT_AGENT_POLICY);
    expect(snake).toEqual({
      speak_to_agents: true,
      speak_to_humans: true,
      listen_to_agents: true,
      listen_to_humans: true,
    });
    expect(toCamel(snake)).toEqual(DEFAULT_AGENT_POLICY);
  });

  it("round-trips every space policy preset camel <-> snake", () => {
    for (const preset of Object.keys(SPACE_POLICY_PRESETS) as SpacePolicyPreset[]) {
      const space = SPACE_POLICY_PRESETS[preset];
      const snake = toSnake(space) as Record<string, boolean>;
      expect(Object.keys(snake).sort()).toEqual([
        "listen_to_agents",
        "listen_to_humans",
        "speak_to_agents",
        "speak_to_humans",
      ]);
      expect(toCamel(snake)).toEqual(space);
    }
  });

  it("round-trips a room carrying a space policy", () => {
    const room = {
      id: "plaza",
      slug: "plaza",
      name: "Plaza",
      kind: "public" as const,
      capacity: 80,
      allowsRoomSay: true,
      allowsWhisper: true,
      spectatorVisible: true,
      sayLimitPerMin: null,
      policyPreset: "public_view" as const,
      policy: SPACE_POLICY_PRESETS.public_view,
    };
    const snake = toSnake(room);
    expect(snake).toEqual({
      id: "plaza",
      slug: "plaza",
      name: "Plaza",
      kind: "public",
      capacity: 80,
      allows_room_say: true,
      allows_whisper: true,
      spectator_visible: true,
      say_limit_per_min: null,
      policy_preset: "public_view",
      policy: {
        speak_to_agents: false,
        speak_to_humans: false,
        listen_to_agents: true,
        listen_to_humans: true,
      },
    });
    expect(toCamel(snake)).toEqual(room);
  });

  it("round-trips the per-actor space membership flag", () => {
    const actor = { id: "agt_1", isSpaceMember: true };
    expect(toSnake(actor)).toEqual({ id: "agt_1", is_space_member: true });
    expect(toCamel(toSnake(actor))).toEqual(actor);
  });

  it("round-trips a denial's `source` in both directions, unrenamed", () => {
    // `source` is a single lowercase word, so neither the explicit table nor
    // the regex fallback may touch it, and the VALUE is a literal union that
    // must survive verbatim — "actor" must never become "Actor" or "act_or".
    for (const source of ["actor", "space"] as const) {
      const decision: PolicyDecision = {
        allow: false,
        code: "PERMISSION_DENIED",
        capability: "speakToHumans",
        source,
        reason: "This space does not grant speakToHumans.",
      };
      const snake = toSnake(decision) as Record<string, unknown>;
      expect(snake).toEqual({
        allow: false,
        code: "PERMISSION_DENIED",
        capability: "speakToHumans",
        source,
        reason: "This space does not grant speakToHumans.",
      });
      expect(Object.keys(snake)).toContain("source");
      expect(snake["source"]).toBe(source);
      expect(toCamel(snake)).toEqual(decision);
    }
  });

  it("a decision with no source stays without one across the wire", () => {
    const allow: PolicyDecision = { allow: true, code: "ALLOW", reason: "Owner channel." };
    const snake = toSnake(allow) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(snake, "source")).toBe(false);
    expect(toCamel(snake)).toEqual(allow);
  });

  it("round-trips a nested authorize result carrying both sources", () => {
    const camel = {
      emit: { allow: true, code: "ALLOW", reason: "Sender may emit this speech act." },
      deliveries: [
        {
          recipientId: "hum_a",
          decision: {
            allow: false,
            code: "PERMISSION_DENIED",
            capability: "speakToHumans",
            source: "actor",
            reason: "Not delivered to humans.",
            visibleInUi: true,
          },
        },
        {
          recipientId: "agt_b",
          decision: {
            allow: false,
            code: "PERMISSION_DENIED",
            capability: "listenToAgents",
            source: "space",
            reason: "This space does not grant listenToAgents.",
          },
        },
      ],
    };
    const snake = toSnake(camel) as { deliveries: Array<Record<string, any>> };
    expect(snake.deliveries[0]!["recipient_id"]).toBe("hum_a");
    expect(snake.deliveries[0]!["decision"]["source"]).toBe("actor");
    expect(snake.deliveries[0]!["decision"]["visible_in_ui"]).toBe(true);
    expect(snake.deliveries[1]!["decision"]["source"]).toBe("space");
    expect(toCamel(snake)).toEqual(camel);
  });

  it("maps nested observation fields", () => {
    const camel = {
      generatedAt: "t",
      claimState: "pending",
      pendingInstructions: [],
      cooldowns: { sayMs: 0, moveMs: 1 },
    };
    expect(toSnake(camel)).toEqual({
      generated_at: "t",
      claim_state: "pending",
      pending_instructions: [],
      cooldowns: { say_ms: 0, move_ms: 1 },
    });
  });
});

describe("graphemes", () => {
  it("counts emoji as one grapheme", () => {
    expect(graphemeCount("hi")).toBe(2);
    expect(graphemeCount("👩‍🚀")).toBe(1);
  });
});
