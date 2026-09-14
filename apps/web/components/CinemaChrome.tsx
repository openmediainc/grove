"use client";

import { SEQUENCE_MAX_SHOTS, SEQUENCE_MAX_TOTAL_MS, SEQUENCE_TITLE_MAX, type SequenceShotKind } from "@grove/protocol";
import { SHOT_KINDS, SHOT_LABEL, canAddShot, draftDuration, formatRunTime, type Draft } from "@/lib/sequence";

/**
 * Cinematic sequences (#39): the two pieces of chrome.
 *
 *  - `SequenceRecorder`: a small panel over the map while recording. The
 *    viewer moves the camera the ordinary way (drag, pinch, Go to, follow a
 *    body) and presses Add shot; each shot ends where the camera is. Preview
 *    plays it; Copy link shares it.
 *  - `CinemaBars`: letterbox bars while a sequence plays. Everything else on
 *    the map is hidden, the way TV hides it; the bottom bar keeps the title,
 *    the run time, Postcard, Play again and the way out (Esc).
 *
 * Neutral page copy (DECISIONS #3): nothing here is drawn on the map, so no
 * theme words.
 */

const SECONDS = [2, 3, 5, 8, 12, 20] as const;

const BUTTON =
  "flex h-11 items-center justify-center rounded-gh-pill border border-line-strong bg-surface-raised px-3 text-gh-xs text-ink hover:bg-tint disabled:opacity-40 sm:h-8";

export function SequenceRecorder(props: {
  draft: Draft;
  kind: SequenceShotKind;
  seconds: number;
  followingName: string | null;
  note: string | null;
  link: string | null;
  busy: boolean;
  onKind: (k: SequenceShotKind) => void;
  onSeconds: (s: number) => void;
  onTitle: (t: string) => void;
  onAdd: () => void;
  onUndo: () => void;
  onPreview: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { draft } = props;
  const total = draftDuration(draft);
  const can = canAddShot(draft, props.seconds * 1000);
  return (
    <section
      data-speech-avoid
      aria-label="Record a shot"
      className="pointer-events-auto absolute left-3 top-14 z-30 w-[min(22rem,calc(100%-1.5rem))] rounded-gh-lg border border-line gh-frost p-3 font-brand text-gh-xs text-ink shadow-gh-2 sm:left-5 sm:top-16"
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-brand text-gh-sm font-bold text-ink">Record a shot</h2>
          <p className="text-muted">Move the camera, then add a shot. Each shot ends where the camera is now.</p>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close recorder" className="h-11 w-11 shrink-0 rounded-gh-pill text-muted hover:bg-tint hover:text-ink sm:h-8 sm:w-8">
          ×
        </button>
      </header>
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Shot">
        {SHOT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={props.kind === k}
            onClick={() => props.onKind(k)}
            className={`${BUTTON} ${props.kind === k ? "border-ink bg-tint font-medium" : ""}`}
            title={
              k === "path"
                ? "Travel from the last shot to here, with a gentle arc"
                : k === "push"
                  ? "A straight, eased move to here — zoom in first for a push in"
                  : k === "orbit"
                    ? "Circle slowly round where the camera is now"
                    : "Hold still here"
            }
          >
            {SHOT_LABEL[k]}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-muted">
          <span className="sr-only">Duration</span>
          <select
            value={props.seconds}
            onChange={(e) => props.onSeconds(Number(e.target.value))}
            className="h-10 rounded-full border border-line-strong bg-surface-raised px-2 text-xs text-ink sm:h-8"
          >
            {SECONDS.map((s) => (
              <option key={s} value={s}>
                {s}s
              </option>
            ))}
          </select>
        </label>
      </div>
      {props.followingName ? (
        <p className="mb-2 text-ink">Following {props.followingName}: this shot keeps them in frame.</p>
      ) : null}
      <div className="mb-2 flex gap-1.5">
        <button type="button" onClick={props.onAdd} disabled={!can} className={`${BUTTON} flex-1 font-semibold`}>
          Add shot
        </button>
        <button type="button" onClick={props.onUndo} disabled={!draft.shots.length} className={BUTTON}>
          Undo
        </button>
      </div>
      {draft.shots.length ? (
        <ol className="mb-2 max-h-28 space-y-0.5 overflow-y-auto text-muted">
          {draft.shots.map((s, i) => (
            <li key={i} className="tabular-nums">
              {i + 1}. {SHOT_LABEL[s.kind]} · {s.durationMs / 1000}s{s.follow ? ` · follows ${s.follow}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mb-2 tabular-nums text-muted">
        {formatRunTime(total)} of {formatRunTime(SEQUENCE_MAX_TOTAL_MS)} · {draft.shots.length} of {SEQUENCE_MAX_SHOTS} shots
      </p>
      <label className="mb-2 block">
        <span className="sr-only">Title</span>
        <input
          type="text"
          value={draft.title}
          maxLength={SEQUENCE_TITLE_MAX}
          placeholder="Title (optional)"
          onChange={(e) => props.onTitle(e.target.value)}
          className="h-10 w-full rounded-lg border border-line-strong bg-surface-raised px-2 text-xs text-ink placeholder:text-muted sm:h-8"
        />
      </label>
      <div className="flex gap-1.5">
        <button type="button" onClick={props.onPreview} disabled={!draft.shots.length} className={`${BUTTON} flex-1`}>
          Preview
        </button>
        <button type="button" onClick={props.onCopy} disabled={!draft.shots.length || props.busy} className={`${BUTTON} flex-1`}>
          Copy link
        </button>
      </div>
      {props.link ? (
        <input
          readOnly
          value={props.link}
          aria-label="Sequence link"
          onFocus={(e) => e.currentTarget.select()}
          className="mt-2 h-8 w-full rounded-gh-md border border-line bg-surface px-2 font-brand-mono text-[10px] text-muted"
        />
      ) : null}
      {props.note ? (
        <p role="status" className="mt-2 text-muted">
          {props.note}
        </p>
      ) : null}
    </section>
  );
}

export function CinemaBars(props: {
  title: string | null;
  elapsed: number;
  total: number;
  done: boolean;
  preview: boolean;
  holding: boolean;
  onPostcard: () => void;
  onAgain: () => void;
  onExit: () => void;
}) {
  // Letterbox bars are black in every mode, so what sits on them reads as night.
  const bar = "absolute inset-x-0 z-30 bg-black";
  const pct = props.total > 0 ? Math.min(100, (props.elapsed / props.total) * 100) : 100;
  return (
    <>
      <div aria-hidden className={`${bar} pointer-events-none top-0`} style={{ height: "clamp(20px, 8vh, 88px)" }} />
      <div
        role="region"
        aria-label="Sequence"
        data-mode="night"
        className={`${bar} bottom-0 flex flex-col justify-center gap-1 px-4 font-brand`}
        style={{ minHeight: "clamp(64px, 11vh, 110px)" }}
      >
        <div className="h-0.5 w-full overflow-hidden rounded bg-tint">
          <div className="h-full bg-signal" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink">
          <span className="min-w-0 flex-1 truncate">
            {props.title ? <span className="text-ink">{props.title}</span> : <span className="text-muted">A sequence</span>}
            <span className="ml-2 tabular-nums text-muted">
              {formatRunTime(props.elapsed)} / {formatRunTime(props.total)}
            </span>
            {props.holding ? <span className="ml-2 text-muted">· holding (that body is not on the public map)</span> : null}
          </span>
          <button type="button" onClick={props.onPostcard} className={BUTTON} title="Save this frame as a postcard, captioned with the sequence title">
            Postcard
          </button>
          {props.done ? (
            <button type="button" onClick={props.onAgain} className={BUTTON}>
              Play again
            </button>
          ) : null}
          <button type="button" onClick={props.onExit} className={`${BUTTON} border-ink`} title="Esc">
            {props.preview ? "Back to recorder" : "Exit"}
          </button>
        </div>
      </div>
    </>
  );
}
