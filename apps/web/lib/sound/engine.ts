/**
 * The WebAudio side of the soundscape. Pure synthesis: oscillators, filters,
 * gains and one ConvolverNode whose impulse is generated noise. No audio
 * files, no loops, no network.
 *
 *   voices ─┬──────────────► master ─► destination
 *           └─► reverb send ─► convolver ─► wet ─┘
 *   bed (detuned pad) ─► low-pass (activity + slow LFO) ─► bed gain ─┘ (and the send)
 *
 * The AudioContext comes from a factory so tests can hand in a mock, and so
 * nothing is created until a person has made a gesture.
 */
import { bedCutoff, degreeToMidi, midiToHz, type SoundPreset } from "./presets";
import { masterGain } from "./settings";
import type { Voice } from "./voices";

/** Seconds between the bed's slow chord changes. */
export const BED_CHANGE_S = 18;
/** The bed walks these root offsets (in scale degrees), one per change. */
export const BED_WALK: readonly number[] = [0, 3, 1, 4, 2];
const BED_LEVEL = 0.16;

/** Deterministic noise, so the room sounds the same every visit. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One channel of a reverb impulse: noise under a power-curve decay. */
export function impulseSamples(length: number, decay: number, seed: number): Float32Array {
  const out = new Float32Array(Math.max(1, Math.floor(length)));
  const r = rng(seed);
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * Math.pow(1 - i / out.length, decay);
  return out;
}

/** The bed's frequencies for a walk step: each chord degree, offset by the walk. */
export function bedFrequencies(preset: SoundPreset, step: number): number[] {
  const offset = BED_WALK[((step % BED_WALK.length) + BED_WALK.length) % BED_WALK.length]!;
  return preset.bed.chord.map((d) => midiToHz(degreeToMidi(preset, d + offset, -1)));
}

interface BedVoice {
  osc: OscillatorNode;
  noteIndex: number;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private send: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wet: GainNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedGain: GainNode | null = null;
  private bed: BedVoice[] = [];
  private lfo: OscillatorNode | null = null;
  private preset: SoundPreset;
  private volume: number;
  private walkStep = 0;
  private lastChange = 0;
  private activity = 0;
  /** Live voice sources, so a burst can never pile up nodes without bound. */
  private live = 0;
  /** Bumped by start(), so a stop() still fading out cannot suspend a fresh start. */
  private gen = 0;
  static readonly MAX_LIVE = 12;

  constructor(
    private readonly create: () => AudioContext,
    preset: SoundPreset,
    volume: number,
  ) {
    this.preset = preset;
    this.volume = volume;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** Build the graph (once) and ask the context to run. Call from a user gesture. */
  async start(): Promise<boolean> {
    this.gen++;
    if (!this.ctx) {
      this.ctx = this.create();
      this.build();
    }
    const ctx = this.ctx;
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      /* the browser said no; the tap prompt stays up */
    }
    if (this.master) {
      const t = ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(masterGain(this.volume), t, 0.8);
    }
    return this.running;
  }

  /** Fade out and let the context sleep. The graph is kept for the next start. */
  async stop(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.15);
    const gen = this.gen;
    await new Promise((r) => setTimeout(r, 450));
    if (gen !== this.gen) return;
    try {
      await ctx.suspend();
    } catch {
      /* already closed */
    }
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.bed = [];
    this.lfo = null;
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.ctx && this.master && this.running) this.master.gain.setTargetAtTime(masterGain(volume), this.ctx.currentTime, 0.1);
  }

  setPreset(preset: SoundPreset): void {
    if (preset === this.preset) return;
    this.preset = preset;
    if (!this.ctx) return;
    this.convolver!.buffer = this.impulse();
    this.wet!.gain.setTargetAtTime(preset.reverb.wet, this.ctx.currentTime, 0.5);
    for (const v of this.bed) v.osc.type = preset.bed.wave;
    this.retuneBed(1.5);
    this.setActivity(this.activity);
  }

  /** 0..1: how busy the map is. Opens the bed's filter slowly. */
  setActivity(level: number): void {
    this.activity = level;
    if (this.ctx && this.bedFilter) this.bedFilter.frequency.setTargetAtTime(bedCutoff(this.preset, level), this.ctx.currentTime, 3);
  }

  /** Called on the map's sampling cadence: walks the bed's chord now and then. */
  tick(nowMs: number): void {
    if (!this.ctx || !this.running) return;
    if (!this.lastChange) this.lastChange = nowMs;
    if (nowMs - this.lastChange >= BED_CHANGE_S * 1000) {
      this.lastChange = nowMs;
      this.walkStep++;
      this.retuneBed(3);
    }
  }

  play(voice: Voice): void {
    const ctx = this.ctx;
    if (!ctx || !this.running || !this.master || !this.send) return;
    if (this.live >= SoundEngine.MAX_LIVE) return;
    const t0 = ctx.currentTime + Math.max(0, voice.delayMs) / 1000;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);
    const sendAmt = ctx.createGain();
    sendAmt.gain.value = voice.shape === "chime" ? 0.9 : 0.5;
    out.connect(sendAmt);
    sendAmt.connect(this.send);
    const end = (() => {
      switch (voice.shape) {
        case "pluck":
          return this.pluck(out, voice.notes[0]!, voice.gain, voice.duration, t0);
        case "motif": {
          const a = this.pluck(out, voice.notes[0]!, voice.gain, voice.duration, t0);
          const b = this.pluck(out, voice.notes[1] ?? voice.notes[0]!, voice.gain * 0.9, voice.duration * 1.3, t0 + 0.22);
          return Math.max(a, b);
        }
        case "chime":
          return this.chime(out, voice.notes[0]!, voice.gain, voice.duration, t0);
        case "low":
          return this.low(out, voice.notes[0]!, voice.gain, voice.duration, t0);
      }
    })();
    this.live++;
    setTimeout(
      () => {
        this.live = Math.max(0, this.live - 1);
        try {
          out.disconnect();
          sendAmt.disconnect();
        } catch {
          /* ignore */
        }
      },
      Math.max(0, (end - ctx.currentTime) * 1000) + 200,
    );
  }

  /* ---- graph ------------------------------------------------------- */

  private build(): void {
    const ctx = this.ctx!;
    const p = this.preset;
    const t = ctx.currentTime;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.impulse();
    this.wet = ctx.createGain();
    this.wet.gain.value = p.reverb.wet;
    this.send = ctx.createGain();
    this.send.gain.value = 1;
    this.send.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.wet.connect(this.master);

    this.bedFilter = ctx.createBiquadFilter();
    this.bedFilter.type = "lowpass";
    this.bedFilter.Q.value = 0.4;
    this.bedFilter.frequency.value = bedCutoff(p, 0);
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    this.bedGain.gain.setTargetAtTime(BED_LEVEL, t, 2.5);
    this.bedFilter.connect(this.bedGain);
    this.bedGain.connect(this.master);
    this.bedGain.connect(this.send);

    // A very slow breath on the cutoff, so the pad is never a held note.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.045;
    const depth = ctx.createGain();
    depth.gain.value = 90;
    this.lfo.connect(depth);
    depth.connect(this.bedFilter.frequency);
    this.lfo.start(t);

    const freqs = bedFrequencies(p, 0);
    freqs.forEach((f, noteIndex) => {
      for (const sign of [-1, 1]) {
        const osc = ctx.createOscillator();
        osc.type = p.bed.wave;
        osc.frequency.value = f;
        osc.detune.value = (sign * p.bed.detune) / 2;
        const g = ctx.createGain();
        g.gain.value = 1 / (freqs.length * 2);
        osc.connect(g);
        g.connect(this.bedFilter!);
        osc.start(t);
        this.bed.push({ osc, noteIndex });
      }
    });
  }

  private retuneBed(timeConstant: number): void {
    if (!this.ctx) return;
    const freqs = bedFrequencies(this.preset, this.walkStep);
    const t = this.ctx.currentTime;
    for (const v of this.bed) {
      const f = freqs[v.noteIndex % freqs.length];
      if (f) v.osc.frequency.setTargetAtTime(f, t, timeConstant);
    }
  }

  private impulse(): AudioBuffer {
    const ctx = this.ctx!;
    const { seconds, decay } = this.preset.reverb;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) buf.getChannelData(ch).set(impulseSamples(len, decay, 7919 + ch * 104729));
    return buf;
  }

  /** An envelope gain: quick rise, exponential fall. Returns when it ends. */
  private envelope(gain: GainNode, peak: number, attack: number, duration: number, t0: number): number {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + duration);
    return t0 + attack + duration;
  }

  private osc(type: OscillatorType, freq: number, to: AudioNode, t0: number, end: number): OscillatorNode {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.connect(to);
    o.start(t0);
    o.stop(end + 0.05);
    return o;
  }

  private pluck(out: AudioNode, f: number, peak: number, duration: number, t0: number): number {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = Math.min(12000, f * 5);
    env.connect(tone);
    tone.connect(out);
    const timbre = this.preset.timbre;
    const attack = timbre === "keys" ? 0.012 : timbre === "glass" ? 0.004 : 0.006;
    const end = this.envelope(env, peak, attack, duration, t0);
    if (timbre === "fm") {
      const carrier = this.osc("sine", f, env, t0, end);
      const mod = ctx.createOscillator();
      mod.frequency.value = f * this.preset.fm.ratio;
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(f * this.preset.fm.index, t0);
      modGain.gain.exponentialRampToValueAtTime(Math.max(0.01, f * 0.05), end);
      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      mod.start(t0);
      mod.stop(end + 0.05);
    } else {
      const partial = ctx.createGain();
      partial.gain.value = timbre === "glass" ? 0.18 : timbre === "keys" ? 0.3 : 0.22;
      partial.connect(env);
      this.osc(timbre === "wood" ? "triangle" : "sine", f, env, t0, end);
      this.osc(timbre === "keys" ? "triangle" : "sine", f * (timbre === "glass" ? 4 : 2), partial, t0, end);
    }
    return end;
  }

  private chime(out: AudioNode, f: number, peak: number, duration: number, t0: number): number {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    env.connect(out);
    const end = this.envelope(env, peak, 0.06, duration, t0);
    this.osc("sine", f, env, t0, end);
    // The breath: a short band of noise around the note.
    const noise = ctx.createBufferSource();
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    buf.getChannelData(0).set(impulseSamples(len, 1.5, Math.floor(f)));
    noise.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = f;
    band.Q.value = 6;
    const breath = ctx.createGain();
    breath.gain.value = 0.5;
    noise.connect(band);
    band.connect(breath);
    breath.connect(env);
    noise.start(t0);
    noise.stop(t0 + 0.4);
    return end;
  }

  private low(out: AudioNode, f: number, peak: number, duration: number, t0: number): number {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    const muffle = ctx.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 320;
    env.connect(muffle);
    muffle.connect(out);
    const end = this.envelope(env, peak, 0.35, duration, t0);
    this.osc("triangle", f, env, t0, end);
    return end;
  }
}
