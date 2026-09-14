"use client";

import type { SoundControls } from "@/lib/sound/useSoundscape";
import { MenuHeading } from "./MapMenu";

/**
 * ⋯ Sound: the site-wide mute (#56, shared with read aloud in the room drawer),
 * then the soundscape's on/off, volume and bed only. The soundscape never
 * carries anything the map does not already draw, so every control here is a
 * preference, not a way to learn something.
 */
export function SoundMenuSection({ sound }: { sound: SoundControls }) {
  const pct = Math.round(sound.volume * 100);
  return (
    <div className="border-t border-white/10 pt-1">
      <MenuHeading>Sound</MenuHeading>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={sound.muted}
        title="Silences everything on this site in this browser: the ambient soundscape and read aloud"
        onClick={() => sound.setMuted(!sound.muted)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-white/80 hover:bg-white/5 hover:text-lantern-300 sm:py-2"
      >
        <span>Mute all sound</span>
        <span className={`text-xs ${sound.muted ? "text-lantern-300" : "text-white/55"}`}>{sound.muted ? "on" : "off"}</span>
      </button>
      {sound.supported ? <AmbientRows sound={sound} pct={pct} /> : null}
    </div>
  );
}

function AmbientRows({ sound, pct }: { sound: SoundControls; pct: number }) {
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={sound.enabled}
        title="An ambient soundscape made from what is happening on the map: calls starting and finishing, lines, arrivals. Made in your browser, nothing downloaded."
        onClick={() => {
          const on = !sound.enabled;
          sound.setEnabled(on);
          if (on) sound.begin();
        }}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-white/80 hover:bg-white/5 hover:text-lantern-300 sm:py-2"
      >
        <span>Ambient sound</span>
        <span className={`text-xs ${sound.enabled ? "text-lantern-300" : "text-white/55"}`}>
          {sound.enabled ? (sound.muted ? "on · muted" : sound.needsGesture ? "on · tap to start" : "on") : "off"}
        </span>
      </button>
      <div role="group" aria-label="Volume" className="flex items-center gap-3 px-3 py-2 text-white/70">
        <span aria-hidden className="shrink-0 text-xs">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          onChange={(e) => sound.setVolume(Number(e.target.value) / 100)}
          aria-label="Sound volume"
          aria-valuetext={`${pct}%`}
          disabled={!sound.enabled}
          className="min-w-0 flex-1 accent-lantern-400 disabled:opacity-40"
        />
      </div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={sound.bedOnly}
        disabled={!sound.enabled}
        title="Keep the calm bed and drop the event sounds"
        onClick={() => sound.setBedOnly(!sound.bedOnly)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-white/80 hover:bg-white/5 hover:text-lantern-300 disabled:opacity-40 sm:py-2"
      >
        <span>Reduce sound (bed only)</span>
        <span className={`text-xs ${sound.bedOnly ? "text-lantern-300" : "text-white/55"}`}>{sound.bedOnly ? "on" : "off"}</span>
      </button>
    </>
  );
}

/**
 * Kiosk and TV default sound ON, but a browser will not start audio without a
 * gesture. A quiet pill says so until somebody taps; the tap anywhere starts it.
 * Muted site-wide, there is nothing to start, so the pill stays away.
 */
export function TapForSound({ sound }: { sound: SoundControls }) {
  if (sound.muted || !sound.needsGesture) return null;
  return (
    <button
      type="button"
      onClick={sound.begin}
      className="pointer-events-auto fixed bottom-10 left-3 z-30 rounded-full border border-white/15 bg-dusk-950/70 px-3 py-1.5 text-[11px] uppercase tracking-widest text-white/55 hover:text-white/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lantern-400"
    >
      <span aria-hidden className="mr-1">♪</span>Tap for sound
    </button>
  );
}
