import { MODES, type Mode } from "./values.js";

/** localStorage key for the viewer's manual choice. Absent = follow the system. */
export const MODE_STORAGE_KEY = "gh-mode";

export type ModeChoice = Mode | "system";

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Which mode the chrome shows. TV/kiosk wins (it defaults to night-derived
 * `tv`), then a stored manual choice, then the system preference.
 */
export function resolveMode(input: { stored?: string | null; systemDark?: boolean; tv?: boolean }): Mode {
  if (input.tv) return "tv";
  if (isMode(input.stored)) return input.stored;
  return input.systemDark ? "night" : "light";
}

/**
 * Runs inline in <head> before first paint. Sets `data-mode` only when a
 * choice exists (stored, or `?tv=1`); otherwise the CSS media query follows
 * the system with no attribute, so a system switch applies live. Never throws.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var d=document.documentElement,m=null;try{if(/[?&]tv=1(&|$)/.test(location.search))m="tv";}catch(e){}if(!m){try{var s=localStorage.getItem(${JSON.stringify(
  MODE_STORAGE_KEY,
)});if(s==="light"||s==="night"||s==="tv")m=s;}catch(e){}}if(m)d.setAttribute("data-mode",m);}catch(e){}})();`;

/** Apply a manual choice in the browser (the You menu and ⋯ toggle use this in #73+). */
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
}
