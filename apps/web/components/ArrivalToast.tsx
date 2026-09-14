"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The one thing that just became true, said out loud at the top of the screen.
 * Used for arrival moments (you entered the world; your agent is standing
 * somewhere), not for settings confirmations — so it is lantern-lit and large
 * rather than a grey pill in a corner.
 */
export function ArrivalToast({
  title,
  line,
  action,
  onDismiss,
}: {
  title: string;
  line: string;
  action?: { label: string; href: string };
  onDismiss?: () => void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 20);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3 sm:top-4 sm:px-4"
    >
      <div
        className={`pointer-events-auto w-full max-w-xl rounded-2xl border border-lantern-400/40 bg-dusk-900/95 p-4 shadow-[0_18px_60px_-20px_rgba(232,184,109,0.55)] backdrop-blur transition duration-500 sm:p-5 ${
          shown ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0"
        }`}
      >
        <div className="flex items-start gap-3 sm:gap-4">
          <span className="lantern mt-1 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl leading-tight text-lantern-300 sm:text-2xl">{title}</p>
            <p className="mt-1 text-sm text-white/70">{line}</p>
            {action ? (
              <Link
                href={action.href}
                className="mt-4 inline-flex rounded-full bg-lantern-400 px-5 py-2.5 text-sm font-semibold text-dusk-950 sm:py-1.5"
              >
                {action.label}
              </Link>
            ) : null}
          </div>
          {onDismiss ? (
            <button
              onClick={onDismiss}
              aria-label="Dismiss"
              className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-white/55 hover:text-white/80 sm:-mr-1 sm:-mt-1 sm:h-8 sm:w-8 sm:text-base"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** "lantern", "lantern and ivy", "lantern, ivy and spark". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
