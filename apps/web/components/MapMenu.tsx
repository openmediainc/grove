"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { onMenuKeyDown, useDialogFocus, useMenuButton } from "./a11y";

/**
 * The map's consolidated controls: Go to ▾, Watch ▾ and ⋯ are each one of
 * these. A button and a list that opens upward (the controls live at the
 * bottom of the screen), closed by a pick, a click elsewhere, or Escape.
 *
 * Keyboard (#67, the APG menu button): Enter, Space or ArrowDown on the button
 * opens with focus on the first item; arrows, Home/End and a typed letter move
 * (roving tabindex); Escape or a pick closes and focus returns to the button;
 * Tab leaves and closes. A control inside that is not an item (theme select,
 * volume) is reached with Tab and keeps its own arrows.
 */
export function MapMenu({
  label,
  ariaLabel,
  title,
  align = "right",
  children,
  className = "",
}: {
  label: ReactNode;
  /** The button's accessible name when the label is a glyph (⋯). */
  ariaLabel?: string;
  title: string;
  /** Which edge the list lines up with, so it never runs off the screen. */
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const onButtonKey = useMenuButton(open, setOpen, ref, buttonRef, menuRef);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} data-menu-root className={`pointer-events-auto relative ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
        className={`flex h-11 items-center gap-1 rounded-full border px-4 text-xs uppercase tracking-widest sm:h-9 ${
          open ? "border-lantern-400/60 bg-dusk-900/95 text-lantern-300" : "border-white/15 bg-dusk-950/80 text-white/80"
        }`}
      >
        {label}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={ariaLabel ?? title}
          onKeyDown={onMenuKeyDown}
          className={`absolute bottom-full mb-2 max-h-[60svh] w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-white/15 bg-dusk-950/[0.97] p-1.5 text-sm normal-case tracking-normal shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

const ITEM =
  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-white/80 hover:bg-white/5 hover:text-lantern-300 sm:py-2";

export function MenuItem({
  onSelect,
  hint,
  children,
  title,
}: {
  onSelect: () => void;
  hint?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button type="button" role="menuitem" tabIndex={-1} onClick={onSelect} title={title} className={ITEM}>
      <span className="min-w-0 truncate">{children}</span>
      {hint ? (
        <kbd className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-sans text-[10px] uppercase leading-none text-white/55">
          {hint}
        </kbd>
      ) : null}
    </button>
  );
}

export function MenuLink({ href, children, onSelect }: { href: string; children: ReactNode; onSelect: () => void }) {
  return (
    <Link role="menuitem" tabIndex={-1} href={href} onClick={onSelect} className={ITEM}>
      {children}
    </Link>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <p role="presentation" className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-white/50 first:pt-1">
      {children}
    </p>
  );
}

/** A small panel over the map (keyboard help, legend), with its own close. */
export function MapPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(ref, { onEscape: onClose });
  return (
    <div
      ref={ref}
      data-a11y-dialog
      role="dialog"
      aria-labelledby={titleId}
      data-speech-avoid
      className="pointer-events-auto absolute inset-x-4 bottom-24 z-30 max-h-[60svh] overflow-y-auto rounded-2xl border border-white/15 bg-dusk-950/[0.97] p-4 text-sm shadow-2xl sm:inset-x-auto sm:left-6 sm:w-80"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-[10px] uppercase tracking-[0.25em] text-lantern-400/80">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-2 flex h-11 w-11 items-center justify-center rounded-full text-xl text-white/50 hover:text-white sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** Every key the map answers to, in one place. Kept beside the handler's list in WorldMap. */
export const MAP_KEYS: ReadonlyArray<{ keys: string; what: string }> = [
  { keys: "1–6", what: "Go to a room" },
  { keys: "B", what: "Busiest room" },
  { keys: "M", what: "My space" },
  { keys: "0", what: "Reset view" },
  { keys: "+ / −", what: "Zoom" },
  { keys: ".", what: "Next body that wants attention" },
  { keys: "H", what: "History and replay" },
  { keys: "V", what: "TV" },
  { keys: "K", what: "Kiosk" },
  { keys: "T", what: "Next theme" },
  { keys: "/", what: "Search" },
  { keys: "Double-click", what: "Follow a body" },
  { keys: "Esc", what: "Close, release, leave" },
];

/**
 * The first-visit card: what you are looking at, in three lines, once.
 * Dismissed for good in this browser (lib/walk-in FIRST_VISIT_KEY).
 */
export function FirstVisitCard({ onDismiss, howHref }: { onDismiss: () => void; howHref: string }) {
  return (
    <div
      data-speech-avoid
      className="pointer-events-auto w-full max-w-sm rounded-2xl border border-lantern-400/25 bg-dusk-950/90 p-3 text-sm shadow-xl sm:p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-display text-lg leading-tight text-lantern-300">What you&apos;re looking at</h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-white/50 hover:text-white sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>
      <ul className="mt-1 space-y-1 text-[13px] leading-snug text-white/70">
        <li>A live world. Every body is a person or an agent, and what an agent does is drawn where it does it.</li>
        <li>The ring and mark beside a body say what it is doing; a red triangle means it wants a human.</li>
        <li>Tap anyone, any room or any plot to see what is public. Double-click a body to follow it.</li>
      </ul>
      <Link href={howHref} className="mt-2 inline-block text-xs text-lantern-300 underline-offset-2 hover:underline">
        How it works →
      </Link>
    </div>
  );
}
