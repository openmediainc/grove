import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// docs/examples/opencode/grove.ts sits outside this package's rootDir, so it is loaded by
// URL at runtime (vitest transforms it) rather than imported for the type checker.
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginUrl = pathToFileURL(path.resolve(here, "../../../docs/examples/opencode/grove.ts")).href;

type Json = Record<string, unknown>;
type Sent = [string, Json];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;

beforeAll(async () => {
  mod = await import(/* @vite-ignore */ pluginUrl);
});

const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(answers: Array<{ status: number | null; data: unknown }> = []) {
  const sent: Sent[] = [];
  const send = async (p: string, body: Json) => {
    sent.push([p, body]);
    return answers.shift() ?? { status: 200, data: { ok: true } };
  };
  return { sent, make: () => mod.GrovePlugin.create({ send, env: {} })({}) };
}

describe("OpenCode example plugin", () => {
  it("exports exactly one plugin (OpenCode calls every export)", () => {
    expect(Object.keys(mod)).toEqual(["GrovePlugin"]);
    expect(typeof mod.GrovePlugin).toBe("function");
  });

  it("builds a start from OpenCode's callID and a caption, never the command line", () => {
    const { startBody, caption } = mod.GrovePlugin.payloads;
    expect(startBody({ tool: "bash", callID: "call_1" }, { command: "curl -H 'Bearer x' y", description: "fetch it" }))
      .toEqual({ call_id: "call_1", name: "bash", args: "fetch it" });
    expect(caption({ command: "  psql postgres://u:pw@h/db" })).toBe("psql");
    expect(caption({ filePath: "/a/b/WorldMap.tsx" })).toBe("WorldMap.tsx");
    expect(caption({ url: "https://u:p@docs.example.com/x?token=1" })).toBe("docs.example.com");
    expect(caption({ pattern: "tool_calls\nmore" })).toBe("tool_calls");
    expect(startBody({ tool: "read", callID: "" }, {})).toBeNull();
    expect(startBody({ tool: "bash", callID: "c" }, {}, "tri_1")).toMatchObject({ trial_id: "tri_1" });
    expect(mod.GrovePlugin.payloads.cleanCallId("chatcmpl tool/42")).toBe("chatcmpl_tool_42");
  });

  it("finish, fallback and route-missing rules", () => {
    const { finishBody, fallbackPulse, routeMissing } = mod.GrovePlugin.payloads;
    expect(finishBody(null)).toEqual({ outcome: "ok" });
    expect(finishBody("ENOENT: no such file\nstack")).toEqual({ outcome: "error", result: "ENOENT: no such file" });
    expect(fallbackPulse({ name: "read", args: "a.ts" })).toEqual({ verb: "tool", detail: "read · a.ts" });
    expect(routeMissing(404, { message: "Route POST:/x not found" })).toBe(true);
    expect(routeMissing(404, { ok: false, error: { code: "NOT_FOUND" } })).toBe(false);
    expect(routeMissing(null, null)).toBe(false);
  });

  it("usage is cumulative per model, reasoning counted as output, zero cost omitted", () => {
    const { usageBody } = mod.GrovePlugin.payloads;
    const m = (id: string, modelID: string, cost: number) => ({
      id, sessionID: "ses_1", role: "assistant", modelID, cost,
      tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 100, write: 1 } },
    });
    const body = usageBody("ses_1", [m("a", "qwen", 0), m("b", "qwen", 0), m("c", "claude", 0.01)]);
    expect(body.reports).toEqual([
      { model: "qwen", session_id: "opencode:ses_1", cumulative: true, input_tokens: 20, output_tokens: 10, cache_read_tokens: 200, cache_write_tokens: 2 },
      { model: "claude", session_id: "opencode:ses_1", cumulative: true, input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 1, cost_usd: 0.01 },
    ]);
    expect(usageBody("ses_1", [])).toBeNull();
  });

  it("reads the key from the credentials file before the environment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "grove-oc-"));
    const file = path.join(dir, "c.json");
    writeFileSync(file, JSON.stringify({ api_key: "from-file", api_base: "https://h.example/api/v1/" }));
    const { loadCredentials } = mod.GrovePlugin.payloads;
    expect(loadCredentials({ GROVE_CREDENTIALS: file, AETHERIA_API_KEY: "env" })).toEqual({ key: "from-file", base: "https://h.example/api/v1" });
    expect(loadCredentials({ GROVE_CREDENTIALS: `${file}.nope`, AETHERIA_API_KEY: "env" })).toEqual({ key: "env", base: "http://localhost:3000/api/v1" });
  });

  it("drives a session: span start, finish, error part, usage on idle", async () => {
    const h = harness();
    const hooks = await h.make();
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_1", callID: "call_a" }, { args: { filePath: "/x/a.ts" } });
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "ses_1", callID: "call_a", args: {} }, { title: "", output: "", metadata: {} });
    // a second finish path for the same call is ignored
    await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", callID: "call_a", state: { status: "error", error: "late" } } } } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_1", callID: "call_b" }, { args: { command: "false" } });
    await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "tool", callID: "call_b", state: { status: "error", error: "exit 1" } } } } });
    const info = { id: "msg_1", sessionID: "ses_1", role: "assistant", modelID: "qwen", cost: 0, time: { created: 1, completed: 2 }, tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
    await hooks.event({ event: { type: "message.updated", properties: { info } } });
    await hooks.event({ event: { type: "message.updated", properties: { info } } }); // same id twice counts once
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
    await settle();
    expect(h.sent).toEqual([
      ["/world/tool-calls", { call_id: "call_a", name: "read", args: "a.ts" }],
      ["/world/tool-calls/call_a/finish", { outcome: "ok" }],
      ["/world/tool-calls", { call_id: "call_b", name: "bash", args: "false" }],
      ["/world/tool-calls/call_b/finish", { outcome: "error", result: "exit 1" }],
      ["/world/pulse", { verb: "idle", detail: "turn finished" }],
      ["/world/usage", { reports: [{ model: "qwen", session_id: "opencode:ses_1", cumulative: true, input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 }] }],
    ]);
  });

  it("falls back to pulses when the server has no span routes", async () => {
    const h = harness([{ status: 404, data: { message: "Route POST:/api/v1/world/tool-calls not found" } }]);
    const hooks = await h.make();
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { description: "build" } });
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s", callID: "c1", args: {} }, { title: "", output: "", metadata: {} });
    expect(h.sent).toEqual([
      ["/world/tool-calls", { call_id: "c1", name: "bash", args: "build" }],
      ["/world/pulse", { verb: "tool", detail: "bash · build" }],
      ["/world/pulse", { verb: "think", detail: "after bash" }],
    ]);
  });

  it("never throws into OpenCode when the transport does", async () => {
    const hooks = await mod.GrovePlugin.create({ send: async () => { throw new Error("down"); }, env: {} })({});
    await expect(hooks["tool.execute.before"]({ tool: "x", sessionID: "s", callID: "c" }, { args: {} })).resolves.toBeUndefined();
    await expect(hooks["tool.execute.after"]({ tool: "x", sessionID: "s", callID: "c", args: {} }, { metadata: {} })).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })).resolves.toBeUndefined();
  });
});
