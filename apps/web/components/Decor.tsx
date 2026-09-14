"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DECOR_LABEL, readStoredDecor, type DecorItem, type DecorPreset } from "@grove/protocol";
import { api } from "@/lib/api";
import { decorGrid, placeDecor, sameDecor } from "@/lib/decor";
import { readThemeChoice, type ThemeId } from "@/lib/themes";
import { useTheme } from "@/lib/themes/useTheme";
import { ErrorNotice } from "@/components/ErrorNotice";
import { SECTION_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

type WireEntry = { preset: DecorPreset; label: string; unlocked: boolean; unlock: string; hint: string | null };
type WireDecor = { items: DecorItem[]; catalogue: WireEntry[]; max_items: number; slot_count: number; hidden_while_private: boolean };

/**
 * Manage → Decor (#45). Small props round the plot's building on the map,
 * unlocked by real work: three for every plot, two more for each mark the
 * space earns. Locked presets say what earns them; nothing is for sale and
 * nothing is counted. Pick a spot on the plot, then a preset.
 */
export function DecorPanel({ worldId, ownerDefault = null }: { worldId: string; ownerDefault?: string | null }) {
  const [wire, setWire] = useState<WireDecor | null>(null);
  const [draft, setDraft] = useState<DecorItem[]>([]);
  const [slot, setSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [themeId, setThemeId] = useState<ThemeId>("aoe");
  const grid = useMemo(() => decorGrid(), []);

  useEffect(() => {
    // #59: the space page is "viewing" this space, so its owner default is step 3.
    setThemeId(readThemeChoice(ownerDefault));
    api<{ decor: WireDecor }>(`/api/v1/worlds/${worldId}/decor`)
      .then((r) => {
        setWire(r.decor);
        setDraft(readStoredDecor(r.decor.items));
      })
      .catch((e: unknown) => setErr(e));
  }, [worldId, ownerDefault]);

  if (!wire) return <ErrorNotice error={err} size="xs" />;
  const stored = readStoredDecor(wire.items);
  const dirty = !sameDecor(draft, stored);
  const at = (s: number) => draft.find((d) => d.slot === s) ?? null;
  const unlocked = new Set(wire.catalogue.filter((e) => e.unlocked).map((e) => e.preset));

  function put(preset: DecorPreset | null) {
    if (slot === null) return;
    const r = placeDecor(draft, slot, preset, wire!.max_items);
    setSaved(false);
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    setErr(null);
    setDraft(r.items);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await api<{ decor: WireDecor }>(`/api/v1/worlds/${worldId}/decor`, {
        method: "PUT",
        body: JSON.stringify({ items: draft }),
      });
      setWire(r.decor);
      setDraft(readStoredDecor(r.decor.items));
      setSaved(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const current = slot === null ? null : at(slot);

  return (
    <section className={SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>Decor</h3>
      <p className="mt-1 text-xs text-muted">
        Small things round your building on the map. Every plot starts with three; each mark this space earns from real
        work unlocks two more. Up to {wire.max_items} items, on the marked spots, which never block the door. Nothing here
        is for sale.
      </p>
      {wire.hidden_while_private ? (
        <p className="mt-2 text-xs text-muted">This space is private, so the map shows none of it: held land stays plain.</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start gap-5">
        <div
          role="grid"
          aria-label="Your plot, north at the top"
          className="grid w-fit max-w-full gap-0.5 overflow-x-auto rounded-gh-md border border-line bg-surface-raised p-1.5"
          style={{ gridTemplateColumns: "repeat(8, 2.25rem)" }}
        >
          {grid.flatMap((row, y) =>
            row.map((cell, x) => {
              const key = `${x},${y}`;
              if (cell.kind === "building")
                return <div key={key} className="h-9 rounded-gh-sm bg-line-strong/40" aria-hidden title="Building" />;
              if (cell.kind === "door")
                return (
                  <div key={key} className="flex h-9 items-center justify-center rounded-sm bg-tint text-[9px] text-muted" title="Door (kept clear)">
                    door
                  </div>
                );
              if (cell.kind === "ground") return <div key={key} className="h-9 rounded-gh-sm bg-tint" aria-hidden />;
              const item = at(cell.slot);
              const selected = slot === cell.slot;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSlot(selected ? null : cell.slot)}
                  aria-pressed={selected}
                  aria-label={item ? `Spot ${cell.slot + 1}: ${DECOR_LABEL[item.preset]}` : `Spot ${cell.slot + 1}: empty`}
                  className={`flex h-9 items-center justify-center rounded-gh-sm border focus-visible:outline-none focus-visible:shadow-gh-ring ${
                    selected ? "border-signal bg-tint" : "border-dashed border-line-strong bg-transparent hover:bg-tint"
                  }`}
                >
                  {item ? <DecorThumb preset={item.preset} themeId={themeId} size={34} /> : <span className="text-xs text-muted">+</span>}
                </button>
              );
            }),
          )}
        </div>

        <div className="min-w-0 flex-1 basis-60">
          {slot === null ? (
            <p className="text-xs text-muted">Pick a dashed spot on the plot to place something there.</p>
          ) : (
            <>
              <p className="text-xs font-medium text-ink">
                Spot {slot + 1}
                {current ? `: ${DECOR_LABEL[current.preset]}` : ""}
              </p>
              <ul className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {wire.catalogue.map((e) => (
                  <li key={e.preset}>
                    <button
                      type="button"
                      disabled={!e.unlocked}
                      onClick={() => put(e.preset)}
                      className={`flex min-h-11 w-full items-center gap-2 rounded-gh-md border px-2 py-1 text-left text-xs focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-0 ${
                        current?.preset === e.preset
                          ? "border-signal bg-tint text-ink"
                          : e.unlocked
                            ? "border-line-strong bg-surface-raised text-ink hover:bg-tint"
                            : "border-line bg-surface text-muted"
                      } disabled:cursor-not-allowed`}
                    >
                      <span className={e.unlocked ? "" : "opacity-40 grayscale"}>
                        <DecorThumb preset={e.preset} themeId={themeId} size={28} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate">{e.label}</span>
                        {e.hint ? <span className="block truncate text-[10px] text-muted">{e.hint}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {current ? (
                <button type="button" onClick={() => put(null)} className="mt-2 min-h-11 rounded-gh-sm text-xs text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink sm:min-h-0">
                  Clear this spot
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty || draft.some((d) => !unlocked.has(d.preset))}
          className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}
        >
          {busy ? "Saving…" : "Save decor"}
        </button>
        {saved ? <span className="text-xs text-success" role="status">Saved.</span> : null}
        {draft.some((d) => !unlocked.has(d.preset)) ? (
          <span className="text-xs text-muted">Some placed decor is no longer unlocked; clear it to save.</span>
        ) : null}
        <ErrorNotice error={err} inline />
      </div>
    </section>
  );
}

/** A preset drawn through the viewer's theme's own `decor` slot: the map's art, not a picture of it. */
function DecorThumb({ preset, themeId, size }: { preset: DecorPreset; themeId: ThemeId; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Loaded on demand (#79): draws once the viewer's theme is here, never another theme's art in its place.
  const theme = useTheme(themeId);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || theme.id !== themeId) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    // The sprite spans ~72 x 100 layout px round its anchor; fit it in the box.
    const k = (size * dpr) / 84;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(k, 0, 0, k, (size * dpr) / 2, size * dpr * 0.62);
    theme.art.decor(ctx, preset, 0, 0);
  }, [preset, theme, themeId, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden />;
}
