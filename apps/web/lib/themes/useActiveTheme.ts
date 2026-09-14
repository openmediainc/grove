"use client";

import { useEffect, useState } from "react";
import { DEFAULT_THEME, readActiveTheme, subscribeThemeChoice, type ThemeId } from "./index";
import type { Theme } from "./types";
import { useTheme } from "./useTheme";

/**
 * The theme the viewer has chosen, followed live (#58): `?theme=` or the
 * stored choice on mount, then every switch from the map's switcher or its T
 * key, in this tab or another. Starts at the default so the server render and
 * the first client render agree, like the map does. A theme that is not loaded
 * yet is fetched (#79); the previous one stays until it arrives.
 *
 * For the map drawer only. Pages stay neutral (DECISIONS #3).
 */
export function useActiveTheme(): Theme {
  const [id, setId] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    // readActiveTheme: what the map shows, including a space owner default (#59).
    setId(readActiveTheme());
    return subscribeThemeChoice(setId);
  }, []);
  return useTheme(id);
}
