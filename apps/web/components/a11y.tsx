"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { nextRovingIndex, typeaheadIndex } from "@/lib/a11y";

/**
 * Keyboard and focus plumbing shared by the drawers, menus, palette and tabs
 * (#67). docs/ACCESSIBILITY.md says which pattern each surface follows.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement): boolean {
  return !el.hidden && el.getClientRects().length > 0;
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

/*
 * Where focus was before a dialog opened. A drawer is often opened from a menu
 * item that is gone by the time the drawer mounts, so the tracker remembers the
 * menu's button instead of the item (`data-menu-root`).
 */
let lastFocused: HTMLElement | null = null;
let tracking = false;
function trackFocus() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest("[data-a11y-dialog]")) return;
      const menuRoot = el.closest<HTMLElement>("[data-menu-root]");
      lastFocused = menuRoot?.querySelector<HTMLElement>("[aria-haspopup]") ?? el;
    },
    true,
  );
}

/**
 * A dialog or drawer that is mounted while open. On mount focus moves to the
 * container (it carries the dialog's name) unless something inside already has
 * it; on unmount focus goes back to where it came from, if that still exists
 * and focus has not been put somewhere on purpose meanwhile.
 *
 * - `modal`: Tab and Shift+Tab stay inside (the search palette, the lightbox).
 *   Side drawers over the live map are NOT modal: Tab walks out to the map
 *   controls and back, and Escape (handled by the map) closes them.
 * - `onEscape`: close on Escape from inside the dialog, for surfaces the map's
 *   own Escape handling does not know about. Return false to let the key through.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  { modal = false, onEscape, autoFocus = true }: { modal?: boolean; onEscape?: (e: KeyboardEvent) => void | false; autoFocus?: boolean } = {},
) {
  const escRef = useRef(onEscape);
  escRef.current = onEscape;
  useEffect(() => {
    trackFocus();
    const root = ref.current;
    if (!root) return;
    const from = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : lastFocused;
    // Only when the dialog was opened from a control: a drawer a deep link
    // opens on page load, or a click on the canvas opens, leaves focus alone.
    if (autoFocus && from && !root.contains(document.activeElement)) {
      if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      root.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escRef.current) {
        if (escRef.current(e) === false) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!modal || e.key !== "Tab") return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      const active = document.activeElement;
      const lost = !active || active === document.body || root.contains(active);
      if (lost && from && from.isConnected) from.focus({ preventScroll: true });
    };
    // Mount/unmount only: a dialog here is mounted while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const MENU_ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

/** The menu's items, in order, visible ones only. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEMS)).filter(visible);
}

/** Roving tabindex: the focused item is the one Tab stop inside the menu. */
export function focusMenuItem(menu: HTMLElement, index: number) {
  const items = menuItems(menu);
  items.forEach((el, i) => el.setAttribute("tabindex", i === index ? "0" : "-1"));
  items[index]?.focus();
}

/**
 * Arrow keys, Home/End and typeahead inside an open `role="menu"`. Other
 * controls a menu holds (the theme select, the volume slider) keep their own
 * arrows and are reached with Tab.
 */
export function onMenuKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const menu = e.currentTarget;
  const target = e.target as HTMLElement;
  if (target.matches("select, input, textarea")) return;
  const items = menuItems(menu);
  const current = items.indexOf(target);
  const orientation = menu.getAttribute("aria-orientation") === "horizontal" ? "horizontal" : "vertical";
  const next = nextRovingIndex(current, e.key, items.length, orientation);
  if (next !== null) {
    e.preventDefault();
    focusMenuItem(menu, next);
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // While focus is in a menu, letters are typeahead, never the map's shortcuts.
    e.stopPropagation();
    const hit = typeaheadIndex(items.map((el) => el.textContent ?? ""), current, e.key);
    if (hit >= 0) {
      e.preventDefault();
      focusMenuItem(menu, hit);
    }
  }
}

/**
 * The menu-button half: while open, focus the first item on open, close when
 * focus leaves the whole thing (Tab out), and send focus back to the button
 * when closed from inside (a pick or Escape), never when closed by a click
 * elsewhere.
 */
export function useMenuButton(
  open: boolean,
  setOpen: (open: boolean) => void,
  rootRef: RefObject<HTMLElement | null>,
  buttonRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
) {
  const openedByKey = useRef(false);
  /** Focus is somewhere inside the button + menu (kept through an item's removal). */
  const inside = useRef(false);
  useEffect(() => {
    trackFocus();
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (open) {
      const menu = menuRef.current;
      if (menu) {
        const items = menuItems(menu);
        items.forEach((el, i) => el.setAttribute("tabindex", i === 0 ? "0" : "-1"));
        // Focus lands in the menu so arrows work; a pointer open keeps the
        // button focused (arrows still enter the list from there).
        if (openedByKey.current) items[0]?.focus();
      }
      openedByKey.current = false;
      if (!root) return;
      inside.current = root.contains(document.activeElement);
      const onFocusIn = () => {
        inside.current = true;
      };
      const onFocusOut = (e: FocusEvent) => {
        // A removed item blurs with no relatedTarget: that is not leaving.
        const to = e.relatedTarget as Node | null;
        if (to && !root.contains(to)) {
          inside.current = false;
          setOpen(false);
        }
      };
      root.addEventListener("focusin", onFocusIn);
      root.addEventListener("focusout", onFocusOut);
      return () => {
        root.removeEventListener("focusin", onFocusIn);
        root.removeEventListener("focusout", onFocusOut);
      };
    }
    // Closed by a pick or Escape from inside: focus goes home to the button,
    // unless whatever the pick opened (a drawer) has already taken it.
    if (inside.current) {
      inside.current = false;
      const active = document.activeElement;
      if (!active || active === document.body) buttonRef.current?.focus({ preventScroll: true });
    }
    return undefined;
  }, [open, rootRef, buttonRef, menuRef, setOpen]);

  /** Keys on the button: ArrowDown/Up/Enter/Space open with focus in the list. */
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (open && menuRef.current) {
        const items = menuItems(menuRef.current);
        focusMenuItem(menuRef.current, e.key === "ArrowUp" ? items.length - 1 : 0);
      } else {
        openedByKey.current = true;
        setOpen(true);
      }
    } else if ((e.key === "Enter" || e.key === " ") && !open) {
      openedByKey.current = true;
    }
  };
}

/**
 * "Skip to content": the first Tab stop on every page. The pages each render
 * their own `<main>`, so the link finds it rather than every page carrying an id.
 */
export function SkipLink() {
  // Give the page's <main> the id the link points at, so the link is a real
  // in-page link (and assistive tech lists it as one).
  useEffect(() => {
    // Some pages render <main> after a suspense boundary: look for a moment.
    let tries = 0;
    const timer = window.setInterval(() => {
      const main = document.querySelector<HTMLElement>("main");
      if (main && !main.id) main.id = "main";
      if (main || ++tries > 20) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  });
  return (
    <a
      href="#main"
      onClick={(e) => {
        const main = document.querySelector<HTMLElement>("main") ?? document.querySelector<HTMLElement>("[data-grove-theme]");
        if (!main) return;
        e.preventDefault();
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
      }}
      className="sr-only left-3 top-3 z-[60] rounded-gh-pill bg-signal px-4 py-2 font-brand text-gh-sm font-medium text-signal-ink focus:not-sr-only focus:fixed focus-visible:outline-none focus-visible:shadow-gh-ring"
    >
      Skip to content
    </a>
  );
}
