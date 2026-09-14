import { describe, expect, it } from "vitest";
import type { ToolCallView } from "@grove/protocol";
import { THEME_IDS } from "../lib/themes";
import { THEMES } from "../lib/themes/all";
import { SoundEngine, bedFrequencies, impulseSamples } from "../lib/sound/engine";
import { VoiceLimiter, collapse } from "../lib/sound/limiter";
import { SOUND_FRESH_MS, SOUND_REARRIVE_MS, SoundListener, activityLevel, toolVerb, type SoundActor, type SoundEvent } from "../lib/sound/listener";
import { DEFAULT_SOUND, bedCutoff, degreeToMidi, midiToHz, resolveSoundPreset } from "../lib/sound/presets";
import { MASTER_CEILING, masterGain, readSoundSettings, SOUND_BED_ONLY_KEY, SOUND_KEY, SOUND_VOLUME_KEY } from "../lib/sound/settings";
import { SOUND_STEP_MS, Soundscape } from "../lib/sound/soundscape";
import { voiceFor } from "../lib/sound/voices";

const T0 = Date.parse("2026-09-13T12:00:00Z");

function span(callId: string, startedAt: number, over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    callId,
    name: "Read",
    args: null,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    outcome: null,
    progress: null,
    progressDone: null,
    progressTotal: null,
    result: null,
    durationMs: null,
    stalled: false,
    ...over,
  };
}

const done = (s: ToolCallView, at: number, outcome: "ok" | "error" = "ok"): ToolCallView => ({
  ...s,
  finishedAt: new Date(at).toISOString(),
  outcome,
});

const body = (id: string, over: Partial<SoundActor> = {}): SoundActor => ({ id, hazard: null, ...over });

/* ---- a mock AudioContext: records what was built and scheduled ---- */

class MockParam {
  value = 0;
  calls: string[] = [];
  setValueAtTime(v: number) {
    this.calls.push("set");
    this.value = v;
  }
  linearRampToValueAtTime(v: number) {
    this.calls.push("lin");
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number) {
    this.calls.push("exp");
    this.value = v;
  }
  setTargetAtTime(v: number) {
    this.calls.push("target");
    this.value = v;
  }
  cancelScheduledValues() {}
}
class MockNode {
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {}
}
class MockOsc extends MockNode {
  type = "sine";
  frequency = new MockParam();
  detune = new MockParam();
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
class MockCtx {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination = new MockNode();
  made: Record<string, number> = {};
  oscs: MockOsc[] = [];
  onstatechange: (() => void) | null = null;
  private count(k: string) {
    this.made[k] = (this.made[k] ?? 0) + 1;
  }
  createGain() {
    this.count("gain");
    return Object.assign(new MockNode(), { gain: new MockParam() });
  }
  createOscillator() {
    this.count("osc");
    const o = new MockOsc();
    this.oscs.push(o);
    return o;
  }
  createBiquadFilter() {
    this.count("filter");
    return Object.assign(new MockNode(), { type: "lowpass", frequency: new MockParam(), Q: new MockParam() });
  }
  createConvolver() {
    this.count("convolver");
    return Object.assign(new MockNode(), { buffer: null as unknown });
  }
  createBufferSource() {
    this.count("source");
    return Object.assign(new MockNode(), { buffer: null as unknown, start() {}, stop() {} });
  }
  createBuffer(channels: number, length: number) {
    this.count("buffer");
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (ch: number) => data[ch]! };
  }
  async resume() {
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
  async close() {
    this.state = "closed";
  }
}

const mockFactory = () => {
  const box: { ctx: MockCtx | null } = { ctx: null };
  const create = () => {
    box.ctx = new MockCtx();
    return box.ctx as unknown as AudioContext;
  };
  return { box, create };
};

/* ---- presets ------------------------------------------------------ */

describe("sound presets", () => {
  it("every theme carries a sound slot that resolves to a full preset", () => {
    const timbres = new Set<string>();
    for (const id of THEME_IDS) {
      const p = resolveSoundPreset(THEMES[id].sound);
      expect(p.scale.length).toBeGreaterThanOrEqual(5);
      // One octave, ascending, starting at the root.
      expect(p.scale[0]).toBe(0);
      for (let i = 1; i < p.scale.length; i++) expect(p.scale[i]!).toBeGreaterThan(p.scale[i - 1]!);
      expect(p.scale[p.scale.length - 1]!).toBeLessThan(12);
      expect(p.bed.openCutoff).toBeGreaterThan(p.bed.cutoff);
      timbres.add(p.timbre);
    }
    expect([...timbres].sort()).toEqual(["fm", "glass", "keys", "wood"]);
  });

  it("a missing or partial slot falls back to the defaults", () => {
    expect(resolveSoundPreset(undefined)).toBe(DEFAULT_SOUND);
    const p = resolveSoundPreset({ timbre: "glass", bed: { cutoff: 200 } as never });
    expect(p.timbre).toBe("glass");
    expect(p.bed.cutoff).toBe(200);
    expect(p.bed.wave).toBe(DEFAULT_SOUND.bed.wave);
    expect(p.scale).toEqual(DEFAULT_SOUND.scale);
  });

  it("degrees climb and fall octaves; A4 is 440", () => {
    const p = resolveSoundPreset({ scale: [0, 2, 4, 7, 9], root: 60 });
    expect(degreeToMidi(p, 0)).toBe(60);
    expect(degreeToMidi(p, 3)).toBe(67);
    expect(degreeToMidi(p, 5)).toBe(72);
    expect(degreeToMidi(p, -1)).toBe(57);
    expect(degreeToMidi(p, 1, 1)).toBe(74);
    expect(midiToHz(69)).toBeCloseTo(440);
  });

  it("the bed opens with activity, clamped", () => {
    expect(bedCutoff(DEFAULT_SOUND, 0)).toBe(DEFAULT_SOUND.bed.cutoff);
    expect(bedCutoff(DEFAULT_SOUND, 1)).toBe(DEFAULT_SOUND.bed.openCutoff);
    expect(bedCutoff(DEFAULT_SOUND, 5)).toBe(DEFAULT_SOUND.bed.openCutoff);
    expect(bedCutoff(DEFAULT_SOUND, Number.NaN)).toBe(DEFAULT_SOUND.bed.cutoff);
  });
});

/* ---- listener ----------------------------------------------------- */

describe("sound listener", () => {
  it("classifies tool names by verb family", () => {
    expect(toolVerb("Read")).toBe("read");
    expect(toolVerb("Grep")).toBe("read");
    expect(toolVerb("Edit")).toBe("write");
    expect(toolVerb("Bash")).toBe("run");
    expect(toolVerb("TodoWrite")).toBe("think");
    expect(toolVerb("zephyr")).toBe("other");
    expect(toolVerb(null)).toBe("other");
  });

  it("the first sample is a baseline: nothing already on the map sounds", () => {
    const l = new SoundListener();
    const s = span("c1", T0 - 1000);
    expect(l.observe([body("a", { toolCalls: [s], hazard: "fault" })], T0)).toEqual([]);
    // Still running, still faulted: no change, no sound.
    expect(l.observe([body("a", { toolCalls: [s], hazard: "fault" })], T0 + 500)).toEqual([]);
  });

  it("hears starts, finishes, arrivals, hazards and lines", () => {
    const l = new SoundListener();
    l.observe([body("a")], T0);
    const s = span("c1", T0 + 400, { name: "Bash" });
    l.heard("a", T0 + 450);
    const e1 = l.observe([body("a", { toolCalls: [s] }), body("b")], T0 + 500);
    expect(e1.map((e) => e.kind).sort()).toEqual(["arrival", "speech", "start"]);
    expect(e1.find((e) => e.kind === "start")).toMatchObject({ actorId: "a", verb: "run" });
    const e2 = l.observe([body("a", { toolCalls: [done(s, T0 + 900, "error")], hazard: "fault" }), body("b")], T0 + 1000);
    expect(e2).toEqual([
      { kind: "hazard", actorId: "a", at: T0 + 1000 },
      { kind: "finish", actorId: "a", verb: "run", ok: false, at: T0 + 1000 },
    ]);
  });

  it("a short call seen only finished still sounds its finish; stale spans do not", () => {
    const l = new SoundListener();
    l.observe([], T0);
    const quick = done(span("q", T0 - 300), T0 - 100);
    const stale = span("old", T0 - SOUND_FRESH_MS - 1);
    const out = l.observe([body("a", { toolCalls: [quick, stale] })], T0);
    expect(out.filter((e) => e.kind !== "arrival").map((e) => e.kind)).toEqual(["finish"]);
  });

  it("a stall is silent, and a body that stepped out briefly has not arrived again", () => {
    const l = new SoundListener();
    l.observe([body("a")], T0);
    expect(l.observe([body("a", { hazard: "stall" })], T0 + 500)).toEqual([]);
    expect(l.observe([], T0 + 1000)).toEqual([]);
    expect(l.observe([body("a")], T0 + 2000)).toEqual([]);
    l.observe([], T0 + 3000);
    expect(l.observe([body("a")], T0 + 3000 + SOUND_REARRIVE_MS + 1).map((e) => e.kind)).toEqual(["arrival"]);
  });

  it("lines heard before the baseline are dropped; reset forgets", () => {
    const l = new SoundListener();
    l.heard("a", T0);
    expect(l.observe([body("a")], T0)).toEqual([]);
    l.reset();
    expect(l.observe([body("a"), body("b")], T0 + 500)).toEqual([]);
  });

  it("activity saturates at eight open calls", () => {
    expect(activityLevel([])).toBe(0);
    const calls = Array.from({ length: 4 }, (_, i) => span(`c${i}`, T0));
    expect(activityLevel([body("a", { toolCalls: calls })])).toBe(0.5);
    expect(activityLevel([body("a", { toolCalls: [...calls, ...calls, ...calls] })])).toBe(1);
  });
});

/* ---- limiter ------------------------------------------------------ */

const start = (id: string, at = T0): SoundEvent => ({ kind: "start", actorId: id, verb: "read", at });

describe("voice limiter", () => {
  it("collapses a burst of one kind into one voice with a count, priority first", () => {
    const out = collapse([start("a"), start("b"), start("c"), { kind: "arrival", actorId: "d", at: T0 }, { kind: "hazard", actorId: "e", at: T0 }]);
    expect(out.map((e) => [e.kind, e.count])).toEqual([
      ["hazard", 1],
      ["arrival", 1],
      ["start", 3],
    ]);
  });

  it("admits at most four voices in any second, spaced apart, and drops the rest", () => {
    const lim = new VoiceLimiter({ perSecond: 4, spacingMs: 100, hazardGapMs: 8000 });
    const events: SoundEvent[] = [
      { kind: "hazard", actorId: "h", at: T0 },
      { kind: "arrival", actorId: "x", at: T0 },
      { kind: "speech", actorId: "y", at: T0 },
      { kind: "finish", actorId: "z", verb: "write", ok: true, at: T0 },
      start("a"),
      { kind: "start", actorId: "b", verb: "run", at: T0 },
    ];
    const out = lim.admit(events, T0);
    expect(out.map((e) => e.kind)).toEqual(["hazard", "arrival", "speech", "finish"]);
    expect(out.map((e) => e.delayMs)).toEqual([0, 100, 200, 300]);
    // Still inside the same second: nothing more.
    expect(lim.admit([start("c")], T0 + 200)).toEqual([]);
    // A second later there is room again.
    expect(lim.admit([start("c")], T0 + 1400)).toHaveLength(1);
  });

  it("holds hazards to one per gap, so trouble is a tone now and then, never an alarm", () => {
    const lim = new VoiceLimiter({ perSecond: 4, spacingMs: 100, hazardGapMs: 8000 });
    expect(lim.admit([{ kind: "hazard", actorId: "a", at: T0 }], T0)).toHaveLength(1);
    expect(lim.admit([{ kind: "hazard", actorId: "b", at: T0 }], T0 + 2000)).toHaveLength(0);
    expect(lim.admit([{ kind: "hazard", actorId: "b", at: T0 }], T0 + 8000)).toHaveLength(1);
  });

  it("a sustained flood never exceeds the rate over a minute", () => {
    const lim = new VoiceLimiter();
    let admitted = 0;
    for (let t = 0; t < 60_000; t += 500) {
      const flood: SoundEvent[] = [
        start("a", T0 + t),
        { kind: "start", actorId: "b", verb: "write", at: T0 + t },
        { kind: "start", actorId: "c", verb: "run", at: T0 + t },
        { kind: "speech", actorId: "d", at: T0 + t },
        { kind: "arrival", actorId: "e", at: T0 + t },
      ];
      admitted += lim.admit(flood, T0 + t).length;
    }
    expect(admitted).toBeLessThanOrEqual(4 * 60 + 4);
  });
});

/* ---- voices ------------------------------------------------------- */

describe("voices", () => {
  const p = resolveSoundPreset(THEMES.aoe.sound);
  const sched = (e: SoundEvent, count = 1) => ({ ...e, count, delayMs: 0 });

  it("maps each event to its fixed shape; the preset only picks notes", () => {
    expect(voiceFor(sched(start("a")), p).shape).toBe("pluck");
    expect(voiceFor(sched({ kind: "speech", actorId: "a", at: T0 }), p).shape).toBe("chime");
    const motif = voiceFor(sched({ kind: "arrival", actorId: "a", at: T0 }), p);
    expect(motif.shape).toBe("motif");
    expect(motif.notes).toHaveLength(2);
    expect(motif.notes[1]!).toBeGreaterThan(motif.notes[0]!);
    const low = voiceFor(sched({ kind: "hazard", actorId: "a", at: T0 }), p);
    expect(low.shape).toBe("low");
    expect(low.notes[0]!).toBeLessThan(200);
  });

  it("pitches by verb, resolves up on success and falls back down on error", () => {
    const read = voiceFor(sched(start("a")), p).notes[0]!;
    const write = voiceFor(sched({ kind: "start", actorId: "a", verb: "write", at: T0 }), p).notes[0]!;
    expect(write).not.toBe(read);
    const ok = voiceFor(sched({ kind: "finish", actorId: "a", verb: "read", ok: true, at: T0 }), p);
    const bad = voiceFor(sched({ kind: "finish", actorId: "a", verb: "read", ok: false, at: T0 }), p);
    expect(ok.notes[0]!).toBeGreaterThan(read);
    expect(bad.notes[0]!).toBeLessThan(read);
    expect(bad.gain).toBeLessThan(ok.gain);
  });

  it("a burst is a little fuller, never much louder", () => {
    const one = voiceFor(sched(start("a")), p).gain;
    const ten = voiceFor(sched(start("a"), 10), p).gain;
    expect(ten).toBeGreaterThan(one);
    expect(ten).toBeLessThanOrEqual(one * 1.6 + 1e-9);
  });
});

/* ---- settings ----------------------------------------------------- */

describe("sound settings", () => {
  const from = (m: Record<string, string>) => (k: string) => m[k] ?? null;

  it("off by default, on by default in kiosk/TV, an explicit choice wins", () => {
    expect(readSoundSettings(from({}), { kiosk: false })).toEqual({ enabled: false, volume: 0.5, bedOnly: false });
    expect(readSoundSettings(from({}), { kiosk: true }).enabled).toBe(true);
    expect(readSoundSettings(from({ [SOUND_KEY]: "0" }), { kiosk: true }).enabled).toBe(false);
    expect(readSoundSettings(from({ [SOUND_KEY]: "1" }), { kiosk: false }).enabled).toBe(true);
    expect(readSoundSettings(from({ [SOUND_VOLUME_KEY]: "2", [SOUND_BED_ONLY_KEY]: "1" }), { kiosk: false })).toMatchObject({ volume: 1, bedOnly: true });
    expect(readSoundSettings(from({ [SOUND_VOLUME_KEY]: "nope" }), { kiosk: false }).volume).toBe(0.5);
  });

  it("survives storage that throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    expect(readSoundSettings(boom, { kiosk: true })).toEqual({ enabled: true, volume: 0.5, bedOnly: false });
  });

  it("the master stays low", () => {
    expect(masterGain(0)).toBe(0);
    expect(masterGain(1)).toBe(MASTER_CEILING);
    expect(masterGain(0.5)).toBeCloseTo(MASTER_CEILING / 4);
    expect(MASTER_CEILING).toBeLessThanOrEqual(0.25);
  });
});

/* ---- engine + soundscape (mock AudioContext) ---------------------- */

describe("sound engine", () => {
  it("impulse is deterministic noise that decays to silence", () => {
    const a = impulseSamples(1000, 2, 7);
    expect(Array.from(a)).toEqual(Array.from(impulseSamples(1000, 2, 7)));
    const head = a.slice(0, 100).reduce((s, v) => s + Math.abs(v), 0);
    const tail = a.slice(900).reduce((s, v) => s + Math.abs(v), 0);
    expect(tail).toBeLessThan(head / 10);
  });

  it("bed walks the scale and stays below the event voices", () => {
    const p = resolveSoundPreset(THEMES.space.sound);
    const f0 = bedFrequencies(p, 0);
    const f1 = bedFrequencies(p, 1);
    expect(f0).toHaveLength(p.bed.chord.length);
    expect(f1).not.toEqual(f0);
    expect(Math.max(...f0)).toBeLessThan(midiToHz(p.root + 12));
  });

  it("creates nothing until started, then builds a bed, a reverb and plays voices", async () => {
    const { box, create } = mockFactory();
    const engine = new SoundEngine(create, DEFAULT_SOUND, 0.5);
    engine.play({ shape: "pluck", notes: [440], gain: 0.3, duration: 0.5, delayMs: 0 });
    expect(box.ctx).toBeNull();
    expect(await engine.start()).toBe(true);
    const ctx = box.ctx!;
    expect(ctx.made.convolver).toBe(1);
    const bedOscs = ctx.oscs.length;
    // Two detuned oscillators per chord note, plus the LFO.
    expect(bedOscs).toBe(DEFAULT_SOUND.bed.chord.length * 2 + 1);
    engine.play({ shape: "motif", notes: [440, 550], gain: 0.3, duration: 0.5, delayMs: 100 });
    expect(ctx.oscs.length).toBeGreaterThan(bedOscs);
    expect(ctx.oscs.slice(bedOscs).every((o) => o.started && o.stopped)).toBe(true);
  });

  it("plays nothing while suspended", async () => {
    const { box, create } = mockFactory();
    const engine = new SoundEngine(create, DEFAULT_SOUND, 0.5);
    await engine.start();
    await box.ctx!.suspend();
    const n = box.ctx!.oscs.length;
    engine.play({ shape: "chime", notes: [880], gain: 0.2, duration: 1, delayMs: 0 });
    expect(box.ctx!.oscs.length).toBe(n);
  });
});

describe("soundscape", () => {
  it("samples at its own cadence, and bed only keeps the pad but no voices", async () => {
    const { box, create } = mockFactory();
    const scape = new Soundscape(create);
    expect(scape.active).toBe(false);
    expect(scape.sample([body("a")], T0)).toEqual([]);
    await scape.start();
    expect(scape.active).toBe(true);
    scape.sample([body("a")], T0); // baseline
    // Inside the step: ignored entirely.
    expect(scape.sample([body("a"), body("b")], T0 + SOUND_STEP_MS - 1)).toEqual([]);
    const voices = scape.sample([body("a"), body("b")], T0 + SOUND_STEP_MS);
    expect(voices.map((v) => v.shape)).toEqual(["motif"]);

    scape.setBedOnly(true);
    const before = box.ctx!.oscs.length;
    expect(scape.sample([body("a"), body("b"), body("c")], T0 + 2 * SOUND_STEP_MS)).toEqual([]);
    expect(box.ctx!.oscs.length).toBe(before);
  });

  it("switching on never plays a backlog", async () => {
    const { create } = mockFactory();
    const scape = new Soundscape(create);
    scape.heard("a", T0); // ignored while off
    await scape.start();
    expect(scape.sample([body("a"), body("b")], T0)).toEqual([]);
    await scape.stop();
    expect(scape.active).toBe(false);
  });
});
