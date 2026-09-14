"use client";

import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import type { ReplayController } from "@/lib/replay/controller";

/**
 * The map's code-split boundaries (#68, docs/PERFORMANCE.md).
 *
 * The world is the first thing anyone sees, so `/` ships only what paints it:
 * the canvas, the HUD and the menus. Everything a viewer has to ASK for — a
 * room drawer, a peek card, the History drawer, the walk-in sheet, the
 * sequence recorder and letterbox, the replay scrubber — loads the first time
 * it is shown. All of it is client-only map chrome, so `ssr: false` changes
 * nothing about the server render (none of these render on a first paint).
 *
 * The two a visitor reaches for most (a room, a peek card) are fetched on idle
 * once the map is up, so opening them is still instant; they just stop
 * competing with the first paint and hydration.
 *
 * Keep types importing straight from the component files (`import type` is
 * erased); only VALUES imported from those files pull them back into `/`.
 */

const none = () => null;

const loadRoomDrawer = () => import("./RoomDrawer");
const loadPeek = () => import("./SpectatorPeek");

export const RoomDrawer = dynamic(() => loadRoomDrawer().then((m) => m.RoomDrawer), { ssr: false, loading: none });
export const SpectatorPeek = dynamic(() => loadPeek().then((m) => m.SpectatorPeek), { ssr: false, loading: none });
export const HistoryDrawer = dynamic(() => import("./HistoryDrawer").then((m) => m.HistoryDrawer), {
  ssr: false,
  loading: none,
});
export const WalkInSheet = dynamic(() => import("./WalkInSheet").then((m) => m.WalkInSheet), { ssr: false, loading: none });
export const SequenceRecorder = dynamic(() => import("./CinemaChrome").then((m) => m.SequenceRecorder), {
  ssr: false,
  loading: none,
});
export const CinemaBars = dynamic(() => import("./CinemaChrome").then((m) => m.CinemaBars), { ssr: false, loading: none });

const ReplayBarImpl = dynamic(() => import("./ReplayBar").then((m) => m.ReplayBar), { ssr: false, loading: none });
const ReplayBadgeImpl = dynamic(() => import("./ReplayBar").then((m) => m.ReplayBadge), { ssr: false, loading: none });

function useReplayActive(controller: ReplayController): boolean {
  return useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.view.active,
    () => false,
  );
}

/** The scrubber, fetched the first time replay is actually on. */
export function ReplayBar({ controller }: { controller: ReplayController }) {
  return useReplayActive(controller) ? <ReplayBarImpl controller={controller} /> : null;
}

/** The "REPLAY · 09:14" pill; same chunk as the scrubber. */
export function ReplayBadge({ controller }: { controller: ReplayController }) {
  return useReplayActive(controller) ? <ReplayBadgeImpl controller={controller} /> : null;
}

/** Warm the chunks a visitor is most likely to open, once the browser is idle. */
export function usePrefetchMapDrawers(): void {
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const warm = () => {
      void loadRoomDrawer().catch(() => {});
      void loadPeek().catch(() => {});
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(warm, { timeout: 8000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(warm, 3000);
    return () => window.clearTimeout(t);
  }, []);
}
