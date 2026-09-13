import { describe, expect, it } from "vitest";
import { agentHref, legacyRedirects, readTab, slugFromParam, wantsClaim, withTab, withoutClaim } from "@/lib/agent-page";

describe("agent page links", () => {
  it("keeps handle/name as path segments and leaves Activity implicit", () => {
    expect(agentHref("org/scout")).toBe("/a/org/scout");
    expect(agentHref("org/scout", "settings")).toBe("/a/org/scout?tab=settings");
    expect(agentHref("agt_1", "activity", { claim: "1" })).toBe("/a/agt_1?claim=1");
    expect(agentHref("a b/c")).toBe("/a/a%20b/c");
  });

  it("joins the catch-all back into a slug", () => {
    expect(slugFromParam(["org", "scout"])).toBe("org/scout");
    expect(slugFromParam("agt_1")).toBe("agt_1");
    expect(slugFromParam(undefined)).toBe("");
    expect(slugFromParam(["100%"])).toBe("100%");
  });
});

describe("agent page tabs", () => {
  it("opens the asked tab, but Settings only for the owner", () => {
    expect(readTab("?tab=card", false)).toBe("card");
    expect(readTab("?tab=settings", true)).toBe("settings");
    expect(readTab("?tab=settings", false)).toBe("activity");
    expect(readTab("?tab=nope", true)).toBe("activity");
    expect(readTab("", true)).toBe("activity");
  });

  it("writes the tab and settles the claim flag without losing other params", () => {
    expect(withTab("?win=7d", "card")).toBe("?win=7d&tab=card");
    expect(withTab("?tab=card&win=7d", "activity")).toBe("?win=7d");
    expect(wantsClaim("?claim=1")).toBe(true);
    expect(wantsClaim("?claim=0")).toBe(false);
    expect(withoutClaim("?claim=1&tab=settings")).toBe("?tab=settings");
  });
});

describe("legacy routes", () => {
  it("send /agents, /studio and /claim to the agent page or /me", () => {
    const table = Object.fromEntries(legacyRedirects({ publicDeploy: true }).map((r) => [r.source, r.destination]));
    expect(table["/agents"]).toBe("/me");
    expect(table["/agents/:id"]).toBe("/a/:id");
    expect(table["/studio"]).toBe("/me");
    expect(table["/studio/preview"]).toBe("/me");
    expect(table["/claim/:id"]).toBe("/a/:id?claim=1");
    expect(legacyRedirects({ publicDeploy: true }).every((r) => r.permanent === false)).toBe(true);
  });

  it("keeps the fixture harness reachable off the public deploy", () => {
    const sources = legacyRedirects({ publicDeploy: false }).map((r) => r.source);
    expect(sources).not.toContain("/studio/preview");
    const studio = legacyRedirects({ publicDeploy: false }).find((r) => r.source.startsWith("/studio/:id"))!;
    const re = new RegExp(`^${studio.source.replace("/studio/:id", "/studio/")}$`);
    expect(re.test("/studio/agt_1")).toBe(true);
    expect(re.test("/studio/preview")).toBe(false);
  });
});
