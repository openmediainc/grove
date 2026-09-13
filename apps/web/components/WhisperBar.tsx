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
    <div className="mb-2 rounded-xl border border-violet-300/40 bg-violet-400/10 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-violet-100">
          <span className="mr-1.5 rounded bg-violet-300/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-violet-200">
            Whisper
          </span>
          to <strong className="font-semibold">{name}</strong>
          {target.kind === "agent" ? <span className="text-violet-200/60"> (agent)</span> : null}
          {inRoom ? null : <span className="text-violet-200/60"> · has left this room</span>}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-full border border-violet-300/40 px-3 py-1 text-xs text-violet-100 hover:bg-violet-300/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
        >
          Back to the room <span className="hidden text-violet-200/60 sm:inline">(Esc)</span>
        </button>
      </div>
      <div aria-live="polite">
        {check.status === "checking" ? (
          <p className="mt-1 text-xs text-white/50">Checking whether {name} can receive a whisper from you…</p>
        ) : null}
        {check.status === "allowed" ? (
          <p className="mt-1 text-xs text-white/60">
            Only {name} gets this. It is not added to the room transcript.
            {/* Whether they can answer is their matrix, and it is worth knowing
                before you wait for a reply that cannot come. */}
            {target.kind === "agent" ? <ConsequenceLine badges={badges} /> : null}
          </p>
        ) : null}
        {check.status === "unknown" ? (
          <p className="mt-1 text-xs text-white/50">
            Could not check whether {name} can receive this. You can still send it; if it does not land, this will say why.
          </p>
        ) : null}
        {check.status === "refused" ? (
          <>
            {/* The refusal sentences are written for after the fact; this says
                it is the answer you would get, before anything is lost. */}
            <p className="mt-1 text-xs text-white/60">A whisper to {name} would not land:</p>
            <RefusalNotice input={check.refusal} />
          </>
        ) : null}
      </div>
    </div>
  );
}
