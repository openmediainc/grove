import { describe, expect, it } from "vitest";
import { sanitizePaperclipBudgets, sanitizePaperclipAgent, sanitizePaperclipIssue } from "../src/paperclip.js";

describe("sanitizePaperclipAgent", () => {
  it("keeps presence fields and drops adapter secrets", () => {
    const view = sanitizePaperclipAgent({
      id: "agt_1",
      name: "Hermes Agent",
      status: "idle",
      role: "ceo",
      title: "CEO",
      adapterType: "hermes_local",
      lastHeartbeatAt: "2026-09-03T05:20:00.622Z",
      adapterConfig: { token: "secret" },
      runtimeConfig: { env: { KEY: "nope" } },
      permissions: { admin: true },
    });
    expect(view).toEqual({
      id: "agt_1",
      name: "Hermes Agent",
      status: "idle",
      role: "ceo",
      title: "CEO",
      adapterType: "hermes_local",
      lastHeartbeatAt: "2026-09-03T05:20:00.622Z",
    });
    expect(JSON.stringify(view)).not.toMatch(/secret|nope|admin/);
  });

  it("rejects nameless rows", () => {
    expect(sanitizePaperclipAgent({ id: "x" })).toBeNull();
    expect(sanitizePaperclipAgent(null)).toBeNull();
  });
});

describe("sanitizePaperclipIssue", () => {
  it("keeps identifier/status/assignee and drops description", () => {
    const view = sanitizePaperclipIssue({
      identifier: "AGE-1",
      status: "blocked",
      assigneeAgentId: "agt_1",
      executionState: null,
      title: "ping every agent to see who responds",
      description: "secret runbook",
      adapterConfig: { token: "nope" },
    });
    expect(view).toEqual({
      identifier: "AGE-1",
      status: "blocked",
      assigneeAgentId: "agt_1",
      executionState: null,
      title: "ping every agent to see who responds",
    });
    expect(JSON.stringify(view)).not.toMatch(/secret|nope/);
  });
});


describe("sanitizePaperclipBudgets", () => {
  const agents = [
    { id: "a1", name: "Hermes", budgetMonthlyCents: 5000, spentMonthlyCents: 1234, adapterConfig: { secret: "x" } },
    { id: "a2", name: "OpenCode", budgetMonthlyCents: 0, spentMonthlyCents: 0 },
  ];

  it("reads a Paperclip 0 budget as no budget, not a $0 budget", () => {
    const out = sanitizePaperclipBudgets(agents, [{ agentId: "a1", costCents: 1234 }], null);
    expect(out.agents.find((a) => a.id === "a2")!.budgetMonthlyCents).toBeNull();
    expect(out.agents.find((a) => a.id === "a1")!.budgetMonthlyCents).toBe(5000);
  });

  it("reads spend as not reported unless Paperclip has cost events for the agent", () => {
    const out = sanitizePaperclipBudgets(agents, [{ agentId: "a1" }], { budgetCents: 5000, spendCents: 1234 });
    expect(out.agents.find((a) => a.id === "a1")!.spentMonthlyCents).toBe(1234);
    expect(out.agents.find((a) => a.id === "a2")!.spentMonthlyCents).toBeNull();
    expect(out.company).toEqual({ budgetMonthlyCents: 5000, spentMonthlyCents: 1234 });
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });

  it("with no cost events anywhere, even the company total is unknown", () => {
    const out = sanitizePaperclipBudgets(agents, [], { budgetCents: 5000, spendCents: 0 });
    expect(out.company!.spentMonthlyCents).toBeNull();
    expect(out.agents.every((a) => a.spentMonthlyCents === null)).toBe(true);
  });
});
