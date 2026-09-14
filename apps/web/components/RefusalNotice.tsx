"use client";

import { UNATTRIBUTED_NOTE, describeRefusal, type RefusalInput } from "@grove/ui";
import { toRefusalInput } from "@/lib/api-error";

/**
 * §5.5 at the point of failure. A refused `say` used to land here as
 * `err.message` — the server's own prose, with no recourse and no hint of
 * WHOSE ceiling refused. The error body is a flattened `PolicyDecision`, so it
 * can say which; @grove/ui turns that into the sentence and the door.
 */

// Moved to lib/api-error.ts (pure, unit tested); re-exported so callers keep their import.
export { toRefusalInput };

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
        <p className="mt-0.5 text-[11px] text-white/50">{UNATTRIBUTED_NOTE}</p>
      ) : null}
    </div>
  );
}
