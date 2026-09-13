import { describe, expect, it } from "vitest";
import { clientIp } from "../src/http.js";

const req = (ip: string, headers: Record<string, string> = {}) => ({ ip, headers });

describe("clientIp", () => {
  it("on Vercel ignores a client-written X-Forwarded-For and uses Vercel's own header", () => {
    const r = req("10.0.0.5", { "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "203.0.113.9" });
    expect(clientIp(r, { VERCEL: "1" })).toBe("203.0.113.9");
  });

  it("on Vercel without Vercel's header falls back to the socket, never to X-Forwarded-For", () => {
    expect(clientIp(req("10.0.0.5", { "x-forwarded-for": "6.6.6.6" }), { VERCEL: "1" })).toBe("10.0.0.5");
  });

  it("behind a local proxy takes the right-most hop the proxy appended, not the spoofable first one", () => {
    const r = req("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 100.64.1.2" });
    expect(clientIp(r, {})).toBe("100.64.1.2");
  });

  it("a direct, non-proxied caller cannot choose its IP with a header", () => {
    expect(clientIp(req("100.64.9.9", { "x-forwarded-for": "6.6.6.6" }), {})).toBe("100.64.9.9");
  });

  it("with no forwarding header uses the socket address", () => {
    expect(clientIp(req("::1"), {})).toBe("::1");
  });
});
