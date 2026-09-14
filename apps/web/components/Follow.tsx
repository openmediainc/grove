"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { followApiPath, followTargetKey, heartLabel, type FollowTarget, type WireFollow } from "@/lib/follow";
import { createFollowStateLoader, followStatePath, type HeartState } from "@/lib/follow-state";
import { GUEST_EVENT } from "@/lib/guest";
import type { ThemeLexicon } from "@/lib/themes/types";

type CardLex = ThemeLexicon["card"];

/**
 * One loader for the whole page session (queue #55): every heart mounted in the
 * same frame shares one batched request, and a follow here updates every other
 * heart for the same subject.
 */
export const followStates = createFollowStateLoader({
  fetchStates: async (keys) => (await api<{ states: Record<string, HeartState> }>(followStatePath(keys))).states ?? {},
});

/**
 * The heart. Follows a space or an agent so its errors, long tool calls and
 * Stage openings land in your inbox.
 *
 * A 404 (a private space you are not in, a pending agent) renders nothing at
 * all: the heart must not tell a reader what the map already withheld. Signed
 * out, it still works: the server keeps the follow on this browser's guest pass
 * (no notices until the visitor signs in, when it moves to their account), and
 * the button says "as a guest".
 */
export function FollowButton({
  target,
  signedIn,
  lex,
  name,
  className,
}: {
  target: FollowTarget | null;
  /** null while still finding out. */
  signedIn: boolean | null;
  lex: CardLex;
  /** What the sign-in page says you were following, if it comes to that. */
  name?: string;
  className?: string;
}) {
  const [state, setState] = useState<HeartState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = followTargetKey(target);

  useEffect(() => {
    if (!target) return;
    let live = true;
    const show = (v: HeartState | null) => {
      if (!live) return;
      setState(v);
      setHidden(v === null);
    };
    const known = followStates.peek(target);
    setErr(null);
    if (known !== undefined) show(known);
    else {
      setState(null);
      setHidden(false);
      followStates
        .load(target)
        .then(show)
        .catch(() => live && setHidden(true));
    }
    // Another heart for the same subject followed or unfollowed: say the same.
    const off = followStates.subscribe(target, show);
    return () => {
      live = false;
      off();
    };
    // Keyed on the target's identity, not the object.
  }, [key]);

  if (!target || hidden) return null;
  const base =
    className ??
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-white/15 px-4 py-2 text-xs text-white/70 hover:border-lantern-400/40 hover:text-lantern-300 sm:min-h-0 sm:py-1.5";

  const loginPath = () => {
    const next = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";
    const q = new URLSearchParams({ next, why: "follow", what: name ?? "" });
    return gp(`/login?${q.toString()}`);
  };

  const asGuest = signedIn === false;

  const toggle = async () => {
    if (!state || busy || !target) return;
    const on = !state.following;
    setBusy(true);
    setErr(null);
    // Optimistic: the heart answers the tap at once, and the server's count wins.
    setState({ following: on, followers: Math.max(0, state.followers + (on ? 1 : -1)) });
    try {
      const r = await api<{ follow: WireFollow }>(followApiPath(target), {
        method: on ? "PUT" : "DELETE",
        body: "{}",
      });
      // The server's answer replaces the cached state, here and on every other heart for it.
      followStates.set(target, { following: r.follow.following, followers: r.follow.followers });
      if (asGuest) window.dispatchEvent(new Event(GUEST_EVENT));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) followStates.set(target, null);
      else if (status === 401) window.location.href = loginPath();
      else {
        setState(state);
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={!state || busy}
      aria-pressed={state?.following ?? false}
      title={
        err ??
        (asGuest
          ? state?.following
            ? "Following as a guest in this browser. Sign in to get notified."
            : "Follow as a guest. Sign in later to get notified."
          : state?.following
            ? "Stop following"
            : "Follow: hear when it errors, finishes a long job or opens a Stage event")
      }
      className={`${base} disabled:opacity-60 ${state?.following ? "border-lantern-400/40 text-lantern-300" : ""}`}
    >
      <Heart on={state?.following ?? false} />
      <span aria-live="polite">{heartLabel(state, lex)}</span>
      {asGuest && state?.following ? <span className="text-[10px] text-white/35">as a guest</span> : null}
    </button>
  );
}

function Heart({ on }: { on: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
      <path d="M8 14s-5.5-3.4-5.5-7.3A3 3 0 0 1 8 4.5a3 3 0 0 1 5.5 2.2C13.5 10.6 8 14 8 14z" strokeLinejoin="round" />
    </svg>
  );
}
