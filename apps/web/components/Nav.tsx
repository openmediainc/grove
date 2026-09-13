"use client";

import Link from "next/link";
import { useState } from "react";
import { SEARCH_EVENT } from "@/lib/search";

/**
 * One bar, two shapes. Wide enough and the sections sit inline as they always
 * have; on a phone the row cannot hold them — seven links plus the wordmark ran
 * 210px past a 390px screen and simply fell off the right edge — so they fold
 * into a disclosure the thumb can open. "Enter" stays on the bar at every width:
 * it is the one thing a visitor handed a phone is meant to press.
 */

/** Mobile: a full-width row you can hit. Desktop: back to a plain inline link. */
const ITEM =
  "rounded-lg px-3 py-3 hover:bg-white/5 sm:rounded-none sm:px-0 sm:py-0 sm:hover:bg-transparent";

/** Opens the `/` search palette (components/SearchPalette), for thumbs and mice. */
function SearchButton({ className }: { className: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(SEARCH_EVENT))}
      title="Search (/)"
      className={className}
    >
      <span aria-hidden>⌕</span>
      <span aria-hidden className="hidden text-xs text-white/40 sm:inline">/</span>
      <span className="sr-only">Search agents, people, spaces and rooms</span>
    </button>
  );
}

export function Nav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-white/5 bg-dusk-950/50 px-4 py-2.5 backdrop-blur-md sm:px-6 sm:py-3">
      <Link href="/" onClick={close} className="flex items-center gap-3 py-1.5 sm:py-0">
        <span className="lantern" />
        <span className="font-display text-xl tracking-wide text-lantern-300">Grove</span>
      </Link>

      <div className="flex items-center gap-2 sm:hidden">
        <SearchButton className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-lg text-lantern-300/80" />
        <Link
          href="/login"
          onClick={close}
          className="rounded-full border border-lantern-400/40 px-4 py-2 text-sm text-lantern-300"
        >
          Enter
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="grove-sections"
          onClick={() => setOpen((o) => !o)}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-lantern-300/80"
        >
          <span aria-hidden className="text-xl leading-none">
            {open ? "×" : "≡"}
          </span>
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </div>

      <nav
        id="grove-sections"
        onClick={close}
        className={`${
          open ? "flex" : "hidden"
        } w-full basis-full flex-col items-stretch gap-0.5 pb-2 text-sm text-lantern-300/80 sm:flex sm:w-auto sm:basis-auto sm:flex-row sm:items-center sm:gap-5 sm:pb-0`}
      >
        <Link href="/w/plaza" className={ITEM}>
          Campus
        </Link>
        <Link href="/spaces" className={ITEM}>
          Spaces
        </Link>
        <Link href="/chronicle" className={ITEM}>
          Chronicle
        </Link>
        <Link href="/inbox" className={ITEM}>
          Inbox
        </Link>
        <Link href="/studio" className={ITEM}>
          Studio
        </Link>
        <Link href="/mod" className={ITEM}>
          Mod
        </Link>
        <Link href="/docs" className={ITEM}>
          Docs
        </Link>
        <SearchButton className="hidden items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-lantern-300/80 hover:text-lantern-300 sm:flex" />
        <Link
          href="/login"
          className="hidden rounded-full border border-lantern-400/40 px-3 py-1 text-lantern-300 sm:block"
        >
          Enter
        </Link>
      </nav>
    </header>
  );
}
