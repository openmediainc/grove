/**
 * Read aloud (#44): the room drawer can speak the lines you already receive,
 * using the browser's own text-to-speech (`window.speechSynthesis`).
 *
 * Nothing leaves the browser: no network TTS, no microphone, no recording.
 * The transcript the drawer shows is already the kernel's answer for this
 * viewer (blocks, mutes, lurk, agent policy), so this only ever narrows it:
 * never your own lines, whispers only when you ask for them, never a line the
 * server later hid from you, and never a sender you have silenced.
 *
 * Everything here is pure (or takes the speech engine as an argument), so the
 * voice assignment, the backlog summary, the sanitiser and the filter are
 * testable without a browser.
 */

import { parseMuted, SOUND_MUTED_KEY } from "./sound/prefs";

/** Remembered per browser. */
export const READ_ALOUD_KEY = "glasshouse-read-aloud";
/** The shared site-wide mute (#56, lib/sound/prefs). */
export const SITE_MUTE_KEY = SOUND_MUTED_KEY;

/** Longest line spoken, in characters. The transcript still shows all of it. */
export const MAX_SPOKEN = 280;
/** More waiting than this and the older ones become "N more lines". */
export const MAX_BACKLOG = 3;

export type ReadAloudSettings = {
  on: boolean;
  includeWhispers: boolean;
  /** 0.5 – 2, the engine's own scale. */
  rate: number;
  oneVoice: boolean;
};

export const DEFAULT_SETTINGS: ReadAloudSettings = { on: false, includeWhispers: false, rate: 1, oneVoice: false };

export type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const clampRate = (r: unknown): number => {
  const n = typeof r === "number" && Number.isFinite(r) ? r : 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 10) / 10));
};

export function parseSettings(raw: string | null | undefined): ReadAloudSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof ReadAloudSettings, unknown>>;
    return {
      on: v.on === true,
      includeWhispers: v.includeWhispers === true,
      rate: clampRate(v.rate),
      oneVoice: v.oneVoice === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function loadSettings(store: Store | null | undefined): ReadAloudSettings {
  try {
    return parseSettings(store?.getItem(READ_ALOUD_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: Store | null | undefined, s: ReadAloudSettings): void {
  try {
    store?.setItem(READ_ALOUD_KEY, JSON.stringify({ ...s, rate: clampRate(s.rate) }));
  } catch {
    /* private mode: the choice lasts as long as the page */
  }
}

/** The site-wide mute, if it has ever been set. Absent or unreadable = not muted. */
export function siteMuted(store: Store | null | undefined): boolean {
  try {
    return parseMuted(store?.getItem(SITE_MUTE_KEY));
  } catch {
    return false;
  }
}

/**
 * What a line sounds like: fenced code is not read, URLs become "link",
 * markdown noise goes, and it stops at MAX_SPOKEN on a word boundary.
 * Returns "" when nothing is left worth saying.
 */
export function sanitizeSpoken(text: string, max = MAX_SPOKEN): string {
  let s = String(text ?? "");
  // Fenced blocks, closed or left open at the end.
  s = s.replace(/```[\s\S]*?(```|$)/g, " code ");
  // Inline code: long spans are code, short ones are words.
  s = s.replace(/`([^`\n]*)`/g, (_, inner: string) => (inner.length > 24 ? " code " : inner));
  // Markdown links keep their words; bare URLs become "link".
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, "link");
  s = s.replace(/[*_~#>|]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return "";
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/** A transcript entry as the drawer holds it. */
export type HeardEntry = { id: string; body: string; /** ms since epoch, 0 when unknown. */ at: number } & (
  | { kind: "say"; senderId: string; senderKind: string }
  | { kind: "whisper"; direction: "in" | "out"; otherId: string; otherKind: string }
);

export type FilterContext = {
  meId: string | null;
  includeWhispers: boolean;
  /** Lines the server hid from you after the fact (`speech_hidden`). */
  hiddenIds: ReadonlySet<string>;
  /** Senders you have blocked or muted, when the client knows them. */
  silencedIds: ReadonlySet<string>;
  /** Already spoken or already on screen when read aloud started. */
  seenIds: ReadonlySet<string>;
  /**
   * Lines older than this (ms) are history, not news: whisper history and a
   * reloaded transcript land after the reader started and must not be read out.
   */
  since: number;
};

/** Clock slack between the server's timestamps and this browser's. */
export const SINCE_SLACK_MS = 60_000;

/** Key for `seenIds`: a say and a whisper may share an id space. */
export const entryKey = (e: HeardEntry): string => `${e.kind}:${e.id}`;

/** The entries worth speaking, in order. */
export function speakable(entries: readonly HeardEntry[], ctx: FilterContext): HeardEntry[] {
  return entries.filter((e) => {
    if (ctx.seenIds.has(entryKey(e)) || ctx.hiddenIds.has(e.id)) return false;
    if (e.at && e.at < ctx.since - SINCE_SLACK_MS) return false;
    if (e.kind === "say") {
      if (ctx.meId && e.senderId === ctx.meId) return false;
      return !ctx.silencedIds.has(e.senderId);
    }
    if (!ctx.includeWhispers || e.direction !== "in") return false;
    return !ctx.silencedIds.has(e.otherId);
  });
}

export type Utterance =
  | { kind: "line"; key: string; speakerId: string; speakerKind: string; text: string }
  | { kind: "summary"; count: number; text: string };

export function moreLines(n: number): string {
  return n === 1 ? "1 more line" : `${n} more lines`;
}

/**
 * Keep up rather than fall behind: with more than MAX_BACKLOG waiting, the
 * older ones are summarised ("4 more lines") and only the newest is read.
 */
export function planBacklog(pending: readonly Utterance[], maxBacklog = MAX_BACKLOG): Utterance[] {
  if (pending.length <= maxBacklog) return [...pending];
  const newest = pending[pending.length - 1]!;
  const dropped = pending
    .slice(0, -1)
    .reduce((n, u) => n + (u.kind === "summary" ? u.count : 1), 0);
  return [{ kind: "summary", count: dropped, text: moreLines(dropped) }, newest];
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

export type VoiceLike = { name: string; lang: string; voiceURI: string; default?: boolean; localService?: boolean };

export type VoicePick<V extends VoiceLike = VoiceLike> = { voice: V | null; pitch: number; rate: number };

/** FNV-1a, 32-bit: stable across sessions and browsers. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Voices for the page language (by primary subtag), local ones first; all voices if none match. */
export function voicesForLang<V extends VoiceLike>(voices: readonly V[], pageLang: string): V[] {
  const want = (pageLang || "en").toLowerCase().split(/[-_]/)[0];
  const sorted = [...voices].sort((a, b) => a.voiceURI.localeCompare(b.voiceURI));
  const match = sorted.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === want);
  const pool = match.length ? match : sorted;
  const local = pool.filter((v) => v.localService !== false);
  return local.length ? local : pool;
}

/**
 * A speaker's voice, the same every time for the same actor id. Agents and
 * humans draw from disjoint halves of the pool when there are at least two
 * voices, and sit at different pitches either way, so the two are told apart
 * by ear. "One voice for all" gives everyone the default voice, unvaried.
 */
export function assignVoice<V extends VoiceLike>(
  actorId: string,
  kind: string,
  voices: readonly V[],
  opts: { pageLang: string; rate: number; oneVoice: boolean },
): VoicePick<V> {
  const rate = clampRate(opts.rate);
  const pool = voicesForLang(voices, opts.pageLang);
  if (opts.oneVoice || pool.length === 0) {
    return { voice: pool.find((v) => v.default) ?? pool[0] ?? null, pitch: 1, rate };
  }
  const agent = kind === "agent";
  const h = hashId(actorId);
  const family = pool.length >= 2 ? pool.filter((_, i) => i % 2 === (agent ? 0 : 1)) : pool;
  const voice = family[h % family.length]!;
  // Slight variation, from different bits of the hash than the voice choice.
  const pitchStep = ((h >>> 8) % 5) - 2; // -2..2
  const rateStep = ((h >>> 16) % 5) - 2;
  const pitch = Math.round(((agent ? 0.85 : 1.1) + pitchStep * 0.05) * 100) / 100;
  const r = Math.min(2, Math.max(0.5, Math.round(rate * (1 + rateStep * 0.03) * 100) / 100));
  return { voice, pitch, rate: r };
}

// ---------------------------------------------------------------------------
// The queue, over any engine shaped like speechSynthesis
// ---------------------------------------------------------------------------

export type SpokenUtterance = {
  text: string;
  voice: VoiceLike | null;
  pitch: number;
  rate: number;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

export type SynthLike = {
  speak(u: SpokenUtterance): void;
  cancel(): void;
  getVoices(): VoiceLike[];
};

export type ReaderOptions = {
  synth: SynthLike;
  /** Builds the engine's utterance object (a real SpeechSynthesisUtterance in the browser). */
  makeUtterance: (text: string) => SpokenUtterance;
  pageLang: string;
  getSettings: () => ReadAloudSettings;
  /** The line being spoken now, or null: drives the caption highlight. */
  onSpeaking: (key: string | null) => void;
};

/**
 * One line at a time. New lines join the queue; the queue is re-planned so a
 * busy room never makes the reader fall behind. `stop()` is for closing the
 * drawer, hiding the tab and the viewer starting to type.
 */
export class Reader {
  private queue: Utterance[] = [];
  private speaking = false;
  /** Bumped on stop, so an end event from a cancelled line is ignored. */
  private generation = 0;

  constructor(private readonly o: ReaderOptions) {}

  get busy(): boolean {
    return this.speaking;
  }

  get pending(): readonly Utterance[] {
    return this.queue;
  }

  enqueue(items: readonly Utterance[]): void {
    if (items.length === 0) return;
    this.queue = planBacklog([...this.queue, ...items]);
    if (!this.speaking) this.next();
  }

  stop(): void {
    this.generation++;
    this.queue = [];
    if (this.speaking) {
      this.speaking = false;
      this.o.onSpeaking(null);
    }
    try {
      this.o.synth.cancel();
    } catch {
      /* nothing was playing */
    }
  }

  private next(): void {
    const u = this.queue.shift();
    if (!u) {
      this.speaking = false;
      this.o.onSpeaking(null);
      return;
    }
    const s = this.o.getSettings();
    const pick =
      u.kind === "line"
        ? assignVoice(u.speakerId, u.speakerKind, this.o.synth.getVoices(), {
            pageLang: this.o.pageLang,
            rate: s.rate,
            oneVoice: s.oneVoice,
          })
        : assignVoice("", "", this.o.synth.getVoices(), { pageLang: this.o.pageLang, rate: s.rate, oneVoice: true });
    const utt = this.o.makeUtterance(u.text);
    if (pick.voice) utt.voice = pick.voice;
    utt.pitch = pick.pitch;
    utt.rate = pick.rate;
    utt.lang = pick.voice?.lang || this.o.pageLang;
    const gen = this.generation;
    const done = () => {
      if (gen !== this.generation) return;
      this.next();
    };
    utt.onend = done;
    utt.onerror = done;
    this.speaking = true;
    this.o.onSpeaking(u.kind === "line" ? u.key : null);
    try {
      this.o.synth.speak(utt);
    } catch {
      done();
    }
  }
}

/** Turn speakable entries into utterances; a line that sanitises to nothing is skipped. */
export function toUtterances(entries: readonly HeardEntry[]): Utterance[] {
  const out: Utterance[] = [];
  for (const e of entries) {
    const text = sanitizeSpoken(e.body);
    if (!text) continue;
    out.push(
      e.kind === "say"
        ? { kind: "line", key: entryKey(e), speakerId: e.senderId, speakerKind: e.senderKind, text }
        : { kind: "line", key: entryKey(e), speakerId: e.otherId, speakerKind: e.otherKind, text },
    );
  }
  return out;
}
