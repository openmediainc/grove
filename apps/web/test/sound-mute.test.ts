import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, Reader, SITE_MUTE_KEY, siteMuted } from "../lib/read-aloud";
import { DEFAULT_SOUND } from "../lib/sound/presets";
import {
  isSoundMuted,
  resetMemoryMute,
  setSoundMuted,
  SOUND_MUTED_EVENT,
  SOUND_MUTED_KEY,
  subscribeSoundMuted,
  type MuteEnv,
  type MuteStorage,
} from "../lib/sound/prefs";
import { Soundscape } from "../lib/sound/soundscape";

function memStorage(): MuteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** A tab: its own event target, sharing storage with other tabs. */
function tab(storage: MuteStorage | null): MuteEnv & { target: EventTarget } {
  return { storage, target: new EventTarget() };
}

/** What the browser does in OTHER tabs after a localStorage write. */
function storageEvent(key: string | null, newValue: string | null): Event {
  return Object.assign(new Event("storage"), { key, newValue });
}

beforeEach(() => resetMemoryMute());

describe("one mute for all sound", () => {
  it("is one key: the flag read aloud checks is the one the soundscape's control writes", () => {
    expect(SITE_MUTE_KEY).toBe(SOUND_MUTED_KEY);
    expect(SOUND_MUTED_KEY).toBe("grove-sound-muted");
    const storage = memStorage();
    const env = tab(storage);
    expect(isSoundMuted(env)).toBe(false);
    setSoundMuted(true, env);
    expect(storage.data.get(SOUND_MUTED_KEY)).toBe("1");
    expect(siteMuted(storage)).toBe(true);
    setSoundMuted(false, env);
    expect(siteMuted(storage)).toBe(false);
    expect(isSoundMuted(env)).toBe(false);
  });

  it("tells every listener in the same tab at once, and stops after unsubscribe", () => {
    const env = tab(memStorage());
    const a: boolean[] = [];
    const b: boolean[] = [];
    const offA = subscribeSoundMuted((m) => a.push(m), env);
    subscribeSoundMuted((m) => b.push(m), env);
    setSoundMuted(true, env);
    expect(a).toEqual([true]);
    expect(b).toEqual([true]);
    offA();
    setSoundMuted(false, env);
    expect(a).toEqual([true]);
    expect(b).toEqual([true, false]);
  });

  it("follows other tabs through the storage event, ignoring other keys", () => {
    const env = tab(memStorage());
    const seen: boolean[] = [];
    subscribeSoundMuted((m) => seen.push(m), env);
    env.target.dispatchEvent(storageEvent("grove-sound", "1"));
    env.target.dispatchEvent(storageEvent(SOUND_MUTED_KEY, "1"));
    env.target.dispatchEvent(storageEvent(SOUND_MUTED_KEY, "0"));
    env.target.dispatchEvent(storageEvent(null, null)); // storage cleared
    expect(seen).toEqual([true, false, false]);
    expect(SOUND_MUTED_EVENT).toBe("grove:sound-muted");
  });

  it("with storage blocked, the choice lasts the visit", () => {
    const throwing: MuteStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const env = tab(throwing);
    const seen: boolean[] = [];
    subscribeSoundMuted((m) => seen.push(m), env);
    expect(isSoundMuted(env)).toBe(false);
    setSoundMuted(true, env);
    expect(isSoundMuted(env)).toBe(true);
    expect(seen).toEqual([true]);
    expect(siteMuted(throwing)).toBe(false); // read aloud's own reader never throws
  });

  it("muting cancels read aloud immediately", () => {
    const env = tab(memStorage());
    let cancels = 0;
    const spoken: string[] = [];
    const reader = new Reader({
      synth: { speak: (u) => void spoken.push(u.text), cancel: () => void cancels++, getVoices: () => [] },
      makeUtterance: (text) => ({ text, voice: null, pitch: 1, rate: 1, lang: "", onend: null, onerror: null }),
      pageLang: "en",
      getSettings: () => ({ ...DEFAULT_SETTINGS, on: true }),
      onSpeaking: () => {},
    });
    // The same wiring the drawer uses.
    subscribeSoundMuted((m) => void (m && reader.stop()), env);
    reader.enqueue([
      { kind: "line", key: "say:1", speakerId: "a", speakerKind: "agent", text: "one" },
      { kind: "line", key: "say:2", speakerId: "a", speakerKind: "agent", text: "two" },
    ]);
    expect(reader.busy).toBe(true);
    setSoundMuted(true, env);
    expect(cancels).toBe(1);
    expect(reader.busy).toBe(false);
    expect(reader.pending).toEqual([]);
    expect(spoken).toEqual(["one"]);
  });

  it("muting ramps the soundscape's master gain to zero and stops listening", async () => {
    const targets: number[] = [];
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
      setTargetAtTime(v: number) {
        targets.push(v);
      },
      cancelScheduledValues() {},
    });
    const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
    let state = "suspended";
    const ctx = {
      get state() {
        return state;
      },
      currentTime: 0,
      sampleRate: 8000,
      destination: node(),
      onstatechange: null,
      createGain: () => ({ ...node(), gain: param() }),
      createOscillator: () => ({ ...node(), type: "sine", frequency: param(), detune: param(), start() {}, stop() {} }),
      createBiquadFilter: () => ({ ...node(), type: "lowpass", frequency: param(), Q: param() }),
      createConvolver: () => ({ ...node(), buffer: null }),
      createBufferSource: () => ({ ...node(), buffer: null, start() {}, stop() {} }),
      createBuffer: (ch: number, len: number) => {
        const d = Array.from({ length: ch }, () => new Float32Array(len));
        return { getChannelData: (i: number) => d[i]! };
      },
      resume: async () => void (state = "running"),
      suspend: async () => void (state = "suspended"),
      close: async () => void (state = "closed"),
    };
    const scape = new Soundscape(() => ctx as unknown as AudioContext);
    scape.setPreset(DEFAULT_SOUND);
    await scape.start();
    expect(scape.active).toBe(true);

    const env = tab(memStorage());
    let stopping: Promise<void> | null = null;
    // The same wiring useSoundscape arrives at: muted => stop (a fade to 0).
    subscribeSoundMuted((m) => void (m && (stopping = scape.stop())), env);
    targets.length = 0;
    setSoundMuted(true, env);
    expect(stopping).not.toBeNull();
    expect(scape.active).toBe(false);
    expect(targets).toContain(0);
    await stopping;
    expect(state).toBe("suspended");
  });
});
