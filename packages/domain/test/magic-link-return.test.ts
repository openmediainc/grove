import { describe, expect, it } from "vitest";
import { loadConfig, mayReturnMagicLink } from "../src/config.js";

describe("mayReturnMagicLink", () => {
  it("never returns a link when stdout links are off", () => {
    expect(mayReturnMagicLink(loadConfig({ NODE_ENV: "production", GROVE_MAGIC_LINK_STDOUT: "0" }))).toBe(false);
  });

  it("returns links on a private (tailnet) deploy when asked", () => {
    const cfg = loadConfig({ NODE_ENV: "production", GROVE_MAGIC_LINK_STDOUT: "1" });
    expect(cfg.publicDeploy).toBe(false);
    expect(mayReturnMagicLink(cfg)).toBe(true);
  });

  it("never returns a link on a public deploy, even with stdout links on", () => {
    const cfg = loadConfig({ NODE_ENV: "production", VERCEL: "1", GROVE_MAGIC_LINK_STDOUT: "1" });
    expect(cfg.publicDeploy).toBe(true);
    expect(mayReturnMagicLink(cfg)).toBe(false);
  });
});
