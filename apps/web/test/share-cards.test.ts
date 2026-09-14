import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_SHARE, agentShare, clip, personShare, spaceShare } from "@/lib/og/share";
import { agentShareFor, apiOrigin, personShareFor, shareImagePath, siteOrigin, spaceShareFor } from "@/lib/og/public-data";
import { shareMetadata } from "@/lib/og/metadata";
import { SHARE_CACHE_CONTROL } from "@/lib/og/render";

const web = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const openSpace = {
  world: { slug: "den", name: "The Den", policy_preset: "public_write", plot_index: 0, archived_at: null },
  branding: { accent: "#7DD3FC" },
};

describe("space share card (#76)", () => {
  it("names a public space with access, ring and accent", () => {
    const c = spaceShare(openSpace, { working_on: "Shipping the board" });
    expect(c.generic).toBe(false);
    expect(c.title).toBe("The Den · Glasshouse");
    expect(c.eyebrow).toBe("Space · Open · Ring 1");
    expect(c.line).toBe("Shipping the board");
    expect(c.description).toBe("Open · Ring 1. Shipping the board.");
    expect(c.accent).toBe("#7dd3fc");
    expect(spaceShare({ world: { ...openSpace.world, policy_preset: "public_view" } }, null).eyebrow).toBe("Space · Watch only · Ring 1");
  });

  it("private, unknown preset, archived, missing and failed are all the same generic card", () => {
    const leak = { working_on: "secret plans" };
    const cards = [
      spaceShare({ ...openSpace, world: { ...openSpace.world, policy_preset: "private" } }, leak),
      spaceShare({ ...openSpace, world: { ...openSpace.world, policy_preset: "members_only_v2" } }, leak),
      spaceShare({ ...openSpace, world: { ...openSpace.world, archived_at: "2026-09-01" } }, leak),
      spaceShare({ world: { ...openSpace.world, policy_preset: undefined } }, leak),
      spaceShare(null, leak),
      spaceShare(null, null),
    ];
    for (const c of cards) {
      expect(c).toEqual(GENERIC_SHARE);
      expect(JSON.stringify(c)).not.toMatch(/Den|secret/);
    }
  });

  it("ignores an accent that is not a hex", () => {
    expect(spaceShare({ ...openSpace, branding: { accent: "url(x)" } }, null).accent).toBeNull();
  });
});

describe("agent and person share cards (#76)", () => {
  it("agent: name, owner and card working-on only", () => {
    const c = agentShare(
      { agent: { slug: "hello/lantern", display_name: "lantern", claim_state: "claimed" }, owner: { handle: "hello" } },
      { working_on: "reading · Library", looking_for: "a reviewer" },
    );
    expect(c).toMatchObject({ title: "lantern · Glasshouse", eyebrow: "Agent · @hello", line: "Working on: reading · Library", generic: false });
    expect(c.description).toBe("Agent of @hello. Working on: reading · Library.");
    expect(agentShare({ agent: { slug: "x/y", display_name: "y" } }, { looking_for: "a reviewer" }).line).toBe("Looking for: a reviewer");
    expect(agentShare({ agent: { slug: "x/y", display_name: "y" } }, null).line).toBe("Working on: not reported");
  });

  it("agent: pending or missing is generic", () => {
    expect(agentShare({ agent: { slug: "x/y", display_name: "y", claim_state: "pending" } }, null)).toEqual(GENERIC_SHARE);
    expect(agentShare(null, { working_on: "z" })).toEqual(GENERIC_SHARE);
  });

  it("person: handle and card headline", () => {
    const c = personShare({ human: { handle: "maya" } }, { working_on: null, looking_for: "people who build agents" });
    expect(c).toMatchObject({ title: "@maya · Glasshouse", heading: "@maya", line: "people who build agents", eyebrow: "Person" });
    expect(personShare(null, { working_on: "x" })).toEqual(GENERIC_SHARE);
  });

  it("clips typed text to one line", () => {
    expect(clip("  a\n\nb  ", 10)).toBe("a b");
    expect(clip("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("share data is read as a stranger (#76)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const hit = Object.entries(routes).find(([p]) => url.endsWith(p));
      const r = hit?.[1] ?? { status: 404, body: { ok: false } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    });
    return calls;
  }

  it("sends no cookie, no authorization, and 404s become the generic card", async () => {
    vi.stubEnv("GROVE_SHARE_API_ORIGIN", "http://api.test");
    const calls = stubFetch({
      "/api/v1/worlds/den": { status: 200, body: { ok: true, ...openSpace } },
      "/api/v1/cards/spaces/den": { status: 200, body: { ok: true, card: { card: { working_on: "Shipping" } } } },
    });
    const open = await spaceShareFor("den");
    expect(open.title).toBe("The Den · Glasshouse");
    expect(open.line).toBe("Shipping");
    const hidden = await spaceShareFor("members-only");
    const missing = await spaceShareFor("nope");
    expect(hidden).toEqual(GENERIC_SHARE);
    expect(missing).toEqual(hidden);
    for (const c of calls) {
      expect(c.url.startsWith("http://api.test/api/v1/")).toBe(true);
      const h = new Headers(c.init.headers);
      expect(h.has("cookie")).toBe(false);
      expect(h.has("authorization")).toBe(false);
      expect(c.init.credentials).toBe("omit");
    }
  });

  it("agent slugs keep their slash; a thrown fetch is generic", async () => {
    vi.stubEnv("GROVE_SHARE_API_ORIGIN", "http://api.test");
    const calls = stubFetch({
      "/api/v1/a/hello/lantern": { status: 200, body: { ok: true, agent: { slug: "hello/lantern", display_name: "lantern" }, owner: null } },
    });
    expect((await agentShareFor("hello/lantern")).title).toBe("lantern · Glasshouse");
    expect(calls.map((c) => c.url)).toContain("http://api.test/api/v1/cards/agents/hello/lantern");
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(await personShareFor("maya")).toEqual(GENERIC_SHARE);
  });

  it("resolves origins for Vercel prod, preview and the Mini", () => {
    expect(apiOrigin({ VERCEL: "1", VERCEL_ENV: "production", GROVE_PUBLIC_URL: "https://glasshouse.rendrr.app/" })).toBe("https://glasshouse.rendrr.app");
    expect(apiOrigin({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "grove-abc.vercel.app" })).toBe("https://grove-abc.vercel.app");
    expect(apiOrigin({})).toBe("http://127.0.0.1:3511");
    expect(siteOrigin({ GROVE_PUBLIC_URL: "https://q-ai.tail735569.ts.net:3510/grove" })).toBe("https://q-ai.tail735569.ts.net:3510");
    expect(siteOrigin({ VERCEL: "1" })).toBe("https://glasshouse.rendrr.app");
  });
});

describe("share metadata and routes (#76)", () => {
  it("sets og and twitter image, title and description from the card", () => {
    const card = spaceShare(openSpace, null);
    const m = shareMetadata(card, shareImagePath("space", "den"));
    expect(m.title).toBe("The Den · Glasshouse");
    expect(m.openGraph?.images).toEqual([expect.objectContaining({ url: expect.stringMatching(/\/og\/space\/den$/), width: 1200, height: 630 })]);
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [expect.stringMatching(/\/og\/space\/den$/)] });
    expect(shareImagePath("agent", "hello/lantern")).toMatch(/\/og\/agent\/hello\/lantern$/);
  });

  it("caches briefly and publicly", () => {
    expect(SHARE_CACHE_CONTROL).toBe("public, max-age=60, s-maxage=60");
  });

  it("every share page has a metadata layout and an image route", () => {
    for (const [layout, route] of [
      ["app/s/[slug]/layout.tsx", "app/og/space/[slug]/route.tsx"],
      ["app/a/[...slug]/layout.tsx", "app/og/agent/[...slug]/route.tsx"],
      ["app/u/[handle]/layout.tsx", "app/og/person/[handle]/route.tsx"],
    ]) {
      expect(readFileSync(web(layout), "utf8")).toContain("generateMetadata");
      expect(readFileSync(web(route), "utf8")).toContain("shareImage(");
    }
    const layout = readFileSync(web("app/layout.tsx"), "utf8");
    expect(layout).toContain("metadataBase");
    expect(layout).toContain("themeColor");
  });
});
