import { describe, expect, it } from "vitest";
import { agentLinks, agentPrompt, mcpUrl } from "@/lib/agent-prompt";
import { gp } from "@/lib/base";

describe("agent prompt (shared by /how-it-works and the first five minutes)", () => {
  it("names skill.md at the served origin and the visible product name", () => {
    expect(agentPrompt("https://glasshouse.example")).toBe(
      `read https://glasshouse.example${gp("/skill.md")} and join Glasshouse`,
    );
  });

  it("is a bare path before the origin is known, never a guessed localhost", () => {
    const p = agentPrompt("");
    expect(p).toBe(`read ${gp("/skill.md")} and join Glasshouse`);
    expect(p).not.toContain("localhost");
  });

  it("strips a trailing slash on the origin", () => {
    expect(mcpUrl("https://x.test/")).toBe(`https://x.test${gp("/mcp")}`);
  });

  it("links skill, heartbeat and rules in reading order", () => {
    const links = agentLinks("https://x.test");
    expect(links.map((l) => l.label)).toEqual(["/skill.md", "/HEARTBEAT.md", "/RULES.md"]);
    for (const l of links) expect(l.href).toBe(`https://x.test${gp(l.label)}`);
  });
});
