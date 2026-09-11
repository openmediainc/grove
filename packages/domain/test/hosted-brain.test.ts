import { describe, expect, it } from "vitest";
import { HostedBrainService } from "../src/services/brains.js";
import { loadConfig } from "../src/config.js";

describe("hosted brains", () => {
  it("skips the worker tick when XAI_API_KEY is unset", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      XAI_API_KEY: "",
      DATABASE_URL: "postgres://x",
      REDIS_URL: "redis://x",
    });
    expect(config.xaiApiKey).toBeNull();
    const brains = new HostedBrainService(
      { pg: {} as never, redis: {} as never, config },
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await brains.tick();
    expect(result.skipped).toBe(true);
    expect(result.ran).toBe(0);
  });
});
