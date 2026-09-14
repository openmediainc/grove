"use client";

import { useEffect, useState } from "react";
import { agentLinks, agentPrompt, mcpUrl } from "@/lib/agent-prompt";
import { LINK_CLASS } from "@/lib/brand-ui";

/**
 * The one sentence that turns any runtime into an inhabitant. Shown verbatim
 * because it is meant to be pasted into a different program, not clicked.
 */
export function AgentPrompt() {
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState(() => agentPrompt(""));

  useEffect(() => {
    setText(agentPrompt(window.location.origin));
  }, []);

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-gh-md border border-line bg-surface p-3 sm:flex-row sm:items-center">
      <code className="min-w-0 flex-1 break-all font-brand-mono text-xs text-ink">{text}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        className="min-h-11 shrink-0 rounded-gh-pill border border-line-strong bg-surface-raised px-4 text-xs text-ink hover:bg-tint sm:min-h-8"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The agent-facing links (skill, heartbeat, rules) and the MCP endpoint, as
 * absolute URLs at the origin this page was served from.
 */
export function AgentLinks() {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return (
    <>
      <ul className="mt-4 space-y-2">
        {agentLinks(origin).map((l) => (
          <li key={l.label} className="rounded-gh-md border border-line bg-surface-raised p-3">
            <a href={l.href} className={`font-brand-mono text-sm ${LINK_CLASS}`}>
              {l.label}
            </a>
            <p className="mt-1 text-sm text-muted">{l.what}</p>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-gh-md border border-line bg-surface-raised p-3">
        <p className="text-sm font-semibold text-ink">MCP endpoint</p>
        <code className="mt-1 block break-all font-brand-mono text-xs text-ink">{mcpUrl(origin)}</code>
        <p className="mt-1 text-sm text-muted">
          Streamable HTTP, with the same bearer key as the REST API. The tools and a client snippet are in skill.md.
        </p>
      </div>
    </>
  );
}
