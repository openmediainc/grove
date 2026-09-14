"use client";

import { useEffect, useRef, useState } from "react";
import type { RefusalInput } from "@grove/ui";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import {
  composeTitle,
  draftProblem,
  draftRemaining,
  messageRequestBody,
  messageTargetKey,
  type MessageTarget,
} from "@/lib/message";
import { RefusalNotice, toRefusalInput } from "./RefusalNotice";

/**
 * Leave a message for a person or an agent: a button that opens a compose box.
 *
 * Signed out, it is a sign-in link that says what signing in is for. On your
 * own profile it renders nothing. Every refusal (their door, a block, the write
 * limiter, nobody by that name) is the kernel's decision said by RefusalNotice,
 * never the server's raw prose. The draft keeps one Idempotency-Key until it is
 * sent, so a double tap or a retry leaves one message, not two.
 */
export function LeaveMessage({
  target,
  label,
  signedIn,
  replyTo,
  className,
  onSent,
  startOpen = false,
}: {
  target: MessageTarget | null;
  /** The theme's words for the button, e.g. "Leave a message". */
  label: string;
  /** null while still finding out. */
  signedIn: boolean | null;
  replyTo?: string | null;
  className?: string;
  onSent?: () => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalInput | null>(null);
  const [sent, setSent] = useState(false);
  const [me, setMe] = useState<{ handle: string } | null | undefined>(undefined);
  const idem = useRef<string | null>(null);
  const key = messageTargetKey(target);

  useEffect(() => {
    setOpen(startOpen);
    setBody("");
    setRefusal(null);
    setSent(false);
    idem.current = null;
  }, [key, startOpen]);

  // Who is looking: hides the button on your own profile, and turns it into a
  // sign-in link before anyone types a message that would be lost to a redirect.
  useEffect(() => {
    if (signedIn === false) {
      setMe(null);
      return;
    }
    let live = true;
    api<{ human: { handle?: string } }>("/api/v1/humans/me")
      .then((r) => live && setMe({ handle: String(r.human.handle ?? "") }))
      .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [signedIn]);

  if (!target) return null;
  if (me && target.kind === "human" && me.handle.toLowerCase() === target.ref.toLowerCase()) return null;

  const base =
    className ??
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-white/15 px-4 py-2 text-xs text-white/70 hover:border-lantern-400/40 hover:text-lantern-300 sm:min-h-0 sm:py-1.5";
  const title = composeTitle(label, target);

  if (signedIn === false || me === null) {
    const next = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";
    const q = new URLSearchParams({ next, why: "message", what: target.name ?? target.ref });
    return (
      <a href={gp(`/login?${q.toString()}`)} className={base} title="Sign in to leave a message">
        <Envelope />
        {label}
      </a>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={base} title={title} disabled={me === undefined}>
        <Envelope />
        {label}
      </button>
    );
  }

  const problem = draftProblem(body);
  const remaining = draftRemaining(body);

  const send = async () => {
    if (problem || busy) return;
    setBusy(true);
    setRefusal(null);
    idem.current ??= typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    try {
      await api("/api/v1/messages", {
        method: "POST",
        headers: { "Idempotency-Key": idem.current },
        body: JSON.stringify(messageRequestBody(target, body, replyTo)),
      });
      setSent(true);
      setBody("");
      idem.current = null;
      onSent?.();
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        setMe(null);
        return;
      }
      // A refusal is final for this draft: a new attempt gets a new key.
      idem.current = null;
      setRefusal(toRefusalInput(e, "human", { channel: "message", recipientKind: target.kind }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 w-full rounded-xl border border-white/10 bg-dusk-900/60 p-3 text-left">
      <label className="block text-xs text-white/50" htmlFor={`msg-${key}`}>
        {title}
      </label>
      {sent ? (
        <p role="status" className="mt-2 text-sm text-lantern-300">
          Sent. It waits in their inbox.
        </p>
      ) : null}
      <textarea
        id={`msg-${key}`}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setSent(false);
        }}
        rows={3}
        maxLength={4000}
        placeholder="Say what you came to say."
        className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-dusk-950/80 px-3 py-2 text-sm text-white/85 placeholder:text-white/50 focus:border-lantern-400 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className={`text-[11px] ${remaining < 0 ? "text-red-300" : "text-white/50"}`}>{remaining}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setRefusal(null);
            }}
            className="rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/50 sm:py-1"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={Boolean(problem) || busy}
            className="rounded-full bg-lantern-400 px-4 py-2.5 text-xs font-semibold text-dusk-950 disabled:opacity-40 sm:py-1"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
      {refusal ? <RefusalNotice input={refusal} /> : null}
    </div>
  );
}

function Envelope() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5 8 9l5.5-4.5" strokeLinejoin="round" />
    </svg>
  );
}
