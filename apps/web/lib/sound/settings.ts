/**
 * The viewer's sound settings, kept in this browser.
 *
 * Off by default everywhere, except kiosk and TV, where a wall display is the
 * point and sound defaults ON — still waiting for a tap before audio starts
 * (autoplay policy). An explicit choice this viewer made always wins.
 * "Bed only" keeps the pad and drops every event voice.
 */

export const SOUND_KEY = "grove-sound";
export const SOUND_VOLUME_KEY = "grove-sound-volume";
export const SOUND_BED_ONLY_KEY = "grove-sound-bed-only";

export const DEFAULT_VOLUME = 0.5;
/** The loudest the master ever gets; the slider scales under this. */
export const MASTER_CEILING = 0.22;

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  bedOnly: boolean;
}

type Get = (key: string) => string | null;

export function clampVolume(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

export function readSoundSettings(get: Get, ctx: { kiosk: boolean }): SoundSettings {
  const safe = (k: string): string | null => {
    try {
      return get(k);
    } catch {
      return null;
    }
  };
  const stored = safe(SOUND_KEY);
  const vol = safe(SOUND_VOLUME_KEY);
  return {
    enabled: stored === "1" ? true : stored === "0" ? false : ctx.kiosk,
    volume: vol === null ? DEFAULT_VOLUME : clampVolume(vol),
    bedOnly: safe(SOUND_BED_ONLY_KEY) === "1",
  };
}

/** Slider position -> master gain. Squared, so the low end of the slider is usable. */
export function masterGain(volume: number): number {
  const v = clampVolume(volume);
  return v * v * MASTER_CEILING;
}
