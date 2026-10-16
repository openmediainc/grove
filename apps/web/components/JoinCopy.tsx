"use client";

import { useEffect, useRef, useState } from "react";
import { BRING_AGENT_LINE } from "@/lib/bring-agent";
import { buttonClass } from "@/lib/brand-ui";
import { copyText } from "./BringAgentCard";

/** /join: the one line and the Copy button that puts exactly that line on the clipboard. */
export function JoinCopy() {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const ok = await copyText(BRING_AGENT_LINE);
    setCopied(ok ? "yes" : "no");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="mt-5">
      <code
        data-join-line
        className="block select-all break-words rounded-gh-md border border-line bg-surface-raised px-3 py-3 font-brand-mono text-sm leading-snug text-ink"
      >
        {BRING_AGENT_LINE}
      </code>
      <button type="button" data-join-copy onClick={() => void copy()} className={buttonClass("primary", "md", "mt-3 w-full sm:w-auto")}>
        {copied === "yes" ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied === "yes" ? "Copied to the clipboard" : copied === "no" ? "Could not copy; select the line and copy it" : ""}
      </span>
    </div>
  );
}
