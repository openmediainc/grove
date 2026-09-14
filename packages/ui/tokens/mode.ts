import { MODES, type Mode } from "./values.js";

/** localStorage key for the viewer's manual choice. Absent = follow the system. */
export const MODE_STORAGE_KEY = "gh-mode";

export type ModeChoice = Mode | "system";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Which mode the chrome shows. TV/kiosk defaults to night-derived `tv` (a wall
 * across a room) unless the viewer explicitly chose light, then a stored
 * manual choice, then the system preference.
 */
export function resolveMode(input: { stored?: string | null; systemDark?: boolean; tv?: boolean }): Mode {
  if (input.tv) return input.stored === "light" ? "light" : "tv";
  if (isMode(input.stored)) return input.stored;
  return input.systemDark ? "night" : "light";
}

/**
 * Runs inline in <head> before first paint. Sets `data-mode` only when a
 * choice exists (stored, or `?tv=1` / `?kiosk=1`, which default to `tv` unless
 * the stored choice is light); otherwise the CSS media query follows the
 * system with no attribute, so a system switch applies live. Never throws.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var d=document.documentElement,m=null,s=null;try{s=localStorage.getItem(${JSON.stringify(
  MODE_STORAGE_KEY,
)});}catch(e){}try{if(/[?&](tv|kiosk)=1(&|$)/.test(location.search))m=s==="light"?"light":"tv";}catch(e){}if(!m&&(s==="light"||s==="night"||s==="tv"))m=s;if(m)d.setAttribute("data-mode",m);}catch(e){}})();`;

/**
 * The map's wall modes (TV and kiosk, entered by key or menu as well as by the
 * URL): switch the page to `tv` unless the viewer chose light, and hand back a
 * function that puts the viewer's own choice (or the system) back on leaving.
 */
export function enterWallMode(doc: Document = document, storage?: Storage): () => void {
  let stored: string | null = null;
  try {
    stored = (storage ?? window.localStorage).getItem(MODE_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const root = doc.documentElement;
  const wall = resolveMode({ tv: true, stored });
  root.setAttribute("data-mode", wall);
  return () => {
    if (isMode(stored)) root.setAttribute("data-mode", stored);
    else root.removeAttribute("data-mode");
  };
}

/** Fired on `window` after `applyModeChoice`, so every open toggle shows the new choice. */
export const MODE_EVENT = "gh-mode-change";

/** The viewer's stored choice, or "system". Never throws (blocked storage reads as "system"). */
export function readModeChoice(storage?: Pick<Storage, "getItem">): ModeChoice {
  try {
    const value = (storage ?? window.localStorage).getItem(MODE_STORAGE_KEY);
    return isMode(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Apply a manual choice in the browser (the You menu and the map's ⋯ toggle). */
export function applyModeChoice(choice: ModeChoice, doc: Document = document, storage?: Storage): void {
  try {
    const store = storage ?? window.localStorage;
    if (choice === "system") store.removeItem(MODE_STORAGE_KEY);
    else store.setItem(MODE_STORAGE_KEY, choice);
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
  if (choice === "system") doc.documentElement.removeAttribute("data-mode");
  else doc.documentElement.setAttribute("data-mode", choice);
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MODE_EVENT, { detail: choice }));
  } catch {
    // No window (tests, SSR): nothing else is listening.
  }
}
