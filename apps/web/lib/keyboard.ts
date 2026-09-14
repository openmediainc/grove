/**
 * The on-screen keyboard (#70, docs/MOBILE.md). A phone's keyboard does not
 * shrink the layout: `window.innerHeight` stays put and only the visual viewport
 * gets shorter, so anything pinned to the bottom of the screen (a room drawer's
 * composer) ends up behind the keys. `keyboardInset` is how much of the bottom
 * the keyboard covers; `components/KeyboardInset.tsx` publishes it as `--kb`.
 */
export interface ViewportLike {
  height: number;
  offsetTop: number;
}

/** Heights under this are browser chrome settling (a URL bar), not a keyboard. */
export const KEYBOARD_MIN_PX = 80;

export function keyboardInset(innerHeight: number, vv: ViewportLike | null | undefined): number {
  if (!vv || !Number.isFinite(innerHeight) || !Number.isFinite(vv.height)) return 0;
  const covered = Math.round(innerHeight - vv.height - (Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0));
  return covered >= KEYBOARD_MIN_PX ? Math.min(covered, Math.round(innerHeight)) : 0;
}

/** Whether a focused element takes typing, so the keyboard is for it and it should stay in view. */
export function takesTyping(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "hidden", "image"].includes((el.type ?? "text").toLowerCase());
}

/** Breathing room kept between a focused field and the top of the keys. */
export const KEYBOARD_GAP_PX = 12;

/**
 * How far the page has to scroll so a field whose bottom edge is at `fieldBottom`
 * (client px) sits above the keyboard: 0 when it already does.
 */
export function revealBy(fieldBottom: number, vv: ViewportLike, gap = KEYBOARD_GAP_PX): number {
  const limit = vv.offsetTop + vv.height - gap;
  return fieldBottom > limit ? Math.ceil(fieldBottom - limit) : 0;
}
