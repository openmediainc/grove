/**
 * The soundscape, minus React: listener -> limiter -> voices -> engine.
 *
 * The map feeds it the samples it already has (bodies, spans, hazards, new
 * public lines) and it decides what, if anything, is heard. Nothing is
 * listened to while sound is off, and the first sample after it comes on is a
 * fresh baseline, so switching on never plays a backlog.
 */
import { SoundEngine } from "./engine";
import { DEFAULT_LIMITER, VoiceLimiter, type LimiterOptions } from "./limiter";
import { activityLevel, SoundListener, type SoundActor } from "./listener";
import { DEFAULT_SOUND, type SoundPreset } from "./presets";
import { DEFAULT_VOLUME } from "./settings";
import { voiceFor, type Voice } from "./voices";

/** How often the map should sample for sound. */
export const SOUND_STEP_MS = 500;

export class Soundscape {
  readonly listener = new SoundListener();
  readonly limiter: VoiceLimiter;
  readonly engine: SoundEngine;
  private preset: SoundPreset = DEFAULT_SOUND;
  private bedOnly = false;
  private listening = false;
  private lastStep = 0;

  constructor(create: () => AudioContext, limiter: LimiterOptions = DEFAULT_LIMITER) {
    this.limiter = new VoiceLimiter(limiter);
    this.engine = new SoundEngine(create, DEFAULT_SOUND, DEFAULT_VOLUME);
  }

  /** Whether the map should bother sampling right now. */
  get active(): boolean {
    return this.listening && this.engine.running;
  }

  async start(): Promise<boolean> {
    if (!this.listening) {
      this.listener.reset();
      this.limiter.reset();
    }
    this.listening = true;
    return this.engine.start();
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.listener.reset();
    await this.engine.stop();
  }

  setPreset(preset: SoundPreset): void {
    this.preset = preset;
    this.engine.setPreset(preset);
  }

  setVolume(v: number): void {
    this.engine.setVolume(v);
  }

  setBedOnly(on: boolean): void {
    this.bedOnly = on;
  }

  /** A new public line (poll diff). */
  heard(actorId: string, now: number): void {
    if (this.listening) this.listener.heard(actorId, now);
  }

  /**
   * One sample of the map. Rate-limited to SOUND_STEP_MS internally, so the
   * draw loop may call it every frame. Returns the voices it played (tests).
   */
  sample(actors: readonly SoundActor[], now: number): Voice[] {
    if (!this.active || now - this.lastStep < SOUND_STEP_MS) return [];
    this.lastStep = now;
    this.engine.tick(now);
    this.engine.setActivity(activityLevel(actors));
    const events = this.listener.observe(actors, now);
    if (this.bedOnly || !events.length) return [];
    const voices = this.limiter.admit(events, now).map((e) => voiceFor(e, this.preset));
    for (const v of voices) this.engine.play(v);
    return voices;
  }
}
