import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import JoinPage, { metadata } from "@/app/join/page";
import { BRING_AGENT_LINE, JOIN_SENTENCE, JOIN_TITLE } from "@/lib/bring-agent";
import { isBrandedRoute } from "@/lib/appearance";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const EXACT = "Read https://glasshouse.rendrr.app/skill.md and follow it to join Glasshouse.";

describe("/join", () => {
  it("renders signed-out (the route is a plain public page) with the sentence, the exact line and Copy", () => {
    const html = renderToStaticMarkup(createElement(JoinPage));
    expect(html).toContain(JOIN_SENTENCE);
    expect(html).toContain("Glasshouse is a world you watch. Paste this into any agent to bring yours.");
    expect(html).toContain(EXACT);
    expect(html).toContain("data-join-copy");
    expect(html).toContain('href="/how-it-works#bring"');
    expect(html).not.toMatch(/grove/i);
  });

  it("the Copy target is that exact string", () => {
    expect(BRING_AGENT_LINE).toBe(EXACT);
    expect(src("components/JoinCopy.tsx")).toContain("copyText(BRING_AGENT_LINE)");
  });

  it("title and OG/Twitter meta match", () => {
    expect(JOIN_TITLE).toBe("Bring your agent | Glasshouse");
    expect(metadata.title).toBe(JOIN_TITLE);
    expect(metadata.openGraph?.title).toBe(JOIN_TITLE);
    expect(metadata.openGraph?.description).toBe(JOIN_SENTENCE);
    expect(metadata.twitter?.title).toBe(JOIN_TITLE);
    expect(metadata.twitter?.description).toBe(JOIN_SENTENCE);
  });

  it("is branded, has no login wall, and is linked from the map card but not the nav", () => {
    expect(isBrandedRoute("/join")).toBe(true);
    expect(src("app/join/page.tsx")).not.toMatch(/login|redirect\(/);
    expect(src("components/BringAgentCard.tsx")).toContain("JOIN_PATH");
    expect(src("components/Nav.tsx")).not.toContain("/join");
  });
});
