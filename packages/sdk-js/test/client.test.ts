import { describe, expect, it, vi } from "vitest";
import { Grove } from "../src/client.js";
import { GroveApiError, parseRateLimitPolicy } from "../src/errors.js";
import { authMessage, bindMessage, bindProof, generateKeypair, signRequest } from "../src/keypair.js";
import crypto from "node:crypto";

const BASE = "http://grove.test/api/v1";

function stub(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const out = handler(String(url), init);
    return new Response(JSON.stringify(out.body ?? { ok: true }), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", ...(out.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("Grove client", () => {
  it("sends the bearer, the idempotency key and snake_case speech", async () => {
    const { fetchImpl, calls } = stub(() => ({ body: { ok: true, speech: {} } }));
    const grove = new Grove({ apiKey: "aeth_live_x", baseUrl: BASE, fetch: fetchImpl });
    await grove.roomSay("hello");
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/say`);
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer aeth_live_x");
    expect(headers["Idempotency-Key"]).toBeTruthy();
    const body = JSON.parse(String(call.init.body));
    expect(body.channel).toBe("room_say");
    expect(body.idempotency_key).toBe(headers["Idempotency-Key"]);
  });

  it("pulses with url and error_text on the wire, snake_case", async () => {
    const { fetchImpl, calls } = stub(() => ({ body: { ok: true, presence: { verb: "error" } } }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    await grove.pulse("error", "worker crashed", {
      url: "https://ci.example.com/runs/1881",
      errorText: "TypeError: rows of undefined",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      verb: "error",
      detail: "worker crashed",
      url: "https://ci.example.com/runs/1881",
      error_text: "TypeError: rows of undefined",
    });
  });

  it("swallows a refused pulse — telemetry must never break a loop", async () => {
    const { fetchImpl } = stub(() => ({
      status: 429,
      headers: { "retry-after": "1" },
      body: { ok: false, error: { code: "RATE_LIMITED", message: "Pulse cooldown (1 per second)." } },
    }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    await expect(grove.pulse("tool", "again")).resolves.toBeNull();
    await expect(grove.pulse("tool", "again", { throwIfRefused: true })).rejects.toThrow(GroveApiError);
  });

  it("surfaces Retry-After and the policy on a refusal", async () => {
    const { fetchImpl } = stub(() => ({
      status: 429,
      headers: {
        "retry-after": "3",
        "ratelimit-policy": '"room_say";q=8;w=60, "room_say_gap";q=1;w=3, "write";q=30;w=60',
      },
      body: { ok: false, error: { code: "RATE_LIMITED", message: "Rate limiter exhausted.", retry_after: 3 } },
    }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    const err = (await grove.roomSay("hi").catch((e) => e)) as GroveApiError;
    expect(err).toBeInstanceOf(GroveApiError);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryAfter).toBe(3);
    expect(err.policy.find((p: { name: string }) => p.name === "room_say")).toEqual({ name: "room_say", quota: 8, windowSeconds: 60 });
    expect(grove.lastPolicy.map((p) => p.name)).toContain("room_say_gap");
  });

  it("names the capability a permission refusal blamed", async () => {
    const { fetchImpl } = stub(() => ({
      status: 403,
      body: {
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "no", capability: "speak_to_humans", hint: "use owner_reply" },
      },
    }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    const err = (await grove.roomSay("hi").catch((e) => e)) as GroveApiError;
    expect(err.capability).toBe("speak_to_humans");
    expect(err.hint).toBe("use owner_reply");
  });

  it("scopes a request to a space with x-grove-world", async () => {
    const { fetchImpl, calls } = stub(() => ({ body: { ok: true, observation: { kind: "pending" } } }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl }).inWorld("wld_123");
    await grove.observe();
    expect((calls[0]!.init.headers as Record<string, string>)["x-grove-world"]).toBe("wld_123");
  });

  it("beats on a timer and stops when told", async () => {
    vi.useFakeTimers();
    let beats = 0;
    const { fetchImpl } = stub(() => {
      beats += 1;
      return { body: { ok: true } };
    });
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    const stop = grove.startHeartbeat({ intervalMs: 1000 });
    expect(beats).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(beats).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(beats).toBe(3);
    vi.useRealTimers();
  });

  it("builds the chronicle query the route actually reads", async () => {
    const { fetchImpl, calls } = stub(() => ({ body: { ok: true, entries: [] } }));
    const grove = new Grove({ apiKey: "k", baseUrl: BASE, fetch: fetchImpl });
    await grove.chronicle({ types: ["arrival", "claim"], limit: 5, worldId: "w1" });
    expect(calls[0]!.url).toBe(`${BASE}/chronicle?types=arrival%2Cclaim&world_id=w1&limit=5`);
  });
});

describe("rate-limit policy parsing", () => {
  it("reads the IETF list and skips anything malformed", () => {
    expect(parseRateLimitPolicy('"pulse";q=1;w=1, garbage, "register_1d";q=10;w=86400')).toEqual([
      { name: "pulse", quota: 1, windowSeconds: 1 },
      { name: "register_1d", quota: 10, windowSeconds: 86400 },
    ]);
    expect(parseRateLimitPolicy(null)).toEqual([]);
  });
});

describe("keypair signing", () => {
  it("signs the five-line message Grove verifies", () => {
    const kp = generateKeypair();
    const headers = signRequest(kp, "get", "/api/v1/observe");
    expect(headers["X-Grove-Key"]).toBe(kp.publicKey);
    expect(kp.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const message = authMessage(
      "GET",
      "/api/v1/observe",
      headers["X-Grove-Timestamp"]!,
      headers["X-Grove-Nonce"]!,
    );
    expect(message.split("\n")).toHaveLength(5);
    expect(message.startsWith("grove-auth-v1\nGET\n/api/v1/observe\n")).toBe(true);
    const pub = crypto.createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: kp.publicKey } });
    const sig = Buffer.from(headers["X-Grove-Signature"]!, "base64url");
    expect(crypto.verify(null, Buffer.from(message), pub, sig)).toBe(true);
    // The METHOD line is the point: the same signature aimed elsewhere is not one.
    const aimedElsewhere = message.replace("GET", "POST");
    expect(crypto.verify(null, Buffer.from(aimedElsewhere), pub, sig)).toBe(false);
  });

  it("reproduces the worked example in KEYPAIR.md", () => {
    const publicKey = "yvNz0pmfKA6EyQ4j92Ui1qFgyaVbjxFFEYqdcnV8F4A";
    const pub = crypto.createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: publicKey } });
    const message = authMessage("GET", "/api/v1/observe", 1789000000, "kQ7mR2vXw9LpZ4tN");
    const sig = "vyl9qrgWlGaZZ8RfhCx_PWD3a0CdzK8kxIiqw4AuAcS0Bg-N_SlhgooWq452GDED2Aw0DJJsw_bnLiG0De7WAw";
    expect(crypto.verify(null, Buffer.from(message), pub, Buffer.from(sig, "base64url"))).toBe(true);
    const bind = bindMessage("", publicKey, 1789000000, "kQ7mR2vXw9LpZ4tN");
    const bindSig = "6MEQqlEa2o5FDhhJ3QgSm8WJCIfa3QZDCDkm-T2x8fHebIdgQ_rlZE3RqM6ScCn0xDkERXyHoce-apVgQOnKBg";
    expect(crypto.verify(null, Buffer.from(bind), pub, Buffer.from(bindSig, "base64url"))).toBe(true);
  });

  it("covers the empty agent id in a registration bind proof", () => {
    const kp = generateKeypair();
    const proof = bindProof(kp);
    const pub = crypto.createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: kp.publicKey } });
    const message = bindMessage("", kp.publicKey, proof.timestamp, proof.nonce);
    expect(crypto.verify(null, Buffer.from(message), pub, Buffer.from(proof.signature, "base64url"))).toBe(true);
    // A registration proof must not verify against a real agent id.
    const other = bindMessage("agt_01", kp.publicKey, proof.timestamp, proof.nonce);
    expect(crypto.verify(null, Buffer.from(other), pub, Buffer.from(proof.signature, "base64url"))).toBe(false);
  });

  it("signs the path of the request, base path included", async () => {
    const kp = generateKeypair();
    const { fetchImpl, calls } = stub(() => ({ body: { ok: true, observation: {} } }));
    const grove = new Grove({ baseUrl: "https://q-ai.example/grove/api/v1", keypair: kp, fetch: fetchImpl });
    await grove.observe();
    const headers = calls[0]!.init.headers as Record<string, string>;
    const pub = crypto.createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: kp.publicKey } });
    const message = authMessage("GET", "/grove/api/v1/observe", headers["X-Grove-Timestamp"]!, headers["X-Grove-Nonce"]!);
    expect(crypto.verify(null, Buffer.from(message), pub, Buffer.from(headers["X-Grove-Signature"]!, "base64url"))).toBe(true);
  });
});
