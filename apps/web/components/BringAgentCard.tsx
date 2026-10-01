"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BRING_AGENT_HOW_HREF, BRING_AGENT_LEAD, BRING_AGENT_LINE, BRING_AGENT_TITLE } from "@/lib/bring-agent";

/** navigator.clipboard where the page may use it, else the old select-and-copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * "Bring your agent": the one line to paste into any agent, on the map, for
 * people who have not brought one yet (lib/bring-agent decides who). Sits in
 * the HUD column under the headcount pill and the first-visit card, so it can
 * never run over the pill; the column itself stays clear of the minimap and
 * the drawer (see WorldMap). Closed once, it stays closed in this browser.
 */
export function BringAgentCard({ onDismiss }: { onDismiss: () => void }) {
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
    <aside
      data-speech-avoid
      data-bring-agent
      aria-label="Bring your agent"
      className="pointer-events-auto w-full max-w-sm rounded-gh-lg border border-line gh-frost p-3 text-gh-sm text-ink shadow-gh-2"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] leading-snug">
          <span className="font-semibold text-ink">{BRING_AGENT_TITLE}</span>{" "}
          <span className="text-muted">{BRING_AGENT_LEAD}</span>
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          title="Close this for good in this browser"
          className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-gh-pill text-xl text-muted hover:bg-tint hover:text-ink sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>
      <code className="mt-1.5 block select-all break-words rounded-gh-md border border-line bg-surface px-2 py-1.5 font-brand-mono text-xs leading-snug text-ink">
        {BRING_AGENT_LINE}
      </code>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex min-h-11 items-center rounded-gh-pill border border-line-strong bg-surface-raised px-4 text-xs font-medium text-ink hover:bg-tint sm:min-h-8"
        >
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
        <span className="sr-only" aria-live="polite">
          {copied === "yes" ? "Copied to the clipboard" : copied === "no" ? "Could not copy; select the line and copy it" : ""}
        </span>
        <Link
          href={BRING_AGENT_HOW_HREF}
          className="inline-flex min-h-11 items-center text-gh-xs font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink sm:min-h-0"
        >
          How it works →
        </Link>
      </div>
    </aside>
  );
}
