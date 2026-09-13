"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { trialMarks, tvTrial, type TrialMark, type TrialStageWire, type TvTrial } from "@/lib/trials";

/** A trial's progress changes on the scale of tool calls; the Stage card polls on its own. */
export const TRIAL_MAP_POLL_MS = 20_000;

export type TrialStageRef = { marks: Map<string, TrialMark>; tv: TvTrial | null };

/**
 * The open trial on the Stage (040), for the map: which bodies wear the trial
 * ring and how many ticks, and what Grove TV may cut to. Public, like the
 * Stage itself. Polled only while the tab is visible; a failed poll keeps the
 * last answer rather than blanking the rings.
 */
export function useTrialStage() {
  const ref = useRef<TrialStageRef>({ marks: new Map(), tv: null });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const wire = await api<TrialStageWire>("/api/v1/trials/stage");
        if (cancelled) return;
        ref.current = { marks: trialMarks(wire), tv: tvTrial(wire) };
      } catch {
        /* keep the last answer */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), TRIAL_MAP_POLL_MS);
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
