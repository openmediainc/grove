"use client";

/**
 * The tab strip on the one-subject pages: agent `/a/[slug]` (Activity · Card ·
 * Settings) and space `/s/[slug]` (About · Activity · Manage). One look, so the
 * two pages read as one product. The page owns the state and the `?tab=` write
 * (lib/tabs.ts); this only draws.
 */
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
  return (
    <div role="tablist" aria-label={label} className="mt-8 flex gap-1 overflow-x-auto border-b border-white/10">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={current === t}
          onClick={() => onChoose(t)}
          className={`-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm ${
            current === t ? "border-lantern-400 text-lantern-300" : "border-transparent text-white/50 hover:text-white/80"
          }`}
        >
          {labels[t]}
        </button>
      ))}
    </div>
  );
}
