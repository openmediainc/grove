"use client";

/**
 * Camera bookmarks.
 *
 * The campus is 24 x 18 of civic core plus however much claimed land has grown
 * around it, and the only ways to get anywhere were dragging and the follow-cam.
 * Watching a world you have to drag across is watching a map, not a place. So:
 * one keystroke to each thing a watcher actually wants to look at.
 *
 * The keys are the obvious ones and they extend the set the map already binds —
 * `0` is "back to the core", so `1`..`6` are the six rooms in the order the
 * campus lists them, `B` is wherever the crowd is, `M` is your own ground. The
 * map owns the camera; this only says where to point it, and every destination
 * is resolved from data the map already holds.
 *
 * Two shapes, because eight pills do not fit on a phone and a keyboard shortcut
 * is worth nothing there anyway: a row of labelled pills with their keys from
 * `sm` up, and one select below it. The select is not a fallback — on a touch
 * screen it is the better control.
 */

export type Bookmark = {
  /** The key that triggers it, as a single printable character. */
  key: string;
  /** What it is called on the pill. */
  label: string;
  /** The longer sentence, for the title attribute and the select option. */
  title: string;
};

export function CameraBookmarks({
  items,
  onGo,
}: {
  items: readonly Bookmark[];
  onGo: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="pointer-events-auto hidden flex-wrap items-center justify-end gap-1.5 sm:flex">
        <span className="pr-1 text-[10px] uppercase tracking-widest text-white/30">go to</span>
        {items.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => onGo(b.key)}
            title={`${b.title} (${b.key.toUpperCase()})`}
            className="flex items-center gap-1.5 rounded-full border border-white/12 bg-dusk-950/80 py-1 pl-3 pr-1.5 text-[11px] text-white/70 transition-colors hover:border-lantern-400/40 hover:text-lantern-300"
          >
            {b.label}
            <span
              aria-hidden
              className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] uppercase leading-none text-white/45"
            >
              {b.key}
            </span>
          </button>
        ))}
      </div>
      {/* Right-aligned and no wider than a pill. Full width made a banner of it
          and pushed the controls below into a corner that was already tuned to
          fit a 390px screen; the option text can be long inside the menu. */}
      <label className="pointer-events-auto ml-auto w-44 sm:hidden">
        <span className="sr-only">Move the camera to</span>
        <select
          value=""
          onChange={(e) => {
            const k = e.target.value;
            if (k) onGo(k);
          }}
          className="w-full rounded-full border border-white/15 bg-dusk-950/85 px-4 py-2.5 text-sm text-white/75"
        >
          <option value="">Go to…</option>
          {items.map((b) => (
            <option key={b.key} value={b.key}>
              {b.title}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
