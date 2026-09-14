/**
 * The soundscape, loaded on demand (#68).
 *
 * Sound is off by default, so the synth (engine, listener, limiter, voices)
 * is not part of the map's first load. This facade has the same surface the
 * map and `useSoundscape` use; until the real `Soundscape` arrives every call
 * is a cheap no-op (the map samples nothing while sound is off anyway), and
 * the preset, volume and bed-only choices are remembered and handed over the
 * moment it loads.
 *
 * `useSoundscape` calls `load()` as soon as sound is on and allowed, BEFORE the
 * first gesture, so by the time a tap starts the AudioContext the chunk is
 * normally already here and the start still happens inside that gesture.
 */
import type { SoundPreset } from "./presets";
import type { SoundActor } from "./listener";
import type { Soundscape } from "./soundscape";
import type { Voice } from "./voices";

export type SoundscapeLoader = () => Promise<Soundscape>;

export class LazySoundscape {
  private real: Soundscape | null = null;
  private pending: Promise<Soundscape> | null = null;
  private preset: SoundPreset | null = null;
  private volume: number | null = null;
  private bedOnly: boolean | null = null;

  constructor(private readonly loader: SoundscapeLoader) {}

  /** Whether the real soundscape has arrived. */
  get loaded(): boolean {
    return this.real !== null;
  }

  /** Fetch (once) and configure the real soundscape. */
  load(): Promise<Soundscape> {
    if (this.real) return Promise.resolve(this.real);
    if (!this.pending) {
      this.pending = this.loader().then(
        (s) => {
          if (this.preset) s.setPreset(this.preset);
          if (this.volume !== null) s.setVolume(this.volume);
          if (this.bedOnly !== null) s.setBedOnly(this.bedOnly);
          this.real = s;
          return s;
        },
        (e: unknown) => {
          this.pending = null;
          throw e;
        },
      );
    }
    return this.pending;
  }

  get active(): boolean {
    return this.real?.active ?? false;
  }

  /** The running AudioContext, once there is one. */
  get context(): AudioContext | null {
    return this.real?.engine.context ?? null;
  }

  get running(): boolean {
    return this.real?.engine.running ?? false;
  }

  async start(): Promise<boolean> {
    const s = this.real ?? (await this.load());
    return s.start();
  }

  async stop(): Promise<void> {
    if (this.real) await this.real.stop();
  }

  close(): void {
    if (this.real) void this.real.engine.close();
  }

  setPreset(preset: SoundPreset): void {
    this.preset = preset;
    this.real?.setPreset(preset);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.real?.setVolume(v);
  }

  setBedOnly(on: boolean): void {
    this.bedOnly = on;
    this.real?.setBedOnly(on);
  }

  heard(actorId: string, now: number): void {
    this.real?.heard(actorId, now);
  }

  sample(actors: readonly SoundActor[], now: number): Voice[] {
    return this.real ? this.real.sample(actors, now) : [];
  }
}
