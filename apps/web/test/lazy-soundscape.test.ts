import { describe, expect, it, vi } from "vitest";
import { LazySoundscape } from "../lib/sound/lazy-soundscape";
import type { Soundscape } from "../lib/sound/soundscape";
import type { SoundPreset } from "../lib/sound/presets";

function fakeScape() {
  const engine = { context: null as unknown, running: false, close: vi.fn(async () => {}) };
  return {
    engine,
    active: false,
    start: vi.fn(async () => {
      engine.running = true;
      engine.context = {};
      return true;
    }),
    stop: vi.fn(async () => {}),
    setPreset: vi.fn(),
    setVolume: vi.fn(),
    setBedOnly: vi.fn(),
    heard: vi.fn(),
    sample: vi.fn(() => []),
  };
}

describe("LazySoundscape (#68)", () => {
  it("is a silent no-op until loaded, and never loads by itself", () => {
    const loader = vi.fn(async () => fakeScape() as unknown as Soundscape);
    const s = new LazySoundscape(loader);
    s.heard("a", 1);
    expect(s.sample([], 1)).toEqual([]);
    expect(s.active).toBe(false);
    expect(s.context).toBeNull();
    s.close();
    expect(loader).not.toHaveBeenCalled();
  });

  it("hands remembered settings to the real soundscape when it arrives, loading once", async () => {
    const real = fakeScape();
    const loader = vi.fn(async () => real as unknown as Soundscape);
    const s = new LazySoundscape(loader);
    const preset = { scale: "x" } as unknown as SoundPreset;
    s.setPreset(preset);
    s.setVolume(0.3);
    s.setBedOnly(true);
    await Promise.all([s.load(), s.load()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(real.setPreset).toHaveBeenCalledWith(preset);
    expect(real.setVolume).toHaveBeenCalledWith(0.3);
    expect(real.setBedOnly).toHaveBeenCalledWith(true);
    s.setVolume(0.9);
    expect(real.setVolume).toHaveBeenLastCalledWith(0.9);
  });

  it("start loads if needed and then delegates; calls forward after load", async () => {
    const real = fakeScape();
    const s = new LazySoundscape(async () => real as unknown as Soundscape);
    await expect(s.start()).resolves.toBe(true);
    expect(s.running).toBe(true);
    expect(s.context).not.toBeNull();
    s.heard("a", 5);
    expect(real.heard).toHaveBeenCalledWith("a", 5);
    await s.stop();
    expect(real.stop).toHaveBeenCalled();
  });

  it("a failed load can be retried", async () => {
    let n = 0;
    const s = new LazySoundscape(async () => {
      n += 1;
      if (n === 1) throw new Error("offline");
      return fakeScape() as unknown as Soundscape;
    });
    await expect(s.load()).rejects.toThrow("offline");
    await expect(s.load()).resolves.toBeTruthy();
    expect(s.loaded).toBe(true);
  });
});
