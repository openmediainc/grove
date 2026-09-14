/**
 * Soundscape presets: the scale and timbre a theme sounds in.
 *
 * A theme may carry an optional `sound` slot (docs/design/THEMES.md); anything
 * it leaves out falls back to DEFAULT_SOUND, so a theme with no slot still
 * plays. Like hazard marks, what an event MEANS in sound is theme-invariant
 * (a start is a pluck, a line is a chime, an arrival rises, a fault is low);
 * only the scale and the material change.
 *
 * Everything here is synthesis parameters. No samples, no files, no requests.
 */

export type SoundTimbre = "wood" | "glass" | "keys" | "fm";

export interface SoundPreset {
  /** Semitones above the root, one octave, ascending. */
  scale: readonly number[];
  /** MIDI note of the root (60 = middle C). */
  root: number;
  timbre: SoundTimbre;
  bed: {
    wave: OscillatorType;
    /** Scale degrees stacked into the pad. */
    chord: readonly number[];
    /** Detune spread between a note's twin oscillators, in cents. */
    detune: number;
    /** Low-pass cutoff (Hz) in a still world, and fully open in a busy one. */
    cutoff: number;
    openCutoff: number;
  };
  reverb: { seconds: number; decay: number; wet: number };
  /** Seconds a pluck rings. */
  pluckDecay: number;
  /** FM bell parameters, used by the "fm" timbre. */
  fm: { ratio: number; index: number };
}

export const DEFAULT_SOUND: SoundPreset = {
  scale: [0, 2, 4, 7, 9],
  root: 50,
  timbre: "wood",
  bed: { wave: "triangle", chord: [0, 2, 4], detune: 7, cutoff: 520, openCutoff: 1100 },
  reverb: { seconds: 3, decay: 2.4, wet: 0.35 },
  pluckDecay: 0.7,
  fm: { ratio: 2, index: 1.2 },
};

/** aoe: a major pentatonic on wood, dry-ish room. */
export const AOE_SOUND: Partial<SoundPreset> = {
  scale: [0, 2, 4, 7, 9],
  root: 50,
  timbre: "wood",
  bed: { wave: "triangle", chord: [0, 2, 4], detune: 6, cutoff: 480, openCutoff: 1000 },
  reverb: { seconds: 2.4, decay: 2.8, wet: 0.28 },
  pluckDecay: 0.55,
};

/** space: lydian glass in a long, open tail. */
export const SPACE_SOUND: Partial<SoundPreset> = {
  scale: [0, 2, 4, 6, 7, 11],
  root: 57,
  timbre: "glass",
  bed: { wave: "sine", chord: [0, 3, 5], detune: 9, cutoff: 900, openCutoff: 1800 },
  reverb: { seconds: 4.5, decay: 1.8, wet: 0.5 },
  pluckDecay: 1.4,
};

/** city: warm electric-piano keys, dorian, a small club. */
export const CITY_SOUND: Partial<SoundPreset> = {
  scale: [0, 2, 3, 5, 7, 9, 10],
  root: 53,
  timbre: "keys",
  bed: { wave: "sawtooth", chord: [0, 2, 4, 6], detune: 5, cutoff: 380, openCutoff: 800 },
  reverb: { seconds: 2, decay: 3, wet: 0.25 },
  pluckDecay: 0.9,
};

/** scifi: FM bells on a minor pentatonic. */
export const SCIFI_SOUND: Partial<SoundPreset> = {
  scale: [0, 3, 5, 7, 10],
  root: 48,
  timbre: "fm",
  bed: { wave: "square", chord: [0, 2, 3], detune: 11, cutoff: 360, openCutoff: 900 },
  reverb: { seconds: 3.2, decay: 2.2, wet: 0.4 },
  pluckDecay: 1.1,
  fm: { ratio: 3.5, index: 2.2 },
};

/** A theme's slot merged over the defaults, one level deep. */
export function resolveSoundPreset(slot: Partial<SoundPreset> | undefined | null): SoundPreset {
  if (!slot) return DEFAULT_SOUND;
  return {
    ...DEFAULT_SOUND,
    ...slot,
    scale: slot.scale && slot.scale.length ? slot.scale : DEFAULT_SOUND.scale,
    bed: { ...DEFAULT_SOUND.bed, ...slot.bed },
    reverb: { ...DEFAULT_SOUND.reverb, ...slot.reverb },
    fm: { ...DEFAULT_SOUND.fm, ...slot.fm },
  };
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note of a scale degree; degrees past the scale climb octaves, negatives fall. */
export function degreeToMidi(preset: SoundPreset, degree: number, octave = 0): number {
  const n = preset.scale.length;
  const d = Math.floor(degree);
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return preset.root + 12 * (octave + oct) + preset.scale[idx]!;
}

/** Bed cutoff for an activity level 0..1: a still world is muffled, a busy one opens up. */
export function bedCutoff(preset: SoundPreset, activity: number): number {
  const a = Math.min(1, Math.max(0, Number.isFinite(activity) ? activity : 0));
  return preset.bed.cutoff + (preset.bed.openCutoff - preset.bed.cutoff) * a;
}
