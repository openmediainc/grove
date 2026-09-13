import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Grove } from "../src/client.js";
import { PULSE_BATCH_MAX, type PulseBatchItem } from "../src/pulse-buffer.js";

const BASE = "http://grove.test/api/v1";

interface Call {
  at: number;
  body: { pulses?: PulseBatchItem[]; verb?: string };
}

/**
 * A fake campus that answers batches the way the real one does: one result
 * per item, in order. `script` can override the response for the nth call.
 */
function campus(script: Array<(call: Call) => Response | Promise<Response> | undefined> = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string | URL, init: RequestInit = {}) => {
    const call: Call = { at: Date.now(), body: JSON.parse(String(init.body ?? "{}")) };
    calls.push(call);
    const custom = script[calls.length - 1]?.(call);
    if (custom) return custom;
    const items = call.body.pulses ?? [];
    return json(200, {
      ok: true,
      presence: { actor_id: "agt_1", room_id: "plaza", verb: items.at(-1)?.verb ?? null },
      results: items.map((it, index) => ({
        index,
        id: it.id ?? null,
        status: it.verb === ("vibing" as never) ? "refused" : "applied",
        verb: it.verb,
        pulsed_at: typeof it.at === "string" ? it.at : null,
        clamped: false,
        ...(it.verb === ("vibing" as never) ? { code: "INVALID", reason: "verb must be one of" } : {}),
      })),
      applied: items.length,
      duplicates: 0,
      refused: 0,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("pulseBatch", () => {
  it("sends { pulses } to the pulse route and hands back the per-item results", async () => {
    const { fetchImpl, calls } = campus();
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    const res = await grove.pulseBatch([
      { verb: "think", at: "2026-09-13T12:00:00.000Z", id: "e1" },
      { verb: "tool", detail: "pnpm test:safe", at: "2026-09-13T12:00:00.400Z", id: "e2" },
    ]);
    expect(calls[0]!.body).toEqual({
      pulses: [
        { verb: "think", at: "2026-09-13T12:00:00.000Z", id: "e1" },
        { verb: "tool", detail: "pnpm test:safe", at: "2026-09-13T12:00:00.400Z", id: "e2" },
      ],
    });
    expect(res!.results.map((r) => r.status)).toEqual(["applied", "applied"]);
  });

  it("returns null when the cap refuses the whole batch", async () => {
    const { fetchImpl } = campus([
      () => json(429, { ok: false, error: { code: "RATE_LIMITED", message: "Pulse cooldown" } }, { "retry-after": "1" }),
    ]);
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    await expect(grove.pulseBatch([{ verb: "think" }])).resolves.toBeNull();
  });
});

describe("PulseBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-13T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first pulse at once, and batches what arrives while it waits out the cap", async () => {
    const { fetchImpl, calls } = campus();
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer();

    const first = buffer.push("think", "planning");
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.pulses).toHaveLength(1);

    await tick(100);
    buffer.push("read", "reading migrations");
    await tick(100);
    buffer.push("tool", "pnpm test:safe");
    await tick(100);
    buffer.push("idle", "turn finished");
    await tick(500);
    expect(calls).toHaveLength(1); // still inside the second

    await tick(200);
    expect(calls).toHaveLength(2);
    const batch = calls[1]!.body.pulses!;
    expect(batch.map((p) => p.verb)).toEqual(["read", "tool", "idle"]);
    // Each carries the moment it really happened, and its own event id.
    expect(batch.map((p) => p.at)).toEqual([
      "2026-09-13T12:00:00.100Z",
      "2026-09-13T12:00:00.200Z",
      "2026-09-13T12:00:00.300Z",
    ]);
    expect(new Set(batch.map((p) => p.id)).size).toBe(3);
    expect((await first)!.result.status).toBe("applied");
  });

  it("never sends more than one batch a second, nor more than 20 in one", async () => {
    const { fetchImpl, calls } = campus();
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer();
    for (let i = 0; i < 50; i += 1) buffer.push("tool", `step ${i}`);
    const done = buffer.flush();
    await tick(10_000);
    await done;
    expect(calls.map((c) => c.body.pulses!.length)).toEqual([20, 20, 10]);
    for (let i = 1; i < calls.length; i += 1) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    // Order across batches is the order of the calls.
    expect(calls.flatMap((c) => c.body.pulses!.map((p) => p.detail))).toEqual(
      Array.from({ length: 50 }, (_, i) => `step ${i}`),
    );
    expect(PULSE_BATCH_MAX).toBe(20);
  });

  it("puts a refused-for-pace batch back and resends the same ids after Retry-After", async () => {
    const { fetchImpl, calls } = campus([
      () => json(429, { ok: false, error: { code: "RATE_LIMITED", message: "Pulse cooldown" } }, { "retry-after": "2" }),
    ]);
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer();
    const outcome = buffer.push("tool", "pnpm test:safe");
    await tick(0);
    expect(calls).toHaveLength(1);
    await tick(1500);
    expect(calls).toHaveLength(1);
    await tick(600);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.pulses![0]!.id).toBe(calls[0]!.body.pulses![0]!.id);
    expect((await outcome)!.result.status).toBe("applied");
  });

  it("retries a network failure with the same ids, so the server can dedupe it", async () => {
    const onError = vi.fn();
    const { fetchImpl, calls } = campus([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer({ onError });
    const outcome = buffer.push("read");
    await tick(5_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.pulses![0]!.id).toBe(calls[0]!.body.pulses![0]!.id);
    expect(onError).toHaveBeenCalledOnce();
    expect((await outcome)!.result.status).toBe("applied");
  });

  it("does not retry an item the server refused on its own line", async () => {
    const { fetchImpl, calls } = campus();
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer();
    const bad = buffer.pushItem({ verb: "vibing" as never });
    await tick(5_000);
    expect(calls).toHaveLength(1);
    expect((await bad)!.result).toMatchObject({ status: "refused", code: "INVALID" });
  });

  it("gives up on a batch refused whole for a reason resending cannot fix", async () => {
    const onError = vi.fn();
    const { fetchImpl, calls } = campus([
      () => json(403, { ok: false, error: { code: "UNCLAIMED", message: "Unclaimed agents cannot pulse." } }),
    ]);
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer({ onError });
    const outcome = buffer.push("think");
    await tick(5_000);
    expect(calls).toHaveLength(1);
    await expect(outcome).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("drops the oldest pulses beyond maxQueue, and says so", async () => {
    const onDrop = vi.fn();
    const { fetchImpl } = campus(Array.from({ length: 3 }, () => () => {
      throw new TypeError("offline");
    }));
    const buffer = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).pulseBuffer({ maxQueue: 3, onDrop });
    const oldest = buffer.push("think", "0");
    for (let i = 1; i < 5; i += 1) buffer.push("tool", String(i));
    await expect(oldest).resolves.toBeNull();
    expect(onDrop).toHaveBeenCalled();
    expect(buffer.pending).toBeLessThanOrEqual(3);
  });

  it("makes plain pulse() batch for free with bufferPulses", async () => {
    const { fetchImpl, calls } = campus();
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl, bufferPulses: true });
    const a = grove.pulse("think", "planning");
    const b = grove.pulse("tool", "pnpm test:safe", { url: "https://github.com/grove/grove/pull/42" });
    const c = grove.pulse("idle");
    const flushed = grove.flushPulses();
    await tick(3_000);
    await flushed;
    // Three calls to pulse() inside one tick: none refused, one request.
    expect(calls.map((x) => x.body.pulses!.map((p) => p.verb))).toEqual([["think", "tool", "idle"]]);
    expect(calls[0]!.body.pulses![1]!.url).toBe("https://github.com/grove/grove/pull/42");
    expect((await a)!.presence).toBeTruthy();
    expect((await b)!.presence).toBeTruthy();
    expect((await c)!.presence).toBeTruthy();
  });
});
