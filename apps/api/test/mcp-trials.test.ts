import { describe, expect, it } from "vitest";
import type { GroveApp } from "@grove/domain";
import { callTool, TOOLS } from "../src/mcp.js";

/** Minimal GroveApp stand-in: only what the trial tools touch. */
function fakeGrove() {
  const agent = { id: "agt_mcp", claimState: "claimed" };
  const calls: unknown[][] = [];
  const grove = {
    identity: { getAgent: async () => agent },
    trials: {
      listForAgent: async (a: unknown) => (calls.push(["list", a]), { open: [], scheduled: [], recent: [] }),
      enter: async (a: unknown, id: unknown) => (calls.push(["enter", a, id]), { trial: { id }, entry: { submissionsLeft: 10, nonce: "abc" } }),
      submit: async (a: unknown, id: unknown, input: unknown) => (calls.push(["submit", a, id, input]), { correct: true, reason: null, entry: { outcome: "correct" } }),
    },
    toolCalls: {
      start: async (id: unknown, input: unknown) => (calls.push(["start", id, input]), { callId: "c1" }),
    },
  } as unknown as GroveApp;
  return { grove, calls, agent };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, any>;

describe("MCP trial tools", () => {
  it("declares trials_list, trial_enter and trial_submit, and a trial tag on tool_call", () => {
    for (const name of ["trials_list", "trial_enter", "trial_submit"]) expect(TOOLS.find((t) => t.name === name)).toBeTruthy();
    const tc = TOOLS.find((t) => t.name === "tool_call")!.inputSchema as unknown as { properties: Record<string, unknown> };
    expect(tc.properties.trial_id).toBeTruthy();
  });

  it("delegates to the one TrialService as the calling agent, in snake_case", async () => {
    const { grove, calls, agent } = fakeGrove();
    expect(payload(await callTool(grove, "agt_mcp", "trials_list", {}))).toMatchObject({ ok: true, trials: { open: [] } });
    const entered = payload(await callTool(grove, "agt_mcp", "trial_enter", { trial_id: "trl_1" }));
    expect(entered.entry).toMatchObject({ submissions_left: 10, nonce: "abc" });
    const submitted = payload(await callTool(grove, "agt_mcp", "trial_submit", { trial_id: "trl_1", answer: "moss" }));
    expect(submitted).toMatchObject({ ok: true, correct: true });
    await callTool(grove, "agt_mcp", "tool_call", { phase: "start", name: "Bash", trial_id: "trl_1" });
    expect(calls).toEqual([
      ["list", agent],
      ["enter", agent, "trl_1"],
      ["submit", agent, "trl_1", { answer: "moss", proof: undefined }],
      ["start", "agt_mcp", { callId: null, name: "Bash", args: undefined, trialId: "trl_1" }],
    ]);
  });
});
