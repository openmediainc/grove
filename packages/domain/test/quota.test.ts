import { describe, expect, it } from "vitest";
import { MemoryRateLimiter, QuotaService } from "../src/services/quota.js";
import { GroveError } from "../src/errors.js";

describe("register rate limit", () => {
  it("allows 3 per IP per hour then RATE_LIMITED", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    await q.consumeRegister("1.1.1.1");
    await q.consumeRegister("1.1.1.1");
    await q.consumeRegister("1.1.1.1");
    await expect(q.consumeRegister("1.1.1.1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("isolates IPs", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    await q.consumeRegister("1.1.1.1");
    await q.consumeRegister("1.1.1.1");
    await q.consumeRegister("1.1.1.1");
    await q.consumeRegister("8.8.8.8");
  });

  it("throws GroveError", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 3; i++) await q.consumeRegister("9.9.9.9");
    try {
      await q.consumeRegister("9.9.9.9");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(GroveError);
      expect((e as GroveError).httpStatus).toBe(429);
    }
  });
});

describe("branding suggest rate limit (#34)", () => {
  it("allows 10 website reads per person per hour, then RATE_LIMITED naming the limiter", async () => {
    const q = new QuotaService(new MemoryRateLimiter());
    for (let i = 0; i < 10; i++) await q.consumeBrandingSuggest("hum_a");
    await expect(q.consumeBrandingSuggest("hum_a")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { limiter: "branding_suggest", remaining: 0 },
    });
    await q.consumeBrandingSuggest("hum_b");
  });
});
