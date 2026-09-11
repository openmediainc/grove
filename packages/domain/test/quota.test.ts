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
