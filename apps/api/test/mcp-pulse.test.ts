import { describe, expect, it } from "vitest";
import type { GroveApp } from "@grove/domain";
import { GroveError, PULSE_BATCH_MAX } from "@grove/domain";
import { VERB_LABEL } from "@grove/protocol";
import { callTool, TOOLS, toolError } from "../src/mcp.js";

const AGENT = { id: "agt_pulse", claimState: "claimed" };

/** Minimal GroveApp stand-in: only what callTool("pulse") touches. */
function fakeGrove(opts: {
  agent?: Record<string, unknown>;
  pulse?: (actorId: string, verb: string, detail: string | null) => unknown;
  pulseBatch?: (actorId: string, items: unknown[]) => unknown;
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
        pulseBatch: async (actorId: string, items: unknown[]) => {
          calls.push(["batch", actorId, items]);
          if (opts.pulseBatch) return opts.pulseBatch(actorId, items);
          return {
            presence: { actorId, roomId: "plaza", verb: "tool", detail: "pnpm test:safe", pulsedAt: "2026-09-12T00:00:01.000Z" },
            results: [
              { index: 0, id: "e1", status: "applied", verb: "think", pulsedAt: "2026-09-12T00:00:00.500Z", clamped: false },
              { index: 1, id: "e2", status: "refused", verb: "vibing", pulsedAt: null, clamped: false, code: "INVALID", reason: "verb must be one of" },
            ],
            applied: 1,
            duplicates: 0,
            refused: 1,
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

  it("offers exactly the nine campus verbs, for one pulse and for every batch item", () => {
    const schema = tool!.inputSchema as {
      properties: {
        verb: { enum: string[] };
        detail: { maxLength: number };
        pulses: { maxItems: number; items: { properties: Record<string, { enum?: string[] }>; required: string[] } };
      };
      required?: string[];
    };
    expect([...schema.properties.verb.enum].sort()).toEqual(Object.keys(VERB_LABEL).sort());
    expect(schema.properties.detail.maxLength).toBe(80);
    // `verb` OR `pulses`: JSON Schema cannot say "one of" portably across MCP
    // clients, so neither is required at the top and callTool checks instead.
    expect(schema.required).toBeUndefined();
    expect(schema.properties.pulses.maxItems).toBe(PULSE_BATCH_MAX);
    expect(schema.properties.pulses.items.required).toEqual(["verb"]);
    expect([...schema.properties.pulses.items.properties.verb!.enum!].sort()).toEqual(Object.keys(VERB_LABEL).sort());
    expect(Object.keys(schema.properties.pulses.items.properties)).toEqual(
      expect.arrayContaining(["verb", "detail", "url", "error_text", "at", "id"]),
    );
  });

  it("tells an LLM when to call it and when not to", () => {
    expect(tool!.description).toMatch(/one pulse per second/i);
    expect(tool!.description).toMatch(/NEW PHASE/i);
    // ...and that a burst is batched, not dropped.
    expect(tool!.description).toMatch(/`pulses`/);
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

describe("pulse tool batch", () => {
  it("routes `pulses` to the batch path with every item intact, snake or camel", async () => {
    const { grove, calls } = fakeGrove();
    const out = payload(
      await callTool(grove, AGENT.id, "pulse", {
        pulses: [
          { verb: "think", at: "2026-09-12T00:00:00.500Z", id: "e1" },
          { verb: "vibing", error_text: "x", id: "e2" },
        ],
      }),
    );
    expect(calls).toHaveLength(1);
    const [kind, actor, items] = calls[0] as [string, string, Array<Record<string, unknown>>];
    expect(kind).toBe("batch");
    expect(actor).toBe(AGENT.id);
    expect(items[0]).toMatchObject({ verb: "think", at: "2026-09-12T00:00:00.500Z", id: "e1" });
    expect(items[1]).toMatchObject({ verb: "vibing", errorText: "x", id: "e2" });
    // The body is where the batch ended; the per-item lines come back snake_case.
    expect(out).toMatchObject({ ok: true, verb: "tool", label: VERB_LABEL.tool, room_id: "plaza", applied: 1, refused: 1 });
    const results = out.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ index: 0, id: "e1", status: "applied", pulsed_at: "2026-09-12T00:00:00.500Z" });
    expect(results[1]).toMatchObject({ index: 1, status: "refused", code: "INVALID" });
  });

  it("refuses an oversized batch before touching presence", async () => {
    const { grove, calls } = fakeGrove();
    const pulses = Array.from({ length: PULSE_BATCH_MAX + 1 }, () => ({ verb: "tool" }));
    const err = await callTool(grove, AGENT.id, "pulse", { pulses }).catch((e) => e);
    expect((err as GroveError).code).toBe("INVALID");
    expect(calls).toHaveLength(0);
  });

  it("refuses a call that is both a pulse and a batch", async () => {
    const { grove, calls } = fakeGrove();
    const err = await callTool(grove, AGENT.id, "pulse", { verb: "tool", pulses: [{ verb: "read" }] }).catch((e) => e);
    expect((err as GroveError).code).toBe("INVALID");
    expect(calls).toHaveLength(0);
  });

  it("refuses an unclaimed agent's batch too", async () => {
    const { grove, calls } = fakeGrove({ agent: { id: "agt_x", claimState: "pending" } });
    const err = await callTool(grove, "agt_x", "pulse", { pulses: [{ verb: "think" }] }).catch((e) => e);
    expect((err as GroveError).code).toBe("UNCLAIMED");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a refused batch (the 1/s cap) as a clean tool error", async () => {
    const { grove } = fakeGrove({
      pulseBatch: () => {
        throw new GroveError("RATE_LIMITED", "Pulse cooldown (1 per second).");
      },
    });
    const err = await callTool(grove, AGENT.id, "pulse", { pulses: [{ verb: "think" }] }).catch((e) => e);
    expect(toolError(err as GroveError).isError).toBe(true);
  });
});
