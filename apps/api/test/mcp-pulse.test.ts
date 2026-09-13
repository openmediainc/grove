import { describe, expect, it } from "vitest";
import type { GroveApp } from "@grove/domain";
import { GroveError } from "@grove/domain";
import { VERB_LABEL } from "@grove/protocol";
import { callTool, TOOLS, toolError } from "../src/mcp.js";

const AGENT = { id: "agt_pulse", claimState: "claimed" };

/** Minimal GroveApp stand-in: only what callTool("pulse") touches. */
function fakeGrove(opts: {
  agent?: Record<string, unknown>;
  pulse?: (actorId: string, verb: string, detail: string | null) => unknown;
  calls?: unknown[][];
} = {}) {
  const calls = opts.calls ?? [];
  return {
    calls,
    grove: {
      identity: { getAgent: async () => opts.agent ?? AGENT },
      presence: {
        pulse: async (actorId: string, verb: string, detail: string | null) => {
          calls.push([actorId, verb, detail]);
          if (opts.pulse) return opts.pulse(actorId, verb, detail);
          return {
            actorId,
            roomId: "plaza",
            seatIndex: 0,
            connection: "async",
            mode: "autonomous",
            activity: "working",
            lastSeenAt: "2026-09-12T00:00:00.000Z",
            verb,
            detail,
            pulsedAt: "2026-09-12T00:00:00.000Z",
          };
        },
      },
    } as unknown as GroveApp,
  };
}

function payload(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("pulse tool declaration", () => {
  const tool = TOOLS.find((t) => t.name === "pulse");

  it("is declared in tools/list", () => {
    expect(tool).toBeTruthy();
  });

  it("offers exactly the nine campus verbs and requires one", () => {
    const schema = tool!.inputSchema as {
      properties: { verb: { enum: string[] }; detail: { maxLength: number } };
      required?: string[];
    };
    expect([...schema.properties.verb.enum].sort()).toEqual(Object.keys(VERB_LABEL).sort());
    expect(schema.properties.detail.maxLength).toBe(80);
    expect(schema.required).toEqual(["verb"]);
  });

  it("tells an LLM when to call it and when not to", () => {
    expect(tool!.description).toMatch(/one pulse per second/i);
    expect(tool!.description).toMatch(/NEW PHASE/i);
  });
});

describe("pulse tool verb validation", () => {
  it("accepts every one of the nine verbs", async () => {
    for (const verb of Object.keys(VERB_LABEL)) {
      const { grove } = fakeGrove();
      const out = payload(await callTool(grove, AGENT.id, "pulse", { verb }));
      expect(out.ok).toBe(true);
      expect(out.verb).toBe(verb);
      expect(out.label).toBe(VERB_LABEL[verb as keyof typeof VERB_LABEL]);
    }
  });

  it("refuses an unknown verb without touching presence", async () => {
    const { grove, calls } = fakeGrove();
    const err = await callTool(grove, AGENT.id, "pulse", { verb: "vibing" }).catch((e) => e);
    expect(err).toBeInstanceOf(GroveError);
    expect((err as GroveError).code).toBe("INVALID");
    expect((err as GroveError).message).toMatch(/think\|tool\|read\|say\|wait\|error\|blocked\|idle\|offline/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing verb", async () => {
    const { grove, calls } = fakeGrove();
    const err = await callTool(grove, AGENT.id, "pulse", {}).catch((e) => e);
    expect((err as GroveError).code).toBe("INVALID");
    expect(calls).toHaveLength(0);
  });

  it("truncates detail to 80 characters and passes it through", async () => {
    const { grove, calls } = fakeGrove();
    const out = payload(
      await callTool(grove, AGENT.id, "pulse", { verb: "tool", detail: "x".repeat(200) }),
    );
    expect(calls[0]![2]).toHaveLength(80);
    expect(String(out.detail)).toHaveLength(80);
  });

  it("keeps a short human-legible caption intact", async () => {
    const { grove } = fakeGrove();
    const out = payload(
      await callTool(grove, AGENT.id, "pulse", { verb: "read", detail: "reading migrations" }),
    );
    expect(out.detail).toBe("reading migrations");
    expect(out.room_id).toBe("plaza");
  });

  it("refuses an unclaimed agent", async () => {
    const { grove, calls } = fakeGrove({ agent: { id: "agt_x", claimState: "pending" } });
    const err = await callTool(grove, "agt_x", "pulse", { verb: "think" }).catch((e) => e);
    expect((err as GroveError).code).toBe("UNCLAIMED");
    expect(calls).toHaveLength(0);
  });
});

describe("pulse tool rate limit", () => {
  it("surfaces the 1/s refusal as a clean tool error, not a crash", async () => {
    const { grove } = fakeGrove({
      pulse: () => {
        throw new GroveError("RATE_LIMITED", "Pulse cooldown (1 per second).");
      },
    });
    const err = await callTool(grove, AGENT.id, "pulse", { verb: "think" }).catch((e) => e);
    expect(err).toBeInstanceOf(GroveError);
    expect((err as GroveError).code).toBe("RATE_LIMITED");

    // The /mcp handler funnels GroveError through toolError: isError, never a 500.
    const wire = toolError(err as GroveError);
    expect(wire.isError).toBe(true);
    const body = JSON.parse(wire.content[0]!.text) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toMatch(/1 per second/);
  });

  it("a second pulse inside the same second is refused, the first is not", async () => {
    let used = false;
    const { grove } = fakeGrove({
      pulse: (_actorId, verb, detail) => {
        if (used) throw new GroveError("RATE_LIMITED", "Pulse cooldown (1 per second).");
        used = true;
        return { actorId: AGENT.id, roomId: "plaza", verb, detail, pulsedAt: null };
      },
    });
    expect(payload(await callTool(grove, AGENT.id, "pulse", { verb: "think" })).ok).toBe(true);
    const err = await callTool(grove, AGENT.id, "pulse", { verb: "tool" }).catch((e) => e);
    expect((err as GroveError).code).toBe("RATE_LIMITED");
  });
});
