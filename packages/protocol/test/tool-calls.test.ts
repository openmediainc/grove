import { describe, expect, it } from "vitest";
import {
  TOOL_ARGS_MAX,
  describeToolCall,
  formatDuration,
  isReportableOutcome,
  normaliseCallId,
  normaliseProgress,
  normaliseToolName,
  sanitiseCaption,
  type ToolCallView,
} from "../src/tool-calls.js";

describe("tool-call captions never carry a secret", () => {
  it("keeps an ordinary caption as it is", () => {
    expect(sanitiseCaption("pnpm test:safe (api)", TOOL_ARGS_MAX)).toBe("pnpm test:safe (api)");
    expect(sanitiseCaption("apps/web/components/WorldMap.tsx", TOOL_ARGS_MAX)).toBe("apps/web/components/WorldMap.tsx");
  });

  it("flattens to one line and caps with an ellipsis", () => {
    expect(sanitiseCaption("a\nb\t c", 80)).toBe("a b c");
    const long = sanitiseCaption("x ".repeat(100), 20)!;
    expect(long.length).toBe(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("treats blank as nothing", () => {
    expect(sanitiseCaption("   ", 80)).toBeNull();
    expect(sanitiseCaption(null, 80)).toBeNull();
  });

  for (const [label, raw, leaked] of [
    ["bearer header", 'curl -H "Authorization: Bearer abc123def456"', "abc123def456"],
    ["bare bearer", "Bearer eyTokenValue99", "eyTokenValue99"],
    ["env assignment", "AETHERIA_API_KEY=grove_live_1234 pnpm dev", "grove_live_1234"],
    ["password flag", "psql --password hunter2 -d grove", "hunter2"],
    ["url userinfo", "git clone https://bob:s3cr3t@github.com/x/y", "s3cr3t"],
    ["openai key", "export sk-proj-abcdefghijklmnop", "abcdefghijklmnop"],
    ["github pat", "ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcdefghij"],
    ["aws key", "AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"],
    ["opaque blob", "token 0123456789abcdef0123456789abcdef99", "0123456789abcdef0123456789abcdef"],
    ["json secret", '{"api_key": "zzz-very-secret"}', "zzz-very-secret"],
  ] as const) {
    it(`redacts a ${label}`, () => {
      const out = sanitiseCaption(raw, 200)!;
      expect(out).not.toContain(leaked);
      expect(out).toContain("…");
    });
  }
});

describe("tool-call fields", () => {
  it("keeps tool names to identifier characters", () => {
    expect(normaliseToolName("Bash")).toBe("Bash");
    expect(normaliseToolName("mcp__grove__pulse")).toBe("mcp__grove__pulse");
    expect(normaliseToolName("<script>")).toBe("script");
    expect(normaliseToolName("  ")).toBeNull();
    expect(normaliseToolName("x".repeat(99))!.length).toBe(40);
  });

  it("accepts Claude Code tool_use ids and refuses anything odd", () => {
    expect(normaliseCallId("toolu_01ABCxyz")).toBe("toolu_01ABCxyz");
    expect(normaliseCallId("has space")).toBeNull();
    expect(normaliseCallId("x".repeat(129))).toBeNull();
    expect(normaliseCallId("")).toBeNull();
  });

  it("only lets an agent report ok, error or cancelled", () => {
    expect(isReportableOutcome("ok")).toBe(true);
    expect(isReportableOutcome("cancelled")).toBe(true);
    expect(isReportableOutcome("stalled")).toBe(false);
    expect(isReportableOutcome("done")).toBe(false);
  });

  it("reads progress as n/m or a fraction, and nothing as indeterminate (null), never 0", () => {
    expect(normaliseProgress({ done: 3, total: 12 })).toEqual({ progress: 0.25, done: 3, total: 12 });
    expect(normaliseProgress({ done: 20, total: 12 })).toEqual({ progress: 1, done: 12, total: 12 });
    expect(normaliseProgress({ progress: 0.4 })).toEqual({ progress: 0.4, done: null, total: null });
    expect(normaliseProgress({ progress: 7 })).toEqual({ progress: 1, done: null, total: null });
    expect(normaliseProgress({})).toBeNull();
    expect(normaliseProgress({ progress: "soon" })).toBeNull();
    expect(normaliseProgress({ done: 1, total: 0 })).toBeNull();
  });

  it("describes a span in one readable line", () => {
    const base: ToolCallView = {
      callId: "c1",
      name: "Bash",
      args: "pnpm test",
      startedAt: "",
      updatedAt: "",
      finishedAt: null,
      outcome: null,
      progress: null,
      progressDone: null,
      progressTotal: null,
      result: null,
      durationMs: null,
      stalled: false,
    };
    expect(describeToolCall(base)).toBe("Bash · pnpm test · running");
    expect(describeToolCall({ ...base, progressDone: 3, progressTotal: 9, progress: 1 / 3 })).toBe("Bash · pnpm test · 3/9");
    expect(describeToolCall({ ...base, stalled: true })).toBe("Bash · pnpm test · gone quiet");
    expect(describeToolCall({ ...base, outcome: "ok", durationMs: 12_300 })).toBe("Bash · pnpm test · 12s · done");
    expect(formatDuration(40)).toBe("40ms");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});
