/**
 * One mute for all sound (#56). A single site-wide flag, kept in this browser,
 * that silences everything the page can make audible: the map soundscape (#43)
 * and read aloud in the room drawer (#44). Either engine may set it; both obey.
 *
 * - Stored under `grove-sound-muted` ("1" muted, "0" or absent not muted).
 * - Same tab: a `grove:sound-muted` event on window (localStorage writes do not
 *   fire `storage` in the tab that made them).
 * - Other tabs: the browser's own `storage` event.
 * - Blocked storage (private windows): the choice lives in memory for the visit.
 *
 * The environment is injectable so the whole thing is testable without a DOM.
 */

export const SOUND_MUTED_KEY = "grove-sound-muted";
export const SOUND_MUTED_EVENT = "grove:sound-muted";

export type MuteStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export type MuteTarget = {
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  dispatchEvent(ev: Event): boolean;
};
export type MuteEnv = { storage: MuteStorage | null; target: MuteTarget | null };

/** Used only when storage is unavailable or throws. */
let memoryMuted: boolean | null = null;

export function parseMuted(v: string | null | undefined): boolean {
  return v === "1" || v === "true";
}

function browserEnv(): MuteEnv {
  if (typeof window === "undefined") return { storage: null, target: null };
  let storage: MuteStorage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return { storage, target: window };
}

export function isSoundMuted(env: MuteEnv = browserEnv()): boolean {
  try {
    const v = env.storage?.getItem(SOUND_MUTED_KEY);
    if (v !== null && v !== undefined) return parseMuted(v);
  } catch {
    /* fall through to memory */
  }
  return memoryMuted ?? false;
}

export function setSoundMuted(muted: boolean, env: MuteEnv = browserEnv()): void {
  memoryMuted = muted;
  try {
    env.storage?.setItem(SOUND_MUTED_KEY, muted ? "1" : "0");
  } catch {
    /* the in-memory value carries this visit */
  }
  if (!env.target) return;
  const ev =
    typeof CustomEvent === "function"
      ? new CustomEvent(SOUND_MUTED_EVENT, { detail: { muted } })
      : Object.assign(new Event(SOUND_MUTED_EVENT), { detail: { muted } });
  try {
    env.target.dispatchEvent(ev);
  } catch {
    /* no listeners is fine */
  }
}

/** Calls `fn(muted)` whenever the mute changes, in this tab or another. Returns an unsubscribe. */
export function subscribeSoundMuted(fn: (muted: boolean) => void, env: MuteEnv = browserEnv()): () => void {
  const target = env.target;
  if (!target) return () => {};
  const onLocal = (ev: Event) => {
    const d = (ev as Event & { detail?: { muted?: unknown } }).detail;
    fn(typeof d?.muted === "boolean" ? d.muted : isSoundMuted(env));
  };
  const onStorage = (ev: Event) => {
    const key = (ev as Event & { key?: string | null }).key;
    // key null = storage was cleared.
    if (key !== SOUND_MUTED_KEY && key !== null) return;
    const nv = (ev as Event & { newValue?: string | null }).newValue;
    fn(parseMuted(nv ?? null));
  };
  target.addEventListener(SOUND_MUTED_EVENT, onLocal);
  target.addEventListener("storage", onStorage);
  return () => {
    target.removeEventListener(SOUND_MUTED_EVENT, onLocal);
    target.removeEventListener("storage", onStorage);
  };
}

/** Tests only. */
export function resetMemoryMute(): void {
  memoryMuted = null;
}
