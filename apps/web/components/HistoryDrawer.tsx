"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDialogFocus } from "@/components/a11y";
import { Activity } from "@/components/Activity";
import { buttonClass } from "@/lib/brand-ui";
import { MAX_WINDOW_MS, previousVisit, replayClock, type ReplayController } from "@/lib/replay/controller";

/**
 * History, as a drawer on the map (`/?history=1`; `/chronicle` redirects here).
 *
 * Two answers to "what happened while I was away", one above the other:
 * replay puts the same bodies back in the same rooms on the map behind this
 * drawer (the scrubber is the map's own ReplayBar), and <Activity> is the
 * record as a list, with its filters in the address so a view is a link.
 *
 * PERMISSIONS: none decided here. Replay and the chronicle each filter for this
 * viewer on the server (DECISIONS #4).
 */
export function HistoryDrawer({
  controller,
  onClose,
}: {
  controller: ReplayController;
  onClose: () => void;
}) {
  const view = useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.view,
    () => controller.view,
  );
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  // Not modal: the replay bar on the map stays reachable; Escape (the map's) closes.
  const drawerRef = useRef<HTMLDivElement>(null);
  useDialogFocus(drawerRef);
  useEffect(() => setLastVisit(previousVisit()), []);
  const visitUsable = lastVisit !== null && Date.now() - lastVisit > 60_000;

  /** On a phone the sheet would cover the replay, so it steps aside for it. */
  const open = (since: number) => {
    const now = Date.now();
    void controller.open(Math.max(since, now - MAX_WINDOW_MS), now);
    try {
      if (window.matchMedia("(max-width: 639px)").matches) onClose();
    } catch {
      /* keep the drawer */
    }
  };

  const BTN = "min-h-11 rounded-gh-pill border border-line-strong bg-surface-raised px-3 text-gh-xs text-ink hover:bg-tint disabled:opacity-40 sm:min-h-8";

  return (
    <div
      ref={drawerRef}
      data-speech-avoid
      data-map-drawer
      data-a11y-dialog
      role="dialog"
      aria-modal="false"
      aria-labelledby="grove-history-title"
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 flex h-[86%] flex-col overflow-hidden rounded-t-gh-xl border-t border-line gh-frost font-brand text-gh-sm text-ink shadow-gh-3 sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-0 sm:h-auto sm:w-[420px] sm:rounded-none sm:border-l sm:border-t-0"
    >
      <header className="shrink-0 border-b border-line px-4 pb-3 pt-2 sm:pt-4">
        <span aria-hidden className="mx-auto mb-2 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="gh-label text-muted">What happened</p>
            <h2 id="grove-history-title" className="font-brand text-gh-2xl font-extrabold tracking-tight text-ink">
              History
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            title="Close (Esc)"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-gh-pill text-xl text-muted hover:bg-tint hover:text-ink sm:h-8 sm:w-8 sm:text-base"
          >
            ×
          </button>
        </div>
        <div className="mt-2 rounded-gh-lg border border-pane/60 bg-surface-raised p-3">
          {view.active ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gh-xs text-ink">
                Replaying on the map · <span className="tabular-nums">{replayClock(view.playhead)}</span> UTC
              </span>
              <button
                type="button"
                onClick={() => controller.close()}
                className={buttonClass("primary", "md", "ml-auto text-gh-xs font-semibold")}
              >
                Back to live
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted">Replay it on the map: the same bodies, in the same rooms, moving.</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" className={BTN} onClick={() => open(Date.now() - 3600_000)}>
                  Last hour
                </button>
                <button type="button" className={BTN} onClick={() => open(Date.now() - MAX_WINDOW_MS)}>
                  Last day
                </button>
                <button
                  type="button"
                  className={BTN}
                  disabled={!visitUsable}
                  title={visitUsable ? `Since ${replayClock(lastVisit!)} UTC` : "No earlier visit remembered in this browser"}
                  onClick={() => lastVisit && open(lastVisit)}
                >
                  Since my last visit
                </button>
              </div>
            </>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <Activity inPanel defaultWindow="24h" emptyText="Nothing in this window. The world was asleep too." />
      </div>
    </div>
  );
}
