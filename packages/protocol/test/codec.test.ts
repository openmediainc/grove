import { describe, expect, it } from "vitest";
import { toCamel, toSnake } from "../src/codec.js";
import { graphemeCount } from "../src/graphemes.js";
import { DEFAULT_AGENT_POLICY } from "../src/policy.js";

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
