"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  Reader,
  SITE_MUTE_KEY,
  entryKey,
  loadSettings,
  saveSettings,
  siteMuted,
  speakable,
  toUtterances,
  type HeardEntry,
  type ReadAloudSettings,
  type SpokenUtterance,
  type SynthLike,
} from "@/lib/read-aloud";

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
  muted: boolean;
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
  const [muted, setMuted] = useState(false);
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
    setMuted(siteMuted(store()));
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
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== SITE_MUTE_KEY) return;
      const m = siteMuted(store());
      setMuted(m);
      if (m) readerRef.current?.stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

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
    // Re-read each time: the soundscape's mute may have changed in this tab.
    const m = siteMuted(store());
    setMuted(m);
    if (m) return;
    reader.enqueue(toUtterances(fresh));
  }, [entries, ready, roomKey, meId, hiddenIds, settings.on, settings.includeWhispers]);

  // A line the server hid mid-sentence stops being read.
  useEffect(() => {
    if (speakingKey && hiddenIds.has(speakingKey.slice(speakingKey.indexOf(":") + 1))) readerRef.current?.stop();
  }, [hiddenIds, speakingKey]);

  return { supported, settings, update, speakingKey, interrupt, muted };
}

/** The toggle and its few settings, next to the Transcript heading. Hidden where the browser cannot speak. */
export function ReadAloudControl({ state }: { state: ReadAloudState }) {
  const { supported, settings, update, muted } = state;
  if (!supported) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => update({ on: !settings.on })}
        aria-pressed={settings.on}
        title="Your browser reads new lines out loud, on this device only"
        className={`rounded-full px-3 py-1.5 text-[11px] uppercase tracking-widest sm:py-1 ${
          settings.on ? "bg-lantern-400 text-dusk-950" : "border border-lantern-400/40 text-lantern-300"
        }`}
      >
        Read aloud
      </button>
      {settings.on ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-white/60">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={settings.includeWhispers}
              onChange={(e) => update({ includeWhispers: e.target.checked })}
            />
            Include whispers to me
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={settings.oneVoice} onChange={(e) => update({ oneVoice: e.target.checked })} />
            One voice for all
          </label>
          <label className="flex items-center gap-1.5">
            Speed
            <select
              value={String(settings.rate)}
              onChange={(e) => update({ rate: Number(e.target.value) })}
              className="rounded bg-dusk-800 px-1 py-0.5 ring-1 ring-white/10"
            >
              {[0.8, 1, 1.2, 1.5, 1.8].map((r) => (
                <option key={r} value={String(r)}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          <span className="w-full text-white/35">
            {muted
              ? "Sound is muted site-wide, so nothing is read out."
              : "New lines only. Spoken by your browser; nothing leaves this device."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
