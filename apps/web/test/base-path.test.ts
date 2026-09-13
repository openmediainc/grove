import { afterEach, describe, expect, it, vi } from "vitest";

// Client bundles only see NEXT_PUBLIC_* — the config must inline the base it
// resolved, or the browser falls back to "/grove" on Vercel and 404s every call.
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
  return (await import("../next.config")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config base path", () => {
  it("inlines an empty base on Vercel", async () => {
    const cfg = await loadConfig({ VERCEL: "1", NEXT_PUBLIC_GROVE_BASE: undefined });
    expect(cfg.basePath).toBeUndefined();
    expect(cfg.env?.NEXT_PUBLIC_GROVE_BASE).toBe("");
  });

  it("inlines /grove on the Mini", async () => {
    const cfg = await loadConfig({ VERCEL: undefined, NEXT_PUBLIC_GROVE_BASE: undefined });
    expect(cfg.basePath).toBe("/grove");
    expect(cfg.env?.NEXT_PUBLIC_GROVE_BASE).toBe("/grove");
  });
});
