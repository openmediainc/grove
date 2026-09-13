import { describe, expect, it } from "vitest";
import { GroveError, type GroveApp } from "@grove/domain";
import { callTool, TOOLS, toolError } from "../src/mcp.js";

/** Minimal GroveApp stand-in: only what callTool("send_message") touches. */
function fakeGrove(refuse?: GroveError) {
  const agent = { id: "agt_mcp", claimState: "claimed" };
  const calls: unknown[][] = [];
  const grove = {
    identity: { getAgent: async () => agent },
    messages: {
      send: async (actor: unknown, input: unknown) => {
        calls.push([actor, input]);
        if (refuse) throw refuse;
        return {
          id: "msg_1",
          from: { kind: "agent", ref: "agt_mcp", name: "courier" },
          to: { kind: "human", ref: "ada", name: "Ada" },
          body: "hi",
          replyTo: null,
          untrusted: true,
          createdAt: "2026-09-13T00:00:00.000Z",
          readAt: null,
        };
      },
    },
  } as unknown as GroveApp;
  return { grove, calls, agent };
}

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Record<string, any>;

describe("MCP send_message", () => {
  it("is declared with a to/body shape", () => {
    const tool = TOOLS.find((t) => t.name === "send_message");
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as unknown as { required: string[]; properties: Record<string, any> };
    expect(schema.required).toEqual(["to", "body"]);
    expect(schema.properties.to.properties.kind.enum).toEqual(["human", "agent"]);
  });

  it("delegates to the one MessageService as the calling agent, and answers in snake_case", async () => {
    const { grove, calls, agent } = fakeGrove();
    const out = payload(
      await callTool(grove, "agt_mcp", "send_message", {
        to: { kind: "human", ref: "@ada" },
        body: "hi",
        reply_to: "msg_0",
        idempotency_key: "k1",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.message).toMatchObject({ id: "msg_1", reply_to: null, created_at: "2026-09-13T00:00:00.000Z" });
    expect(calls[0]).toEqual([
      { kind: "agent", agent },
      { to: { kind: "human", ref: "ada" }, body: "hi", replyTo: "msg_0", idempotencyKey: "k1" },
    ]);

    await callTool(grove, "agt_mcp", "send_message", { to_kind: "agent", to_ref: "lantern", body: "yo" });
    expect(calls[1]![1]).toEqual({ to: { kind: "agent", ref: "lantern" }, body: "yo", replyTo: null, idempotencyKey: null });
  });

  it("refuses a malformed `to` before the service is called", async () => {
    const { grove, calls } = fakeGrove();
    await expect(callTool(grove, "agt_mcp", "send_message", { to: { kind: "space", ref: "x" }, body: "hi" })).rejects.toThrow(/to must be/);
    await expect(callTool(grove, "agt_mcp", "send_message", { body: "hi" })).rejects.toThrow(/to must be/);
    expect(calls).toEqual([]);
  });

  it("returns the kernel's refusal verbatim with the same attribution as REST", async () => {
    const refusal = new GroveError("PERMISSION_DENIED", "Owner has not granted speakToHumans.", {
      capability: "speakToHumans",
      source: "actor",
      subject: "sender",
    });
    const { grove } = fakeGrove(refusal);
    const err = await callTool(grove, "agt_mcp", "send_message", { to: { kind: "human", ref: "ada" }, body: "hi" }).catch((e) => e);
    expect(err).toBe(refusal);
    const wire = toolError(err as GroveError);
    expect(wire.isError).toBe(true);
    expect(payload(wire)).toEqual({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        message: "Owner has not granted speakToHumans.",
        capability: "speak_to_humans",
        source: "actor",
        subject: "sender",
      },
    });

    const limited = new GroveError("RATE_LIMITED", "Write limit reached.", { details: { limiter: "write", resetMs: 12_400 } });
    expect(payload(toolError(limited)).error).toEqual({ code: "RATE_LIMITED", message: "Write limit reached.", retry_after: 13 });
  });
});
