"use client";

import { UNATTRIBUTED_NOTE, describeRefusal, type RefusalInput } from "@grove/ui";

/**
 * §5.5 at the point of failure. A refused `say` used to land here as
 * `err.message` — the server's own prose, with no recourse and no hint of
 * WHOSE ceiling refused. The error body is a flattened `PolicyDecision`, so it
 * can say which; @grove/ui turns that into the sentence and the door.
 */

type ApiErrorShape = {
  status?: number;
  code?: string;
  message?: string;
  body?: {
    error?: {
      code?: string;
      message?: string;
      capability?: string;
      hint?: string;
      source?: string;
      subject?: string;
      /** #62: sender or recipient, on ceiling refusals too. */
      party?: string;
      membership?: string;
      /** Seconds, on a 429: the refusing limiter's own TTL (http.ts). */
      retry_after?: number;
    };
  };
};

/** Pull the decision out of whatever `api()` threw, without trusting any of it. */
export function toRefusalInput(
  err: unknown,
  senderKind: "human" | "agent",
  extra: Pick<RefusalInput, "channel" | "recipientKind"> = {},
): RefusalInput {
  const e = (err ?? {}) as ApiErrorShape;
  const body = e.body?.error;
  const source = body?.source;
  const subject = body?.subject;
  const code = body?.code ?? e.code;
  // The server already says how long the limiter holds; "wait a moment" is
  // kinder with the moment attached.
  const retry =
    code === "RATE_LIMITED" && typeof body?.retry_after === "number" && body.retry_after > 0
      ? `Try again in ${body.retry_after}s.`
      : undefined;
  return {
    ...extra,
    code,
    capability: body?.capability,
    source: source === "actor" || source === "space" || source === "room" ? source : undefined,
    membership: body?.membership === "member" || body?.membership === "non_member" ? body.membership : undefined,
    subject: subject === "sender" || subject === "recipient" ? subject : undefined,
    party: body?.party === "sender" || body?.party === "recipient" ? body.party : undefined,
    message: body?.message ?? e.message,
    hint: body?.hint ?? retry,
    senderKind,
  };
}

export function RefusalNotice({ input }: { input: RefusalInput }) {
  const refusal = describeRefusal(input);
  return (
    <div
      role="status"
      className="mt-2 rounded-lg border border-red-400/30 bg-red-500/5 px-3 py-2 text-sm"
    >
      <p className="text-red-200">{refusal.headline}</p>
      {refusal.recourse ? <p className="mt-0.5 text-white/60">{refusal.recourse}</p> : null}
      {/* The hint is the API's own actionable suggestion (e.g. "use owner_reply").
          Shown only when it adds something the sentence above does not. */}
      {refusal.hint ? <p className="mt-0.5 text-white/50">{refusal.hint}</p> : null}
      {/* Say the gap out loud rather than pointing at a door we guessed. */}
      {refusal.attribution === "unknown" ? (
        <p className="mt-0.5 text-[11px] text-white/35">{UNATTRIBUTED_NOTE}</p>
      ) : null}
    </div>
  );
}
