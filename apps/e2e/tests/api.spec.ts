import { expect, test, url } from "./support";

/**
 * Signed-out API and agent-contract smoke: shapes only, read-only GETs.
 * Runs once (desktop project); the viewport has nothing to do with JSON.
 */
test.describe("public API (signed out)", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1000, "API checks run in the desktop project only");

  test("/ready reports the schema up to date", async ({ request }) => {
    const res = await request.get(url("/ready"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.schema?.ok).toBe(true);
  });

  test("/skill.md is served with a version", async ({ request }) => {
    const res = await request.get(url("/skill.md"));
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.startsWith("---")).toBe(true);
    expect(text).toMatch(/^version:\s*\S+/m);
  });

  test("minimap lists rooms with occupancy", async ({ request }) => {
    const res = await request.get(url("/api/v1/world/minimap"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThan(0);
    expect(body.rooms.map((r: { slug: string }) => r.slug)).toContain("plaza");
    for (const r of body.rooms) {
      expect(typeof r.slug).toBe("string");
      expect(typeof r.name).toBe("string");
      expect(typeof r.occupancy).toBe("number");
    }
  });

  test("explore discovery has its three shelves", async ({ request }) => {
    const res = await request.get(url("/api/v1/explore/discovery"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const shelf of ["busiest_plots", "most_watched_agents", "just_arrived"]) {
      expect(Array.isArray(body.discovery?.[shelf]), shelf).toBe(true);
    }
  });

  test("empty search answers every group", async ({ request }) => {
    const res = await request.get(url("/api/v1/search?q="));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.query).toBe("");
    for (const g of ["agents", "humans", "spaces", "rooms", "online"]) {
      expect(Array.isArray(body[g]), g).toBe(true);
    }
  });

  test("follow state for a signed-out viewer is an empty map", async ({ request }) => {
    const res = await request.get(url("/api/v1/follows/state?subjects=agent:x"));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.states).toBe("object");
    expect(body.states).not.toBeNull();
  });
});
