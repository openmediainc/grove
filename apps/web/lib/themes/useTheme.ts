"use client";

import { useEffect, useState } from "react";
import { DEFAULT_THEME_OBJECT, loadTheme, peekTheme } from "./registry";
import type { Theme, ThemeId } from "./types";

/**
 * The theme for `id`, loading it if it isn't here yet (#79). Until it arrives
 * this returns whatever it returned before (the default on first render), so
 * a preview never blanks while a chunk downloads. It does not call the art's
 * `prepare()`: the map does that for what it draws (and the drawer follows the
 * map), and a page preview keeps treating a missing image as "not yet".
 */
export function useTheme(id: ThemeId): Theme {
  const [theme, setTheme] = useState<Theme>(() => peekTheme(id) ?? DEFAULT_THEME_OBJECT);
  useEffect(() => {
    let live = true;
    const have = peekTheme(id);
    if (have) setTheme(have);
    void loadTheme(id)
      .then((t) => {
        if (live) setTheme(t);
      })
      .catch(() => {
        /* keep drawing what is on screen */
      });
    return () => {
      live = false;
    };
  }, [id]);
  return theme;
}
