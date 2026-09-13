import { describe, expect, it } from "vitest";
import type { GroveApp } from "@grove/domain";
import { callTool, TOOLS } from "../src/mcp.js";

/** Minimal GroveApp stand-in: only what callTool("tool_call") touches. */
function fakeGrove(agent: Record<string, unknown> = { id: "agt_tc", claimState: "claimed" }) {
  const calls: unknown[][] = [];
  const view = (callId: string, extra: Record<string, unknown> = {}) => ({
    callId,
    name: "Bash",
    args: null,
    startedAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    finishedAt: null,
    outcome: null,
    progress: null,
    progressDone: null,
    progressTotal: null,
    result: null,
    durationMs: null,
    stalled: false,
    ...extra,
  });
  const grove = {
    identity: { getAgent: async () => agent },
    toolCalls: {
      start: async (id: string, input: Record<string, unknown>) => {
        calls.push(["start", id, input]);
        return view(String(input.callId ?? "tc_generated"));
      },
      progress: async (id: string, callId: string, input: Record<string, unknown>) => {
        calls.push(["progress", id, callId, input]);
        return view(callId, { progress: 0.5 });
      },
      finish: async (id: string, callId: string, input: Record<string, unknown>) => {
        calls.push(["finish", id, callId, input]);
        return view(callId, { outcome: input.outcome, finishedAt: "2026-09-13T00:00:01.000Z", durationMs: 1000 });
      },
    },
  } as unknown as GroveApp;
  return { grove, calls };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, any>;

describe("MCP tool_call", () => {
  it("is declared with the three phases and only the reportable outcomes", () => {
    const tool = TOOLS.find((t) => t.name === "tool_call");
    expect(tool).toBeTruthy();
    const props = (tool!.inputSchema as unknown as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.phase!.enum).toEqual(["start", "progress", "finish"]);
    expect(props.outcome!.enum).toEqual(["ok", "error", "cancelled"]);
  });

  it("routes start, progress and finish to the span service and answers in snake_case", async () => {
    const { grove, calls } = fakeGrove();
    const s = payload(await callTool(grove, "agt_tc", "tool_call", { phase: "start", call_id: "toolu_1", name: "Bash", args: "ls" }));
    expect(s.ok).toBe(true);
    expect(s.tool_call.call_id).toBe("toolu_1");
    await callTool(grove, "agt_tc", "tool_call", { phase: "progress", call_id: "toolu_1", done: 1, total: 2 });
    const f = payload(await callTool(grove, "agt_tc", "tool_call", { phase: "finish", call_id: "toolu_1", outcome: "ok" }));
    expect(f.tool_call.duration_ms).toBe(1000);
    expect(calls.map((c) => c[0])).toEqual(["start", "progress", "finish"]);
    expect(calls[0]![2]).toEqual({ callId: "toolu_1", name: "Bash", args: "ls" });
  });

  it("refuses an unknown phase and an unclaimed agent", async () => {
    const { grove } = fakeGrove();
    await expect(callTool(grove, "agt_tc", "tool_call", { phase: "begin" })).rejects.toThrow(/phase/);
    const { grove: unclaimed } = fakeGrove({ id: "agt_tc", claimState: "pending" });
    await expect(callTool(unclaimed, "agt_tc", "tool_call", { phase: "start", name: "Bash" })).rejects.toThrow(/Unclaimed/);
  });
});
