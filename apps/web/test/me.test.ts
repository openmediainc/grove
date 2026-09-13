import { describe, expect, it } from "vitest";
import { WORLD_ID } from "@grove/protocol";
import { accessWord, yourAgents, yourSpaces } from "@/lib/me";

describe("/me", () => {
  it("says access in one vocabulary", () => {
    expect(accessWord("public_write")).toBe("Open");
    expect(accessWord("public_view")).toBe("Watch only");
    expect(accessWord("private")).toBe("Private");
    expect(accessWord("anything else")).toBe("Private");
  });

  it("lists owned spaces before memberships, without the commons or given-back plots", () => {
    const w = (id: string, name: string, owner: string | null, extra: object = {}) => ({
      id,
      slug: id,
      name,
      owner_human_id: owner,
      policy_preset: "public_view",
      ...extra,
    });
    const out = yourSpaces(
      [w(WORLD_ID, "Commons", null), w("b", "Zed", "hum_other"), w("c", "Beta", "hum_me"), w("d", "Alpha", "hum_other"), w("e", "Old", "hum_me", { archived_at: "2026-01-01" })],
      "hum_me",
    );
    expect(out.map((s) => [s.name, s.role, s.access])).toEqual([
      ["Beta", "owner", "Watch only"],
      ["Alpha", "member", "Watch only"],
      ["Zed", "member", "Watch only"],
    ]);
  });

  it("joins each owned agent to its live body and today's spend", () => {
    const owned = [
      { id: "agt_1", slug: "me/one", display_name: "One", claim_state: "claimed" },
      { id: "agt_2", slug: "me/two", display_name: "Two", claim_state: "claimed" },
    ];
    const bodies = [{ id: "agt_2", verb: "tool", detail: null, stalled: false }, { id: "agt_9", verb: "think", detail: null, stalled: false }];
    const spend = {
      agent_id: "agt_1",
      display_name: "One",
      budget: null,
      reports: 1,
      costed_reports: 1,
      uncosted_reports: 0,
      cost_micros: 1000,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    const out = yourAgents(owned, bodies, { by_agent: [spend] });
    expect(out.map((a) => [a.id, a.body?.verb ?? null, a.spend?.cost_micros ?? null])).toEqual([
      ["agt_1", null, 1000],
      ["agt_2", "tool", null],
    ]);
  });
});
