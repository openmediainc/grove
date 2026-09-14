"use client";

import { useEffect } from "react";
import { keyboardInset, revealBy, takesTyping } from "@/lib/keyboard";

/**
 * The on-screen keyboard on phones (#70, docs/MOBILE.md). Renders nothing.
 *
 * - Publishes `--kb` on <html>: how many pixels of the bottom of the screen the
 *   keyboard covers (0 when it is down). A bottom sheet with a text field (the
 *   room drawer) lifts by it: `bottom-[var(--kb,0px)]`.
 * - When the keyboard opens over a field in the page itself (sign-in, create a
 *   space), the page scrolls it back above the keys, adding the room to scroll
 *   into for as long as the keyboard is up. A field in a sheet is left to the
 *   sheet, which has already lifted.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const body = document.body;
    let last = 0;
    let frame = 0;
    const update = () => {
      const kb = keyboardInset(window.innerHeight, vv);
      if (kb === last) return;
      const opened = kb > last;
      last = kb;
      root.style.setProperty("--kb", `${kb}px`);
      if (kb === 0) {
        body.style.removeProperty("padding-bottom");
        return;
      }
      if (!opened) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !takesTyping(el as HTMLInputElement) || el.closest("[role=dialog],[data-map-drawer]")) return;
        const by = revealBy(el.getBoundingClientRect().bottom, vv);
        if (!by) return;
        body.style.paddingBottom = `${kb}px`;
        window.scrollBy({ top: by });
      });
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb");
      body.style.removeProperty("padding-bottom");
    };
  }, []);
  return null;
}
