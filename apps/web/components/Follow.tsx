"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { followApiPath, followTargetKey, heartLabel, type FollowTarget, type WireFollow } from "@/lib/follow";
import type { ThemeLexicon } from "@/lib/themes/types";

type CardLex = ThemeLexicon["card"];

/**
 * The heart. Follows a space or an agent so its errors, long tool calls and
 * Stage openings land in your inbox.
 *
 * A 404 (a private space you are not in, a pending agent) renders nothing at
 * all: the heart must not tell a reader what the map already withheld. Signed
 * out, it is a sign-in link that says what signing in is for.
 */
export function FollowButton({
  target,
  signedIn,
  lex,
  className,
}: {
  target: FollowTarget | null;
  /** null while still finding out. */
  signedIn: boolean | null;
  lex: CardLex;
  className?: string;
}) {
  const [state, setState] = useState<WireFollow | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = followTargetKey(target);

  useEffect(() => {
    if (!target) return;
    let live = true;
    setState(null);
    setHidden(false);
    setErr(null);
    api<{ follow: WireFollow }>(followApiPath(target))
      .then((r) => live && setState(r.follow))
      .catch(() => live && setHidden(true));
    return () => {
      live = false;
    };
    // Keyed on the target's identity, not the object.
  }, [key]);

  if (!target || hidden) return null;
  const base =
    className ??
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-white/15 px-4 py-2 text-xs text-white/70 hover:border-lantern-400/40 hover:text-lantern-300 sm:min-h-0 sm:py-1.5";

  const loginPath = () => {
    const next = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";
    const q = new URLSearchParams({ next, why: "follow", what: state?.name ?? "" });
    return gp(`/login?${q.toString()}`);
  };

  if (signedIn === false) {
    return (
      <a href={loginPath()} className={base} title="Sign in to follow and hear when something happens">
        <Heart on={false} />
        {heartLabel(state, lex)}
      </a>
    );
  }

  const toggle = async () => {
    if (!state || busy) return;
    const on = !state.following;
    setBusy(true);
    setErr(null);
    // Optimistic: the heart answers the tap at once, and the server's count wins.
    setState({ ...state, following: on, followers: Math.max(0, state.followers + (on ? 1 : -1)) });
    try {
      const r = await api<{ follow: WireFollow }>(followApiPath(target), {
        method: on ? "PUT" : "DELETE",
        body: "{}",
      });
      setState(r.follow);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setHidden(true);
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
      title={err ?? (state?.following ? "Stop following" : "Follow: hear when it errors, finishes a long job or opens a Stage event")}
      className={`${base} disabled:opacity-60 ${state?.following ? "border-lantern-400/40 text-lantern-300" : ""}`}
    >
      <Heart on={state?.following ?? false} />
      <span aria-live="polite">{heartLabel(state, lex)}</span>
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
