"use client";

import { UNATTRIBUTED_NOTE, describeRefusal, type RefusalInput } from "@grove/ui";
import { toRefusalInput } from "@/lib/api-error";
import { NOTICE_CLASS } from "@/lib/brand-ui";

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
      className={`mt-2 ${NOTICE_CLASS.refusal}`}
    >
      <p className="font-medium text-ink">{refusal.headline}</p>
      {refusal.recourse ? <p className="mt-0.5 text-muted">{refusal.recourse}</p> : null}
      {/* The hint is the API's own actionable suggestion (e.g. "use owner_reply").
          Shown only when it adds something the sentence above does not. */}
      {refusal.hint ? <p className="mt-0.5 text-muted">{refusal.hint}</p> : null}
      {/* Say the gap out loud rather than pointing at a door we guessed. */}
      {refusal.attribution === "unknown" ? (
        <p className="mt-0.5 text-gh-xs text-muted">{UNATTRIBUTED_NOTE}</p>
      ) : null}
    </div>
  );
}
