"use client";

import { ConsequenceLine, asPermissionBadges, type RefusalInput } from "@grove/ui";
import type { Nearby } from "@/lib/api";
import { nameFor } from "@/lib/whisper";
import { RefusalNotice } from "@/components/RefusalNotice";

export type WhisperCheckState =
  | { status: "checking" }
  | { status: "allowed" }
  | { status: "refused"; refusal: RefusalInput }
  /** The check itself failed (network, a read limit). Say so; do not block the send. */
  | { status: "unknown" };

/**
 * The "whispering to X" mode above the compose box. Three jobs:
 *
 *  1. make the mode impossible to miss, with one obvious way back to the room;
 *  2. say, BEFORE anything is typed, whether X can receive it — the kernel's
 *     answer, rendered through `describeRefusal` like any other refusal;
 *  3. say what a whisper is: private, and not part of the room transcript.
 */
export function WhisperBar({
  target,
  check,
  inRoom,
  onCancel,
}: {
  target: Nearby;
  check: WhisperCheckState;
  /** False once they have walked out: a whisper still reaches them, but say so. */
  inRoom: boolean;
  onCancel: () => void;
}) {
  const name = nameFor(target);
  const badges = asPermissionBadges(target.badges);
  return (
    <div className="mb-2 rounded-gh-md border border-pane/60 bg-surface-raised px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-ink">
          <span className="mr-1.5 rounded-gh-sm border border-pane/60 px-1.5 py-0.5 gh-label text-ink">
            Whisper
          </span>
          to <strong className="font-semibold">{name}</strong>
          {target.kind === "agent" ? <span className="text-muted"> (agent)</span> : null}
          {inRoom ? null : <span className="text-muted"> · has left this room</span>}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-gh-pill border border-pane/60 bg-surface-raised px-3 py-1 text-xs text-ink hover:bg-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Back to the room <span className="hidden text-muted sm:inline">(Esc)</span>
        </button>
      </div>
      <div aria-live="polite">
        {check.status === "checking" ? (
          <p className="mt-1 text-xs text-muted">Checking whether {name} can receive a whisper from you…</p>
        ) : null}
        {check.status === "allowed" ? (
          <p className="mt-1 text-xs text-muted">
            Only {name} gets this. It is not added to the room transcript.
            {/* Whether they can answer is their matrix, and it is worth knowing
                before you wait for a reply that cannot come. */}
            {target.kind === "agent" ? <ConsequenceLine badges={badges} /> : null}
          </p>
        ) : null}
        {check.status === "unknown" ? (
          <p className="mt-1 text-xs text-muted">
            Could not check whether {name} can receive this. You can still send it; if it does not land, this will say why.
          </p>
        ) : null}
        {check.status === "refused" ? (
          <>
            {/* The refusal sentences are written for after the fact; this says
                it is the answer you would get, before anything is lost. */}
            <p className="mt-1 text-xs text-muted">A whisper to {name} would not land:</p>
            <RefusalNotice input={check.refusal} />
          </>
        ) : null}
      </div>
    </div>
  );
}
