"use client";

import { useEffect, useState } from "react";

/**
 * Kiosk mode: the world with the furniture taken away.
 *
 * The Mini is always on, so the map's most likely long-run home is a wall
 * display nobody is sitting at. Everything that makes the page usable — the
 * nav, the headline, the HUD panel, the sign-in and zoom controls — is chrome
 * for a person holding a mouse, and on a wall it is just clutter in front of the
 * campus.
 *
 * How it is entered and left, and why it cannot trap anyone:
 *
 *   in    ?kiosk=1 in the URL (so a wall display is a bookmark), or the Kiosk
 *         button, or the K key.
 *   out   Escape, or K again, or the pill this file draws — and leaving strips
 *         the query parameter, so a reload does not walk straight back in.
 *
 * The pill is the load-bearing one. A query parameter and two keystrokes are
 * fine for whoever set the display up and useless to whoever walks past it and
 * taps the screen, so there is ALWAYS a way out in the corner. It rests at a
 * third of an opacity so it is not chrome on a wall nobody is at, and it comes
 * all the way up for four seconds on ANY sign of a person — a pointer moving,
 * a touch, a key — as well as on hover and keyboard focus. Hover alone would
 * not have done: the display this mode is for is the one with no mouse. It is
 * the one piece of chrome kiosk mode keeps, because a mode with no exit is a
 * fault, not a feature.
 *
 * The stylesheet reaches the layout's nav — which this component may not edit —
 * through an attribute the map sets on <html>. It is rendered unconditionally so
 * the rule exists before the attribute does, and so leaving kiosk mode is one
 * attribute removal rather than a stylesheet swap.
 */

/** Set on <html> while kiosk mode is on. The CSS below keys off it. */
export const KIOSK_ATTR = "data-grove-kiosk";

const KIOSK_CSS = `
html[${KIOSK_ATTR}="1"] body > header { display: none !important; }
html[${KIOSK_ATTR}="1"] body { overflow: hidden; }
`;

/** How long the way out stays lit after somebody shows they are there. */
const REVEAL_MS = 4_000;

export function KioskChrome({
  active,
  onLeave,
  label = "Leave kiosk",
}: {
  active: boolean;
  onLeave: () => void;
  /** Grove TV is kiosk mode with a director, and says which one you are leaving. */
  label?: string;
}) {
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const stir = () => {
      setAwake(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAwake(false), REVEAL_MS);
    };
    // Passive, and on the window rather than on the canvas: a person who taps
    // the frame, the bell or nothing in particular has still turned up.
    for (const ev of ["pointermove", "pointerdown", "keydown"] as const) {
      window.addEventListener(ev, stir, { passive: true });
    }
    return () => {
      window.clearTimeout(timer);
      for (const ev of ["pointermove", "pointerdown", "keydown"] as const) {
        window.removeEventListener(ev, stir);
      }
    };
  }, [active]);

  return (
    <>
      <style>{KIOSK_CSS}</style>
      {active ? (
        <button
          type="button"
          onClick={onLeave}
          title={`${label} (Esc)`}
          className={`pointer-events-auto fixed bottom-3 right-3 z-30 rounded-gh-pill border border-line gh-frost px-4 py-2 gh-label text-ink shadow-gh-2 transition-opacity duration-500 hover:opacity-100 focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus ${
            awake ? "opacity-100" : "opacity-30"
          }`}
        >
          {label} · Esc
        </button>
      ) : null}
    </>
  );
}
