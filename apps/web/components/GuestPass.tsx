"use client";

import Link from "next/link";
import { buttonClass } from "@/lib/brand-ui";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  GUEST_EVENT,
  GUEST_PATH,
  guestChipLabel,
  guestFollowHref,
  guestFollowLine,
  guestSignInHref,
  hasGuestHint,
  type WireGuest,
  type WireGuestFollow,
} from "@/lib/guest";

/**
 * The signed-out visitor's "From what you follow": the nav's You menu, for a
 * browser holding a guest pass. Nothing is shown (and nothing is asked) until
 * this browser has reacted or followed; a lurker never sees it.
 *
 * Deliberately small: a list of what you follow, one line saying signing in is
 * what turns follows into notices, and a way to forget this browser.
 */
export function GuestPass() {
  const [follows, setFollows] = useState<WireGuestFollow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (!hasGuestHint(document.cookie)) {
        setFollows(null);
        return;
      }
      api<WireGuest>(GUEST_PATH)
        .then((r) => alive && setFollows(r.guest.follows))
        .catch(() => alive && setFollows(null));
    };
    load();
    window.addEventListener(GUEST_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(GUEST_EVENT, load);
    };
  }, []);

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

  if (follows === null) return null;
  const next = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";

  const forget = async () => {
    setBusy(true);
    try {
      await api(GUEST_PATH, { method: "DELETE", body: "{}" });
    } catch {
      /* gone either way */
    }
    window.location.reload();
  };

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        title="You are reacting and following as a guest in this browser"
        className="flex w-full items-center gap-1.5 rounded-gh-md px-3 py-3 text-left text-gh-sm text-ink hover:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-8 sm:w-auto sm:rounded-gh-pill sm:border sm:border-line-strong sm:bg-surface-raised sm:py-0"
      >
        <span aria-hidden>♥</span>
        {guestChipLabel(follows.length)}
        <span aria-hidden className="text-[10px] text-muted">
          ▾
        </span>
      </button>
      {open ? (
        <div className="z-30 mt-1 flex w-full flex-col gap-1 rounded-gh-md border border-line bg-surface-raised p-2 text-gh-sm text-ink shadow-gh-3 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-64">
          <span className="gh-label px-2 pt-1 text-muted">From what you follow</span>
          {follows.length ? (
            <ul className="flex flex-col">
              {follows.map((f) => (
                <li key={`${f.subject}:${f.id}`}>
                  <Link
                    href={guestFollowHref(f)}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center justify-between gap-2 rounded-gh-sm px-2 text-ink hover:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-8"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className="gh-label shrink-0 text-muted">{f.subject}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="px-2 text-gh-xs text-muted">{guestFollowLine(follows.length)}</p>
          <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-1">
            <Link href={guestSignInHref(next)} className={buttonClass("primary", "sm")}>
              Sign in
            </Link>
            <button
              type="button"
              disabled={busy}
              onClick={() => void forget()}
              title="Delete this browser's guest reactions and follows"
              className="rounded-gh-sm text-gh-xs text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:shadow-gh-ring disabled:opacity-50"
            >
              Forget this browser
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
