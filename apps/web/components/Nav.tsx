"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { lockupSvg } from "@grove/ui/tokens";
import { AppearanceMenuGroup, AppearanceRadios } from "./Appearance";
import {
  BADGE_CLASS,
  ICON_BUTTON_CLASS,
  MENU_CLASS,
  MENU_HEADING_CLASS,
  buttonClass,
  menuItemClass,
  navLinkClass,
} from "@/lib/brand-ui";
import { api } from "@/lib/api";
import { signOut } from "@/lib/session";
import { GuestPass } from "./GuestPass";
import { onMenuKeyDown, useMenuButton } from "./a11y";
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
      <span aria-hidden className="hidden text-gh-sm sm:inline">
        Search
      </span>
      <kbd aria-hidden className="hidden rounded-gh-sm border border-line px-1.5 font-brand-mono text-[11px] leading-4 text-muted sm:inline">
        /
      </kbd>
      <span className="sr-only">Search agents, people, spaces and rooms</span>
    </button>
  );
}

const LOCKUP = lockupSvg("light", "currentColor");

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


function Badge({ total, className = "" }: { total: number; className?: string }) {
  const text = badgeText(total);
  if (!text) return null;
  return (
    <span aria-hidden className={`${BADGE_CLASS} ${className}`}>
      {text}
    </span>
  );
}

/** Desktop: a small dropdown off the bar. Closes on a click elsewhere or Escape. */
function YouMenu({ viewer, unread }: { viewer: Viewer; unread: number }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onButtonKey = useMenuButton(open, setOpen, ref, buttonRef, menuRef);
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
  const handle = viewer.state === "signed-in" ? viewer.handle : null;
  return (
    <div ref={ref} data-menu-root className="relative hidden sm:block" onClick={(e) => e.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? "grove-you-menu" : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
        className={`${buttonClass("secondary", "sm")} before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-human before:content-['']`}
      >
        You
        <Badge total={unread} />
        <span aria-hidden className="text-[10px] text-muted">
          ▾
        </span>
        {unread > 0 ? <span className="sr-only">, {inboxLabel(unread)}</span> : null}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id="grove-you-menu"
          role="menu"
          aria-label="You"
          onKeyDown={onMenuKeyDown}
          className={`absolute right-0 top-full z-30 mt-2 flex w-56 flex-col ${MENU_CLASS}`}
        >
          {handle ? (
            <p role="presentation" className={`${MENU_HEADING_CLASS} truncate normal-case`}>
              <span className="text-human">●</span> @{handle}
            </p>
          ) : null}
          <Link role="menuitem" tabIndex={-1} href="/me" onClick={() => setOpen(false)} className={menuItemClass()}>
            You
          </Link>
          {profile ? (
            <Link role="menuitem" tabIndex={-1} href={profile} onClick={() => setOpen(false)} className={menuItemClass()}>
              Your page
            </Link>
          ) : null}
          <Link
            role="menuitem"
            tabIndex={-1}
            href="/inbox"
            aria-label={inboxLabel(unread)}
            onClick={() => setOpen(false)}
            className={menuItemClass()}
          >
            Inbox
            <Badge total={unread} />
          </Link>
          <div role="separator" className="my-1 h-px bg-line" />
          <AppearanceMenuGroup />
          <div role="separator" className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            tabIndex={-1}
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
            className={menuItemClass()}
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
  const pathname = usePathname() ?? "/";
  const link = (href: string, label: string, match: (p: string) => boolean = (p) => p === href) => {
    const current = match(pathname);
    return (
      <Link href={href} aria-current={current ? "page" : undefined} className={navLinkClass(current)}>
        {label}
      </Link>
    );
  };

  return (
    <header className="gh-frost sticky top-0 z-20 flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 font-brand text-ink shadow-gh-1 sm:px-6">
      <Link
        href="/"
        onClick={close}
        className="-mx-1 flex items-center rounded-gh-md px-1 py-2 text-ink focus-visible:outline-none focus-visible:shadow-gh-ring"
      >
        {/* The lockup in currentColor: mullion ink by day, mist by night, lit pane always signal. */}
        <span className="block h-6 [&>svg]:h-full [&>svg]:w-auto" dangerouslySetInnerHTML={{ __html: LOCKUP }} />
      </Link>

      <div className="flex items-center gap-2 sm:hidden">
        <SearchButton className={`${ICON_BUTTON_CLASS} text-lg`} />
        {viewer.state === "signed-out" ? (
          <Link href="/login" onClick={close} className={buttonClass("primary", "md")}>
            Sign in
          </Link>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls="grove-sections"
          onClick={() => setOpen((o) => !o)}
          className={`relative ${ICON_BUTTON_CLASS}`}
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
        aria-label="Sections"
        onClick={(e) => {
          // A pick closes the disclosure; the Appearance radios keep it open.
          if (!(e.target as HTMLElement).closest("fieldset")) close();
        }}
        className={`${
          open ? "flex" : "hidden"
        } w-full basis-full flex-col items-stretch gap-0.5 pb-2 sm:flex sm:w-auto sm:basis-auto sm:flex-row sm:items-center sm:gap-1 sm:pb-0`}
      >
        {link(campusHref(viewer), "World", (p) => p === "/")}
        {link("/explore", "Explore", (p) => p.startsWith("/explore"))}
        <Link href="/?history=1" className={navLinkClass(false)}>
          History
        </Link>
        {isOperator(viewer) ? link("/mod", "Mod", (p) => p.startsWith("/mod")) : null}
        {link("/how-it-works", "How it works")}
        <SearchButton className={`hidden sm:ml-2 sm:inline-flex ${buttonClass("secondary", "sm", "text-muted hover:text-ink")}`} />
        {/* A signed-out browser holding a guest pass: what it follows. Renders nothing otherwise. */}
        {viewer.state === "signed-out" ? <GuestPass /> : null}
        {viewer.state === "signed-out" ? (
          <Link href="/login" className={`hidden sm:inline-flex ${buttonClass("primary", "sm")}`}>
            Sign in
          </Link>
        ) : null}
        {signedIn ? <YouMenu viewer={viewer} unread={unread} /> : null}
        {signedIn ? (
          <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1 sm:hidden">
            <span className={MENU_HEADING_CLASS}>You</span>
            <Link href="/me" className={navLinkClass(pathname === "/me")}>
              Your agents and spaces
            </Link>
            {profile ? (
              <Link href={profile} className={navLinkClass(pathname === profile)}>
                Your page
              </Link>
            ) : null}
            <Link href="/inbox" aria-label={inboxLabel(unread)} className={`${navLinkClass(pathname === "/inbox")} flex items-center gap-1.5`}>
              Inbox
              <Badge total={unread} />
            </Link>
            <button type="button" onClick={() => void signOut()} className={`${navLinkClass(false)} text-left`}>
              Sign out
            </button>
          </div>
        ) : null}
        <div className="mt-1 border-t border-line pt-1 sm:hidden">
          <AppearanceRadios />
        </div>
      </nav>
    </header>
  );
}
