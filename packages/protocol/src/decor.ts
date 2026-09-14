/**
 * Plot decor (queue #45, migration 044): small cosmetic props an owner places
 * round their plot's building, unlocked by real work.
 *
 * The rules, pure, so the Manage preview, the server and the map agree:
 *
 *  - Every claimed plot gets the BASE presets.
 *  - Each achievement mark the space holds (030/040) unlocks two more.
 *  - An active supporter (#47, `perks.extra_decor`) unlocks two extra presets.
 *    Cosmetic only: decor never gates access, speech, plots or visibility, and
 *    nothing is for sale here. There is no currency, no counter, no ranking.
 *  - At most DECOR_MAX_ITEMS items, one per slot, on PLOT_DECOR_SLOTS
 *    (map-layout.ts), which never block the building's door or a resting body.
 *  - A private plot publishes no decor at all: held land shows nothing.
 *
 * Stored as JSONB `worlds.decor`: `[{ preset, slot }]`. Readers re-check shape
 * AND unlocks, so a lapsed supporter's extra presets simply stop drawing.
 */
import { PLOT_DECOR_SLOTS } from "./map-layout.js";
import { normaliseMarks, type SpaceMark } from "./marks.js";

export const DECOR_PRESETS = [
  "bench",
  "planter",
  "lamps",
  "desk",
  "bookshelf",
  "notice_board",
  "crates",
  "banner",
  "telescope",
  "fountain",
  "garden",
] as const;
export type DecorPreset = (typeof DECOR_PRESETS)[number];

/** How a preset is unlocked. */
export type DecorUnlock = { kind: "base" } | { kind: "mark"; mark: SpaceMark } | { kind: "supporter" };

export const DECOR_UNLOCK: Record<DecorPreset, DecorUnlock> = {
  bench: { kind: "base" },
  planter: { kind: "base" },
  lamps: { kind: "base" },
  desk: { kind: "mark", mark: "thousand_calls" },
  bookshelf: { kind: "mark", mark: "thousand_calls" },
  notice_board: { kind: "mark", mark: "week_streak" },
  crates: { kind: "mark", mark: "week_streak" },
  banner: { kind: "mark", mark: "trial" },
  telescope: { kind: "mark", mark: "trial" },
  fountain: { kind: "supporter" },
  garden: { kind: "supporter" },
};

/** Neutral page words (pages never use a theme's vocabulary). */
export const DECOR_LABEL: Record<DecorPreset, string> = {
  bench: "Bench",
  planter: "Planter",
  lamps: "Lamp pair",
  desk: "Desk",
  bookshelf: "Bookshelf",
  notice_board: "Notice board",
  crates: "Crates",
  banner: "Banner post",
  telescope: "Telescope",
  fountain: "Fountain",
  garden: "Garden patch",
};

/** What earns a mark, in plain words, for "earned by …" on a locked preset. */
export const DECOR_MARK_LABEL: Record<SpaceMark, string> = {
  thousand_calls: "1,000 tool calls",
  week_streak: "7 days in a row",
  trial: "finishing a trial",
};

export const DECOR_MAX_ITEMS = 6;
export const DECOR_SLOT_COUNT = PLOT_DECOR_SLOTS.length;

export interface DecorItem {
  preset: DecorPreset;
  slot: number;
}

export interface DecorUnlockInput {
  marks: readonly unknown[] | null | undefined;
  /** The plot owner is an active supporter AND supporters are switched on. */
  supporter: boolean;
}

export function isDecorPreset(v: unknown): v is DecorPreset {
  return typeof v === "string" && (DECOR_PRESETS as readonly string[]).includes(v);
}

/** Which presets this plot may use, in catalogue order. */
export function unlockedDecor(input: DecorUnlockInput): DecorPreset[] {
  const marks = new Set(normaliseMarks(input.marks));
  return DECOR_PRESETS.filter((p) => {
    const u = DECOR_UNLOCK[p];
    if (u.kind === "base") return true;
    if (u.kind === "mark") return marks.has(u.mark);
    return input.supporter;
  });
}

/** Shape check only: known presets, integer slots in range, one item per slot, at most DECOR_MAX_ITEMS. Never throws. */
export function readStoredDecor(raw: unknown): DecorItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DecorItem[] = [];
  const used = new Set<number>();
  for (const it of raw) {
    if (out.length >= DECOR_MAX_ITEMS) break;
    const o = it as { preset?: unknown; slot?: unknown } | null;
    if (!o || typeof o !== "object" || !isDecorPreset(o.preset)) continue;
    const slot = o.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= DECOR_SLOT_COUNT) continue;
    if (used.has(slot)) continue;
    used.add(slot);
    out.push({ preset: o.preset, slot });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/**
 * What the public map draws for a plot: nothing for a private plot, otherwise
 * the stored items that still pass shape AND the plot's current unlocks.
 */
export function publishedDecor(preset: string | null | undefined, raw: unknown, unlocks: DecorUnlockInput): DecorItem[] {
  if (preset === "private") return [];
  const ok = new Set(unlockedDecor(unlocks));
  return readStoredDecor(raw).filter((d) => ok.has(d.preset));
}

export type DecorCheck = { ok: true; items: DecorItem[] } | { ok: false; message: string };

/**
 * Validate an owner's placement strictly (the write path): every item must be
 * well-formed, on a real slot, not doubled up, and unlocked for this plot.
 */
export function validateDecor(raw: unknown, unlocks: DecorUnlockInput): DecorCheck {
  if (raw === null || raw === undefined) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "Decor must be a list of { preset, slot }." };
  if (raw.length > DECOR_MAX_ITEMS) return { ok: false, message: `Place at most ${DECOR_MAX_ITEMS} decor items.` };
  const ok = new Set(unlockedDecor(unlocks));
  const used = new Set<number>();
  const items: DecorItem[] = [];
  for (const it of raw) {
    const o = it as { preset?: unknown; slot?: unknown } | null;
    if (!o || typeof o !== "object") return { ok: false, message: "Decor must be a list of { preset, slot }." };
    if (!isDecorPreset(o.preset)) return { ok: false, message: "That is not a decor preset." };
    const slot = o.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= DECOR_SLOT_COUNT) {
      return { ok: false, message: "That is not a decor spot on this plot." };
    }
    if (used.has(slot)) return { ok: false, message: "Only one item fits on each spot." };
    if (!ok.has(o.preset)) return { ok: false, message: `${DECOR_LABEL[o.preset]} is not unlocked on this plot yet.` };
    used.add(slot);
    items.push({ preset: o.preset, slot });
  }
  return { ok: true, items: items.sort((a, b) => a.slot - b.slot) };
}

/** A preset as the Manage picker shows it: unlocked, or what earns it. */
export interface DecorCatalogueEntry {
  preset: DecorPreset;
  label: string;
  unlocked: boolean;
  /** "base", a mark key, or "supporter". */
  unlock: DecorUnlock["kind"] | SpaceMark;
  /** For a locked preset: "earned by 7 days in a row" / "supporter decor". Null when unlocked. */
  hint: string | null;
}

/**
 * The picker's catalogue. Supporter presets are listed only while supporters
 * are switched on (`supportersEnabled`), and never with a price or a prompt to buy.
 */
export function decorCatalogue(unlocks: DecorUnlockInput, supportersEnabled: boolean): DecorCatalogueEntry[] {
  const ok = new Set(unlockedDecor(unlocks));
  const out: DecorCatalogueEntry[] = [];
  for (const p of DECOR_PRESETS) {
    const u = DECOR_UNLOCK[p];
    if (u.kind === "supporter" && !supportersEnabled && !ok.has(p)) continue;
    const unlocked = ok.has(p);
    out.push({
      preset: p,
      label: DECOR_LABEL[p],
      unlocked,
      unlock: u.kind === "mark" ? u.mark : u.kind,
      hint: unlocked ? null : u.kind === "mark" ? `earned by ${DECOR_MARK_LABEL[u.mark]}` : "supporter decor",
    });
  }
  return out;
}
