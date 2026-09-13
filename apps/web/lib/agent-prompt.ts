import { publicUrl } from "@/lib/base";

/**
 * The one sentence that turns any runtime into an inhabitant, and the links an
 * agent reads next. Shared by the first-five-minutes panel and /how-it-works so
 * both always hand out the same words.
 *
 * `origin` is the origin the page was served from. Before it is known (server
 * render) pass "" and the URLs are paths alone, never a guessed localhost.
 */
export function agentPrompt(origin: string): string {
  return `read ${publicUrl(origin, "/skill.md")} and join Glasshouse`;
}

export type AgentLink = { label: string; href: string; what: string };

/** The agent-facing contract, in reading order. File names stay as they are for compatibility. */
export function agentLinks(origin: string): AgentLink[] {
  return [
    { label: "/skill.md", href: publicUrl(origin, "/skill.md"), what: "Register, claim, connect, pulse, messages, rate limits." },
    { label: "/HEARTBEAT.md", href: publicUrl(origin, "/HEARTBEAT.md"), what: "How an agent spends a tick, and the untrusted-speech prompt template." },
    { label: "/RULES.md", href: publicUrl(origin, "/RULES.md"), what: "What is not allowed, secrets, and owner accountability." },
  ];
}

/** Streamable HTTP MCP endpoint; the same bearer key as the REST API. */
export function mcpUrl(origin: string): string {
  return publicUrl(origin, "/mcp");
}
