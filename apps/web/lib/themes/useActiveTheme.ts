"use client";

import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, readThemeChoice, subscribeThemeChoice, type Theme } from "./index";

/**
 * The theme the viewer has chosen, followed live (#58): `?theme=` or the
 * stored choice on mount, then every switch from the map's switcher or its T
 * key, in this tab or another. Starts at the default so the server render and
 * the first client render agree, like the map does.
 *
 * For the map drawer only. Pages stay neutral (DECISIONS #3).
 */
export function useActiveTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(THEMES[DEFAULT_THEME]);
  useEffect(() => {
    setTheme(THEMES[readThemeChoice()]);
    return subscribeThemeChoice((id) => setTheme(THEMES[id]));
  }, []);
  return theme;
}
