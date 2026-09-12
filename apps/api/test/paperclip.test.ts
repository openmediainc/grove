import { describe, expect, it } from "vitest";
import { sanitizePaperclipAgent, sanitizePaperclipIssue } from "../src/paperclip.js";

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

