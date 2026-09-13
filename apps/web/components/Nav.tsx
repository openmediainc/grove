"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { SEARCH_EVENT } from "@/lib/search";
import {
  INBOX_SEEN_EVENT,
  UNREAD_PATH,
  UNREAD_POLL_MS,
  badgeText,
  inboxLabel,
  shouldPoll,
  unreadTotal,
  type WireUnread,
} from "@/lib/unread";
import {
  LOGOUT_PATH,
  ME_PATH,
  SIGNED_OUT,
  UNKNOWN,
  campusHref,
  isOperator,
  isSignedIn,
  profileHref,
  viewerFromHint,
  viewerFromMe,
  type Viewer,
} from "@/lib/viewer";

/**
 * One bar, two shapes. Wide enough and the sections sit inline as they always
 * have; on a phone the row cannot hold them — seven links plus the wordmark ran
 * 210px past a 390px screen and simply fell off the right edge — so they fold
 * into a disclosure the thumb can open. "Sign in" stays on the bar at every
 * width for a spectator: it is the one thing a visitor handed a phone is meant
 * to press. Signed in, it becomes the You menu (desktop) or a You section at the
 * foot of the disclosure (phone), with Sign out in both.
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

/**
 * Unseen messages plus follow notices. A signed-out visitor (no hint cookie)
 * sends nothing; a signed-in one asks once on load, then at most once a minute
 * while the tab is visible, and again when it comes back into view. /inbox
 * clears it the moment it has marked what it showed.
 */
function useUnread(): number {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let alive = true;
    let last = 0;
    const check = () => {
      if (!shouldPoll(document.cookie, document.visibilityState)) return;
      const now = Date.now();
      if (now - last < UNREAD_POLL_MS - 1_000) return;
      last = now;
      api<WireUnread>(UNREAD_PATH)
        .then((u) => alive && setTotal(unreadTotal(u)))
        .catch(() => alive && setTotal(0));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const onSeen = () => {
      last = Date.now();
      setTotal(0);
    };
    check();
    const timer = window.setInterval(check, UNREAD_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(INBOX_SEEN_EVENT, onSeen);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(INBOX_SEEN_EVENT, onSeen);
    };
  }, []);
  return total;
}

/**
 * Who is looking. The hint cookie gives the first guess with no request (a
 * spectator sends none); a hinted tab then asks /humans/me once for the handle
 * and the role, and a 401 there (an expired session) turns it back into a
 * spectator — the API clears the stale hint on the same response.
 */
function useViewer(): Viewer {
  const [viewer, setViewer] = useState<Viewer>(UNKNOWN);
  useEffect(() => {
    let alive = true;
    const guess = viewerFromHint(document.cookie);
    setViewer(guess);
    if (!isSignedIn(guess)) return;
    api<unknown>(ME_PATH)
      .then((body) => alive && setViewer(viewerFromMe(body)))
      .catch((e: { status?: number }) => {
        if (alive && e?.status === 401) setViewer(SIGNED_OUT);
      });
    return () => {
      alive = false;
    };
  }, []);
  return viewer;
}

/** Ends the session server-side (cookie + session key), then back to the map. */
async function signOut() {
  try {
    await api(LOGOUT_PATH, { method: "POST", body: "{}" });
  } catch {
    /* already gone: the map is still the right place to land */
  }
  window.location.href = gp("/");
}

function Badge({ total, className = "" }: { total: number; className?: string }) {
  const text = badgeText(total);
  if (!text) return null;
  return (
    <span
      aria-hidden
      className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-lantern-400 px-1.5 text-[11px] font-semibold leading-5 text-dusk-950 ${className}`}
    >
      {text}
    </span>
  );
}

/** Desktop: a small dropdown off the bar. Closes on a click elsewhere or Escape. */
function YouMenu({ viewer, unread }: { viewer: Viewer; unread: number }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const profile = profileHref(viewer);
  return (
    <div ref={ref} className="relative hidden sm:block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full border border-lantern-400/40 px-3 py-1 text-lantern-300"
      >
        You
        <Badge total={unread} />
        <span aria-hidden className="text-[10px] text-lantern-300/60">
          ▾
        </span>
        {unread > 0 ? <span className="sr-only">, {inboxLabel(unread)}</span> : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 flex w-48 flex-col rounded-xl border border-white/10 bg-dusk-900/95 p-1 text-sm shadow-xl backdrop-blur-md"
        >
          {profile ? (
            <Link role="menuitem" href={profile} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-white/5">
              Your page
            </Link>
          ) : null}
          <Link
            role="menuitem"
            href="/inbox"
            aria-label={inboxLabel(unread)}
            onClick={() => setOpen(false)}
            className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-white/5"
          >
            Inbox
            <Badge total={unread} />
          </Link>
          <button
            role="menuitem"
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
            className="rounded-lg px-3 py-2 text-left text-white/70 hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Nav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const unread = useUnread();
  const viewer = useViewer();
  const signedIn = isSignedIn(viewer);
  const profile = profileHref(viewer);

  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-white/5 bg-dusk-950/50 px-4 py-2.5 backdrop-blur-md sm:px-6 sm:py-3">
      <Link href="/" onClick={close} className="flex items-center gap-3 py-1.5 sm:py-0">
        <span className="lantern" />
        <span className="font-display text-xl tracking-wide text-lantern-300">Grove</span>
      </Link>

      <div className="flex items-center gap-2 sm:hidden">
        <SearchButton className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-lg text-lantern-300/80" />
        {viewer.state === "signed-out" ? (
          <Link
            href="/login"
            onClick={close}
            className="rounded-full border border-lantern-400/40 px-4 py-2 text-sm text-lantern-300"
          >
            Sign in
          </Link>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="grove-sections"
          onClick={() => setOpen((o) => !o)}
          className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-lantern-300/80"
        >
          {!open ? <Badge total={unread} className="absolute -right-1 -top-1" /> : null}
          <span aria-hidden className="text-xl leading-none">
            {open ? "×" : "≡"}
          </span>
          <span className="sr-only">
            {open ? "Close menu" : "Open menu"}
            {unread > 0 ? `, ${inboxLabel(unread)}` : ""}
          </span>
        </button>
      </div>

      <nav
        id="grove-sections"
        onClick={close}
        className={`${
          open ? "flex" : "hidden"
        } w-full basis-full flex-col items-stretch gap-0.5 pb-2 text-sm text-lantern-300/80 sm:flex sm:w-auto sm:basis-auto sm:flex-row sm:items-center sm:gap-5 sm:pb-0`}
      >
        <Link href={campusHref(viewer)} className={ITEM}>
          Campus
        </Link>
        <Link href="/spaces" className={ITEM}>
          Spaces
        </Link>
        <Link href="/chronicle" className={ITEM}>
          Chronicle
        </Link>
        <Link href="/studio" className={ITEM}>
          Studio
        </Link>
        {isOperator(viewer) ? (
          <Link href="/mod" className={ITEM}>
            Mod
          </Link>
        ) : null}
        <Link href="/how-it-works" className={ITEM}>
          How it works
        </Link>
        <SearchButton className="hidden items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-lantern-300/80 hover:text-lantern-300 sm:flex" />
        {viewer.state === "signed-out" ? (
          <Link
            href="/login"
            className="hidden rounded-full border border-lantern-400/40 px-3 py-1 text-lantern-300 sm:block"
          >
            Sign in
          </Link>
        ) : null}
        {signedIn ? <YouMenu viewer={viewer} unread={unread} /> : null}
        {signedIn ? (
          <div className="mt-1 flex flex-col gap-0.5 border-t border-white/10 pt-1 sm:hidden">
            <span className="px-3 pt-2 text-[11px] uppercase tracking-widest text-white/35">You</span>
            {profile ? (
              <Link href={profile} className={ITEM}>
                Your page
              </Link>
            ) : null}
            <Link href="/inbox" aria-label={inboxLabel(unread)} className={`${ITEM} flex items-center gap-1.5`}>
              Inbox
              <Badge total={unread} />
            </Link>
            <button type="button" onClick={() => void signOut()} className={`${ITEM} text-left`}>
              Sign out
            </button>
          </div>
        ) : null}
      </nav>
    </header>
  );
}
