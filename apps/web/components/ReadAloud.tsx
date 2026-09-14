"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  Reader,
  entryKey,
  loadSettings,
  saveSettings,
  speakable,
  toUtterances,
  type HeardEntry,
  type ReadAloudSettings,
  type SpokenUtterance,
  type SynthLike,
} from "@/lib/read-aloud";
import { isSoundMuted, subscribeSoundMuted } from "@/lib/sound/prefs";
import { useSoundMuted } from "@/lib/sound/useSoundMuted";

/**
 * Read aloud in the room drawer (#44). The browser's own speech engine reads
 * new lines you receive; captions are the transcript itself, with the line
 * being spoken highlighted. Nothing is sent anywhere and no microphone is used.
 */

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type ReadAloudState = {
  supported: boolean;
  settings: ReadAloudSettings;
  update: (patch: Partial<ReadAloudSettings>) => void;
  /** entryKey() of the line being spoken, for the caption highlight. */
  speakingKey: string | null;
  /** The viewer started typing: stop talking over them. */
  interrupt: () => void;
  /** The site-wide mute (#56), shared with the map soundscape. */
  muted: boolean;
  setMuted: (muted: boolean) => void;
};

export function useReadAloud(opts: {
  /** The drawer's room; a new room starts fresh. */
  roomKey: string;
  /** True once this room's transcript has loaded, so its history is not read out. */
  ready: boolean;
  entries: readonly HeardEntry[];
  meId: string | null;
  hiddenIds: ReadonlySet<string>;
}): ReadAloudState {
  const { roomKey, ready, entries, meId, hiddenIds } = opts;
  const [supported, setSupported] = useState(false);
  const [settings, setSettings] = useState<ReadAloudSettings>(DEFAULT_SETTINGS);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [muted, setMuted] = useSoundMuted();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const readerRef = useRef<Reader | null>(null);
  const seen = useRef(new Set<string>());
  const since = useRef(Date.now());
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    let ok = false;
    try {
      ok = "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
    } catch {
      ok = false;
    }
    setSupported(ok);
    setSettings(loadSettings(store()));
    if (!ok) return;
    const synth = window.speechSynthesis;
    // Some engines fill the voice list late; asking once starts the load.
    try {
      synth.getVoices();
    } catch {
      /* voices arrive or they do not */
    }
    readerRef.current = new Reader({
      synth: synth as unknown as SynthLike,
      makeUtterance: (text) => new window.SpeechSynthesisUtterance(text) as unknown as SpokenUtterance,
      pageLang: document.documentElement.lang || navigator.language || "en",
      getSettings: () => settingsRef.current,
      onSpeaking: setSpeakingKey,
    });
    const reader = readerRef.current;
    return () => {
      // Closing the drawer stops the voice.
      reader.stop();
      readerRef.current = null;
    };
  }, []);

  const update = useCallback((patch: Partial<ReadAloudSettings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(store(), next);
      return next;
    });
  }, []);

  const interrupt = useCallback(() => readerRef.current?.stop(), []);

  // Turning it off stops at once; turning it on reads only what comes next.
  useEffect(() => {
    if (!settings.on) {
      readerRef.current?.stop();
      return;
    }
    since.current = Date.now();
    for (const e of entries) seen.current.add(entryKey(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.on]);

  // A new room: stop, forget, and wait for its transcript before listening.
  useEffect(() => {
    readerRef.current?.stop();
    seen.current = new Set();
    seededFor.current = null;
    since.current = Date.now();
  }, [roomKey]);

  // A hidden tab is not listening.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") readerRef.current?.stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Muted anywhere (⋯, this drawer, another tab): cancel speech at once, not a render later.
  useEffect(() => subscribeSoundMuted((m) => void (m && readerRef.current?.stop())), []);

  useEffect(() => {
    if (!ready) return;
    if (seededFor.current !== roomKey) {
      // Everything already in the transcript is history.
      seededFor.current = roomKey;
      for (const e of entries) seen.current.add(entryKey(e));
      return;
    }
    const fresh = speakable(entries, {
      meId,
      includeWhispers: settings.includeWhispers,
      hiddenIds,
      silencedIds: new Set(),
      seenIds: seen.current,
      since: since.current,
    });
    for (const e of entries) seen.current.add(entryKey(e));
    const reader = readerRef.current;
    if (!reader || !settings.on || fresh.length === 0) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    // Checked at the moment of speaking too, in case the event has not landed yet.
    if (isSoundMuted()) return;
    reader.enqueue(toUtterances(fresh));
  }, [entries, ready, roomKey, meId, hiddenIds, settings.on, settings.includeWhispers]);

  // A line the server hid mid-sentence stops being read.
  useEffect(() => {
    if (speakingKey && hiddenIds.has(speakingKey.slice(speakingKey.indexOf(":") + 1))) readerRef.current?.stop();
  }, [hiddenIds, speakingKey]);

  return { supported, settings, update, speakingKey, interrupt, muted, setMuted };
}

/**
 * The site-wide mute as a small speaker, bound to the same flag as ⋯ Mute all
 * sound: it silences read aloud and the map soundscape together.
 */
export function MuteToggle({ muted, setMuted }: { muted: boolean; setMuted: (m: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => setMuted(!muted)}
      aria-pressed={muted}
      aria-label="Mute all sound"
      title={muted ? "Sound is muted site-wide. Tap to unmute." : "Mute all sound: read aloud and the map soundscape"}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full sm:h-7 sm:w-7 ${
        muted ? "bg-tint text-muted" : "border border-line-strong text-muted hover:text-ink"
      }`}
    >
      <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5z" fill="currentColor" stroke="none" />
        {muted ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" />}
      </svg>
    </button>
  );
}

/** The toggle and its few settings, next to the Transcript heading. Read aloud hides where the browser cannot speak; the mute stays. */
export function ReadAloudControl({ state }: { state: ReadAloudState }) {
  const { supported, settings, update, muted, setMuted } = state;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        {supported ? (
          <button
            type="button"
            onClick={() => update({ on: !settings.on })}
            aria-pressed={settings.on}
            title="Your browser reads new lines out loud, on this device only"
            className={`min-h-8 rounded-gh-pill px-3 py-1.5 gh-label sm:py-1 ${
              settings.on ? "border border-ink bg-tint text-ink" : "border border-line-strong bg-surface-raised text-ink hover:bg-tint"
            }`}
          >
            Read aloud
          </button>
        ) : null}
        <MuteToggle muted={muted} setMuted={setMuted} />
      </div>
      {supported && settings.on ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted">
          <label className="flex min-h-[40px] items-center gap-1.5 sm:min-h-0">
            <input
              type="checkbox"
              checked={settings.includeWhispers}
              onChange={(e) => update({ includeWhispers: e.target.checked })}
            />
            Include whispers to me
          </label>
          <label className="flex min-h-[40px] items-center gap-1.5 sm:min-h-0">
            <input type="checkbox" checked={settings.oneVoice} onChange={(e) => update({ oneVoice: e.target.checked })} />
            One voice for all
          </label>
          <label className="flex min-h-[40px] items-center gap-1.5 sm:min-h-0">
            Speed
            <select
              value={String(settings.rate)}
              onChange={(e) => update({ rate: Number(e.target.value) })}
              className="min-h-[36px] rounded-gh-sm border border-line-strong bg-surface-raised px-1 py-0.5 text-ink sm:min-h-0"
            >
              {[0.8, 1, 1.2, 1.5, 1.8].map((r) => (
                <option key={r} value={String(r)}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <span className="w-full text-muted">
            {muted
              ? "Sound is muted site-wide, so nothing is read out."
              : "New lines only. Spoken by your browser; nothing leaves this device."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
