import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_SPOKEN,
  READ_ALOUD_KEY,
  Reader,
  SITE_MUTE_KEY,
  assignVoice,
  entryKey,
  hashId,
  loadSettings,
  moreLines,
  parseSettings,
  planBacklog,
  sanitizeSpoken,
  saveSettings,
  siteMuted,
  speakable,
  toUtterances,
  voicesForLang,
  type FilterContext,
  type HeardEntry,
  type ReadAloudSettings,
  type SpokenUtterance,
  type Store,
  type Utterance,
  type VoiceLike,
} from "@/lib/read-aloud";

const v = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({
  name,
  lang,
  voiceURI: `uri:${name}`,
  localService: true,
  ...extra,
});

const VOICES = [
  v("Alex", "en-US", { default: true }),
  v("Daniel", "en-GB"),
  v("Karen", "en-AU"),
  v("Moira", "en-IE"),
  v("Amelie", "fr-CA"),
  v("Anna", "de-DE"),
  v("Cloud", "en-US", { localService: false }),
];

function memory(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, val) => void data.set(k, val) };
}
const throwing: Store = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("read aloud settings", () => {
  it("is off by default, and survives junk and a throwing store", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.on).toBe(false);
    expect(DEFAULT_SETTINGS.includeWhispers).toBe(false);
    expect(parseSettings("{nope")).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(throwing, { ...DEFAULT_SETTINGS, on: true })).not.toThrow();
  });

  it("round-trips, clamping the rate", () => {
    const s = memory();
    saveSettings(s, { on: true, includeWhispers: true, rate: 9, oneVoice: true });
    expect(s.data.has(READ_ALOUD_KEY)).toBe(true);
    expect(loadSettings(s)).toEqual({ on: true, includeWhispers: true, rate: 2, oneVoice: true });
    expect(parseSettings(JSON.stringify({ on: "yes", rate: "fast" }))).toEqual(DEFAULT_SETTINGS);
  });

  it("reads the soundscape's site-wide mute flag without owning it", () => {
    const s = memory();
    expect(siteMuted(s)).toBe(false);
    s.setItem(SITE_MUTE_KEY, "1");
    expect(siteMuted(s)).toBe(true);
    s.setItem(SITE_MUTE_KEY, "true");
    expect(siteMuted(s)).toBe(true);
    s.setItem(SITE_MUTE_KEY, "0");
    expect(siteMuted(s)).toBe(false);
    expect(siteMuted(throwing)).toBe(false);
  });
});

describe("what a line sounds like", () => {
  it("turns URLs into 'link' and keeps markdown link words", () => {
    expect(sanitizeSpoken("see https://example.com/a?b=c now")).toBe("see link now");
    expect(sanitizeSpoken("docs at www.example.org.")).toBe("docs at link");
    expect(sanitizeSpoken("read [the rules](https://x.test/rules)")).toBe("read the rules");
  });

  it("does not read code blocks, open or closed", () => {
    expect(sanitizeSpoken("try this ```js\nconst a = 1;\n``` ok")).toBe("try this code ok");
    expect(sanitizeSpoken("half ```python\nprint(1)")).toBe("half code");
    expect(sanitizeSpoken("run `ls` then `pnpm --filter @grove/web test --run`")).toBe("run ls then code");
  });

  it("caps long lines on a word boundary and drops lines with no words", () => {
    const long = "word ".repeat(200);
    const out = sanitizeSpoken(long);
    expect(out.length).toBeLessThanOrEqual(MAX_SPOKEN + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
    expect(sanitizeSpoken("  *** ___ ")).toBe("");
    expect(sanitizeSpoken("")).toBe("");
  });
});

describe("who is read aloud", () => {
  const say = (id: string, senderId: string, body = "hello", at = 0): HeardEntry => ({
    kind: "say",
    id,
    body,
    at,
    senderId,
    senderKind: "agent",
  });
  const whisper = (id: string, direction: "in" | "out", otherId = "a1"): HeardEntry => ({
    kind: "whisper",
    id,
    body: "psst",
    at: 0,
    direction,
    otherId,
    otherKind: "human",
  });
  const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
    meId: "me",
    includeWhispers: false,
    hiddenIds: new Set(),
    silencedIds: new Set(),
    seenIds: new Set(),
    since: 1_000_000,
    ...over,
  });

  it("never your own lines, never silenced senders, never hidden lines", () => {
    const entries = [say("1", "me"), say("2", "blocked"), say("3", "a1"), say("4", "a2")];
    const out = speakable(entries, ctx({ silencedIds: new Set(["blocked"]), hiddenIds: new Set(["4"]) }));
    expect(out.map((e) => e.id)).toEqual(["3"]);
  });

  it("whispers to you only when asked, and never your own outgoing whispers", () => {
    const entries = [whisper("w1", "in"), whisper("w2", "out"), whisper("w3", "in", "muted")];
    expect(speakable(entries, ctx())).toEqual([]);
    const on = speakable(entries, ctx({ includeWhispers: true, silencedIds: new Set(["muted"]) }));
    expect(on.map((e) => e.id)).toEqual(["w1"]);
  });

  it("skips what was already seen and what is history", () => {
    const entries = [say("1", "a1"), say("2", "a1", "old", 1), say("3", "a1", "new", 999_000)];
    const out = speakable(entries, ctx({ seenIds: new Set([entryKey(entries[0]!)]) }));
    expect(out.map((e) => e.id)).toEqual(["3"]);
    expect(entryKey(say("x", "a"))).not.toBe(entryKey(whisper("x", "in")));
  });

  it("makes utterances from what is left, skipping lines with nothing to say", () => {
    const u = toUtterances([say("1", "a1", "https://x.test"), say("2", "a1", "```\ncode\n```"), say("3", "a1", "!!!")]);
    expect(u.map((x) => x.text)).toEqual(["link", "code"]);
  });
});

describe("keeping up with a busy room", () => {
  const line = (n: number): Utterance => ({ kind: "line", key: `say:${n}`, speakerId: "a", speakerKind: "agent", text: `l${n}` });

  it("leaves a short backlog alone", () => {
    const q = [line(1), line(2), line(3)];
    expect(planBacklog(q)).toEqual(q);
  });

  it("summarises the older lines and reads the newest", () => {
    const q = planBacklog([line(1), line(2), line(3), line(4), line(5)]);
    expect(q).toEqual([{ kind: "summary", count: 4, text: "4 more lines" }, line(5)]);
    // A summary already queued is counted, not spoken twice.
    const again = planBacklog([...q, line(6), line(7), line(8)]);
    expect(again[0]).toEqual({ kind: "summary", count: 7, text: "7 more lines" });
    expect(again[1]).toEqual(line(8));
    expect(moreLines(1)).toBe("1 more line");
  });
});

describe("voices", () => {
  const opts = { pageLang: "en", rate: 1, oneVoice: false };

  it("filters to the page language and prefers local voices", () => {
    const pool = voicesForLang(VOICES, "en-GB");
    expect(pool.map((x) => x.name)).toEqual(["Alex", "Daniel", "Karen", "Moira"]);
    expect(voicesForLang(VOICES, "ja").length).toBe(6);
    expect(voicesForLang([], "en")).toEqual([]);
  });

  it("gives the same actor the same voice every time, whatever order the browser lists them in", () => {
    const a = assignVoice("agent-123", "agent", VOICES, opts);
    const b = assignVoice("agent-123", "agent", [...VOICES].reverse(), opts);
    expect(b).toEqual(a);
    expect(hashId("agent-123")).toBe(hashId("agent-123"));
    expect(hashId("agent-123")).not.toBe(hashId("agent-124"));
  });

  it("keeps agents and humans in different voice families and pitches", () => {
    const agentVoices = new Set<string>();
    const humanVoices = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const ag = assignVoice(`agent-${i}`, "agent", VOICES, opts);
      const hu = assignVoice(`human-${i}`, "human", VOICES, opts);
      agentVoices.add(ag.voice!.name);
      humanVoices.add(hu.voice!.name);
      expect(ag.pitch).toBeLessThan(hu.pitch);
      expect(ag.rate).toBeGreaterThan(0.9);
      expect(ag.rate).toBeLessThan(1.1);
    }
    for (const name of agentVoices) expect(humanVoices.has(name)).toBe(false);
  });

  it("one voice for all uses the default voice, unvaried, at the chosen rate", () => {
    const a = assignVoice("agent-1", "agent", VOICES, { ...opts, oneVoice: true, rate: 1.5 });
    const b = assignVoice("human-9", "human", VOICES, { ...opts, oneVoice: true, rate: 1.5 });
    expect(a).toEqual(b);
    expect(a).toEqual({ voice: VOICES[0], pitch: 1, rate: 1.5 });
  });

  it("copes with no voices at all", () => {
    expect(assignVoice("x", "agent", [], opts)).toEqual({ voice: null, pitch: 1, rate: 1 });
  });
});

describe("the reader, over a mocked speechSynthesis", () => {
  function mock() {
    const spoken: SpokenUtterance[] = [];
    let cancels = 0;
    const speaking: Array<string | null> = [];
    let settings: ReadAloudSettings = { ...DEFAULT_SETTINGS, on: true };
    const reader = new Reader({
      synth: {
        speak: (u) => void spoken.push(u),
        cancel: () => void cancels++,
        getVoices: () => VOICES,
      },
      makeUtterance: (text) => ({ text, voice: null, pitch: 1, rate: 1, lang: "", onend: null, onerror: null }),
      pageLang: "en",
      getSettings: () => settings,
      onSpeaking: (k) => void speaking.push(k),
    });
    return {
      reader,
      spoken,
      speaking,
      cancels: () => cancels,
      set: (s: Partial<ReadAloudSettings>) => (settings = { ...settings, ...s }),
    };
  }
  const line = (n: number, who = "a1"): Utterance => ({ kind: "line", key: `say:${n}`, speakerId: who, speakerKind: "agent", text: `line ${n}` });

  it("speaks one at a time, in order, highlighting each", () => {
    const m = mock();
    m.reader.enqueue([line(1), line(2)]);
    expect(m.spoken.map((u) => u.text)).toEqual(["line 1"]);
    expect(m.speaking).toEqual(["say:1"]);
    m.spoken[0]!.onend!();
    expect(m.spoken.map((u) => u.text)).toEqual(["line 1", "line 2"]);
    m.spoken[1]!.onend!();
    expect(m.speaking).toEqual(["say:1", "say:2", null]);
    expect(m.reader.busy).toBe(false);
  });

  it("does not fall behind: a flood becomes a summary and the newest line", () => {
    const m = mock();
    m.reader.enqueue([line(1)]);
    m.reader.enqueue([line(2), line(3), line(4), line(5), line(6)]);
    expect(m.reader.pending.map((u) => u.text)).toEqual(["4 more lines", "line 6"]);
    m.spoken[0]!.onend!();
    expect(m.spoken[1]!.text).toBe("4 more lines");
    m.spoken[1]!.onend!();
    expect(m.spoken[2]!.text).toBe("line 6");
  });

  it("stop cancels, clears and ignores the cancelled line's end event", () => {
    const m = mock();
    m.reader.enqueue([line(1), line(2)]);
    m.reader.stop();
    expect(m.cancels()).toBe(1);
    expect(m.reader.pending).toEqual([]);
    expect(m.speaking.at(-1)).toBeNull();
    m.spoken[0]!.onend!();
    expect(m.spoken.length).toBe(1);
  });

  it("applies the speaker's voice and the viewer's rate", () => {
    const m = mock();
    m.set({ rate: 1.5, oneVoice: true });
    m.reader.enqueue([line(1, "agent-x")]);
    expect(m.spoken[0]!.voice).toEqual(VOICES[0]);
    expect(m.spoken[0]!.rate).toBe(1.5);
    expect(m.spoken[0]!.lang).toBe("en-US");
  });

  it("an engine that throws on speak moves on rather than sticking", () => {
    let calls = 0;
    const reader = new Reader({
      synth: {
        speak: () => {
          calls++;
          throw new Error("not allowed");
        },
        cancel: () => {},
        getVoices: () => [],
      },
      makeUtterance: (text) => ({ text, voice: null, pitch: 1, rate: 1, lang: "", onend: null, onerror: null }),
      pageLang: "en",
      getSettings: () => DEFAULT_SETTINGS,
      onSpeaking: () => {},
    });
    reader.enqueue([line(1), line(2)]);
    expect(calls).toBe(2);
    expect(reader.busy).toBe(false);
  });
});
