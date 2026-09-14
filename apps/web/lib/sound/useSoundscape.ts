"use client";

/**
 * React wiring for the soundscape: settings in localStorage (try/catch), the
 * autoplay gesture, tab visibility, and the theme's preset. The map gets back
 * a stable `scape` to feed from its draw loop and poll, and the state the ⋯
 * menu and the kiosk "Tap for sound" prompt render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSoundPreset, type SoundPreset } from "./presets";
import { readSoundSettings, SOUND_BED_ONLY_KEY, SOUND_KEY, SOUND_VOLUME_KEY, type SoundSettings } from "./settings";
import { Soundscape } from "./soundscape";
import { useSoundMuted } from "./useSoundMuted";

export interface SoundControls {
  scape: Soundscape;
  enabled: boolean;
  volume: number;
  bedOnly: boolean;
  /** The site-wide mute (#56): silences this and read aloud, whatever `enabled` says. */
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /** Audio is actually playing (the context is running). */
  playing: boolean;
  /** Sound is on but the browser is waiting for a tap or key. */
  needsGesture: boolean;
  supported: boolean;
  setEnabled: (on: boolean) => void;
  setVolume: (v: number) => void;
  setBedOnly: (on: boolean) => void;
  /** Start audio from a gesture (the tap prompt). */
  begin: () => void;
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: the choice lasts this visit */
  }
}

function audioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function useSoundscape({ kiosk, sound }: { kiosk: boolean; sound: Partial<SoundPreset> | undefined }): SoundControls {
  const [scape] = useState(
    () =>
      new Soundscape(() => {
        const Ctor = audioContextCtor();
        if (!Ctor) throw new Error("no WebAudio");
        return new Ctor();
      }),
  );
  const [supported, setSupported] = useState(true);
  const [settings, setSettings] = useState<SoundSettings>({ enabled: false, volume: 0.5, bedOnly: false });
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useSoundMuted();
  /** On, and not muted site-wide. */
  const audible = settings.enabled && !muted;

  // Read settings once we know whether this is kiosk/TV (its default differs).
  useEffect(() => {
    setSupported(audioContextCtor() !== null);
    setSettings(readSoundSettings((k) => window.localStorage.getItem(k), { kiosk }));
    setLoaded(true);
  }, [kiosk]);

  useEffect(() => {
    scape.setPreset(resolveSoundPreset(sound));
  }, [scape, sound]);

  useEffect(() => {
    scape.setVolume(settings.volume);
    scape.setBedOnly(settings.bedOnly);
  }, [scape, settings.volume, settings.bedOnly]);

  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const begin = useCallback(() => {
    // Nothing starts while muted site-wide, not even from a tap.
    if (mutedRef.current || !audioContextCtor()) return;
    const started = scape.start();
    const ctx = scape.engine.context;
    if (ctx) ctx.onstatechange = () => setPlaying(scape.engine.running);
    started.then((ok) => setPlaying(ok)).catch(() => setPlaying(false));
  }, [scape]);

  // On: start at the first gesture (a menu click already is one). Off or muted: fade out.
  useEffect(() => {
    if (!loaded || !supported) return;
    if (!audible) {
      if (scape.engine.context) void scape.stop();
      setPlaying(false);
      return;
    }
    // Without a gesture yet, creating a context only earns a console warning; wait for one.
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (nav.userActivation?.hasBeenActive ?? true) begin();
    const onGesture = () => {
      if (!scape.engine.running) begin();
    };
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [loaded, supported, audible, scape, begin]);

  // A hidden tab goes quiet; coming back picks up where it was.
  useEffect(() => {
    if (!audible) return;
    const onVis = () => {
      const ctx = scape.engine.context;
      if (!ctx) return;
      if (document.hidden) void ctx.suspend().catch(() => {});
      else void ctx.resume().then(() => setPlaying(scape.engine.running)).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [audible, scape]);

  useEffect(() => () => void scape.engine.close(), [scape]);

  const setEnabled = useCallback((on: boolean) => {
    store(SOUND_KEY, on ? "1" : "0");
    setSettings((s) => ({ ...s, enabled: on }));
  }, []);
  const setVolume = useCallback((v: number) => {
    store(SOUND_VOLUME_KEY, String(v));
    setSettings((s) => ({ ...s, volume: v }));
  }, []);
  const setBedOnly = useCallback((on: boolean) => {
    store(SOUND_BED_ONLY_KEY, on ? "1" : "0");
    setSettings((s) => ({ ...s, bedOnly: on }));
  }, []);

  return {
    scape,
    enabled: settings.enabled,
    volume: settings.volume,
    bedOnly: settings.bedOnly,
    muted,
    setMuted,
    playing,
    needsGesture: loaded && supported && audible && !playing,
    supported,
    setEnabled,
    setVolume,
    setBedOnly,
    begin,
  };
}
