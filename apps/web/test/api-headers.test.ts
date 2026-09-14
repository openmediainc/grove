import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";

// #57: a bodiless DELETE carried content-type: application/json and the API
// refused it, so board Delete failed from the page.
describe("api() headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub() {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    return calls;
  }

  it("sends no JSON content-type without a body", async () => {
    const calls = stub();
    await api("/api/v1/board/posts/x", { method: "DELETE" });
    expect(new Headers(calls[0]!.headers).has("content-type")).toBe(false);
  });

  it("marks a body as JSON, and a caller's header still wins", async () => {
    const calls = stub();
    await api("/api/v1/say", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(new Headers(calls[0]!.headers).get("content-type")).toBe("application/json");
    await api("/api/v1/x", { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
    expect(new Headers(calls[1]!.headers).get("content-type")).toBe("text/plain");
  });
});
