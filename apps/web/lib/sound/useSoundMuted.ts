"use client";

import { useCallback, useEffect, useState } from "react";
import { isSoundMuted, setSoundMuted, subscribeSoundMuted } from "./prefs";

/** The site-wide mute as React state: every control bound to it stays in step. */
export function useSoundMuted(): [boolean, (muted: boolean) => void] {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(isSoundMuted());
    return subscribeSoundMuted(setMuted);
  }, []);
  const set = useCallback((m: boolean) => setSoundMuted(m), []);
  return [muted, set];
}
