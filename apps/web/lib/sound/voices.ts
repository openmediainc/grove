/**
 * Event -> voice: which notes, how loud, how long. Pure, so the musical
 * decisions are testable without an AudioContext.
 *
 * The mapping is theme-invariant; the preset only supplies scale and timbre.
 *   start   a soft pluck, pitched by the tool's verb family
 *   finish  the same verb a step higher (resolved); a failed call falls back down, muted
 *   speech  a breathy chime, high
 *   arrival a rising two-note motif
 *   hazard  one low, muted tone — never an alarm
 */
import type { Scheduled } from "./limiter";
import type { ToolVerb } from "./listener";
import { degreeToMidi, midiToHz, type SoundPreset } from "./presets";

export type VoiceShape = "pluck" | "chime" | "motif" | "low";

export interface Voice {
  shape: VoiceShape;
  /** Frequencies in Hz, played in order (a motif) — one for everything else. */
  notes: number[];
  /** Peak gain before the master, 0..1. */
  gain: number;
  /** Seconds the voice rings. */
  duration: number;
  delayMs: number;
}

export const VERB_DEGREE: Record<ToolVerb, number> = { read: 0, run: 1, write: 2, think: 3, other: 4 };

/** A burst voice is a little fuller, never proportionally louder. */
export function burstGain(base: number, count: number): number {
  return Math.min(base * 1.6, base * (1 + Math.log2(Math.max(1, count)) * 0.2));
}

export function voiceFor(e: Scheduled, preset: SoundPreset): Voice {
  const hz = (degree: number, octave: number) => midiToHz(degreeToMidi(preset, degree, octave));
  switch (e.kind) {
    case "start":
      return { shape: "pluck", notes: [hz(VERB_DEGREE[e.verb], 1)], gain: burstGain(0.32, e.count), duration: preset.pluckDecay, delayMs: e.delayMs };
    case "finish":
      return e.ok
        ? { shape: "pluck", notes: [hz(VERB_DEGREE[e.verb] + 2, 1)], gain: burstGain(0.26, e.count), duration: preset.pluckDecay * 1.2, delayMs: e.delayMs }
        : { shape: "pluck", notes: [hz(VERB_DEGREE[e.verb] - 1, 0)], gain: burstGain(0.2, e.count), duration: preset.pluckDecay * 0.8, delayMs: e.delayMs };
    case "speech":
      return { shape: "chime", notes: [hz(4, 2)], gain: burstGain(0.18, e.count), duration: 1.6, delayMs: e.delayMs };
    case "arrival":
      return { shape: "motif", notes: [hz(0, 1), hz(2, 1)], gain: burstGain(0.28, e.count), duration: 0.9, delayMs: e.delayMs };
    case "hazard":
      return { shape: "low", notes: [hz(0, -1)], gain: 0.3, duration: 2.2, delayMs: e.delayMs };
  }
}
