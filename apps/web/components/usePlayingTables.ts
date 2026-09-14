"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { playingMarks, tvGameMoments, type PlayingMark, type PlayingWire } from "@/lib/boards";
import type { TvGame } from "@/lib/tv/director";

/** Seats change on the scale of moves; the room drawer polls its own tables faster. */
export const PLAYING_MAP_POLL_MS = 20_000;

export type PlayingRef = { marks: Map<string, PlayingMark>; wire: PlayingWire | null; games: (now: number) => TvGame[] };

/**
 * Who is playing at a board table (#42), for the map: the "playing" glyph on
 * seated bodies, and the moments Grove TV may cut to. Read from the public
 * route, which applies the place gate for this viewer. Polled only while the
 * tab is visible; a failed poll keeps the last answer.
 */
export function usePlayingTables() {
  const ref = useRef<PlayingRef>({ marks: new Map(), wire: null, games: () => [] });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const wire = await api<PlayingWire>("/api/v1/tables/playing");
        if (cancelled) return;
        ref.current = { marks: playingMarks(wire), wire, games: (now) => tvGameMoments(wire, now) };
      } catch {
        /* keep the last answer */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), PLAYING_MAP_POLL_MS);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return ref;
}
