"use client";

import { useRef, type KeyboardEvent } from "react";
import { nextRovingIndex } from "@/lib/a11y";

/**
 * The tab strip on the one-subject pages: agent `/a/[slug]` (Activity · Card ·
 * Settings) and space `/s/[slug]` (About · Activity · Manage). One look, so the
 * two pages read as one product. The page owns the state and the `?tab=` write
 * (lib/tabs.ts); this only draws.
 *
 * Keyboard (#67, the APG tabs pattern with automatic activation): the selected
 * tab is the one Tab stop; Left/Right, Home and End move and choose. The page
 * spreads `tabPanelProps(label, current)` on its one panel.
 */
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function tabId(label: string, tab: string): string {
  return `tabs-${slug(label)}-${tab}`;
}

export function tabPanelProps(label: string, current: string) {
  return { role: "tabpanel", id: `tabs-${slug(label)}-panel`, "aria-labelledby": tabId(label, current), tabIndex: 0 } as const;
}

export function Tabs<T extends string>({
  label,
  tabs,
  current,
  labels,
  onChoose,
}: {
  label: string;
  tabs: readonly T[];
  current: T;
  labels: Record<T, string>;
  onChoose: (tab: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRovingIndex(tabs.indexOf(current), e.key, tabs.length, "horizontal");
    if (next === null) return;
    e.preventDefault();
    onChoose(tabs[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className="mt-8 flex gap-1 overflow-x-auto border-b border-white/10">
      {tabs.map((t, i) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={tabId(label, t)}
          type="button"
          role="tab"
          aria-selected={current === t}
          aria-controls={tabPanelProps(label, current).id}
          tabIndex={current === t ? 0 : -1}
          onClick={() => onChoose(t)}
          className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm ${
            current === t ? "border-lantern-400 text-lantern-300" : "border-transparent text-white/60 hover:text-white/80"
          }`}
        >
          {labels[t]}
        </button>
      ))}
    </div>
  );
}
