"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_EMBLEMS, BRAND_EMBLEM_LABEL, BRAND_PALETTE, type SpaceBranding } from "@grove/protocol";
import { api } from "@/lib/api";
import {
  SIGN_TEXT_MAX,
  applySuggestion,
  brandingDraft,
  checkDraft,
  draftToBody,
  paletteKeyOf,
  previewPlot,
  suggestionColourLine,
  type BrandingDraft,
  type BrandingSuggestion,
} from "@/lib/branding";
import { layoutSignboard, signContent } from "@/lib/signboard";
import { THEMES, THEME_IDS } from "@/lib/themes";
import { drawBrandEmblem } from "@/lib/themes/kit";

export type WireBranding = { accent: string | null; sign_text: string | null; emblem: string | null } | null;

/**
 * Manage → Branding (035). Accent colour, sign text and an emblem from the
 * built-in set, with a live preview of the plot's sign in all four themes. The
 * preview draws through each theme's own `signboard` slot, so it is the map's
 * sign, not a picture of one.
 */
export function BrandingPanel({
  worldId,
  space,
  orgs,
  branding,
  reload,
}: {
  worldId: string;
  space: { name: string; policy_preset: string };
  orgs: ReadonlyArray<{ name: string; colour: string }>;
  branding: WireBranding;
  reload: () => Promise<void>;
}) {
  const [d, setD] = useState<BrandingDraft>(() => brandingDraft(branding));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<BrandingSuggestion | null>(null);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);
  useEffect(() => setD(brandingDraft(branding)), [branding]);
  const check = useMemo(() => checkDraft(d), [d]);
  // While a website suggestion is waiting, the preview shows it laid over the draft.
  const previewCheck = useMemo(() => checkDraft(applySuggestion(d, suggestion)), [d, suggestion]);
  const invalid = Boolean(check.accentError || check.signTextError);
  const swatch = paletteKeyOf(d.accent);

  function edit(next: Partial<BrandingDraft>) {
    setSaved(false);
    setD((cur) => ({ ...cur, ...next }));
  }

  async function suggest() {
    if (!siteUrl.trim()) return;
    setSuggesting(true);
    setSuggestErr(null);
    setSuggestion(null);
    try {
      const r = await api<BrandingSuggestion>(`/api/v1/spaces/${worldId}/branding/suggest`, {
        method: "POST",
        body: JSON.stringify({ url: siteUrl.trim() }),
      });
      if (!r.name && !r.accent) setSuggestErr(r.notes.join(" ") || "Nothing on that website could be used.");
      else setSuggestion(r);
    } catch (e) {
      setSuggestErr((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  function applyWebsite() {
    edit(applySuggestion(d, suggestion));
    setSuggestion(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/v1/worlds/${worldId}/branding`, { method: "PUT", body: JSON.stringify(draftToBody(d)) });
      await reload();
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="font-display text-xl text-lantern-300">Branding</h3>
      <p className="mt-1 text-xs text-white/40">
        A colour, a short line and an emblem for this space&apos;s sign and fence on the map, in every theme.
      </p>

      <div className="mt-4 space-y-5">
        <div className="rounded-lg border border-white/10 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void suggest();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="block min-w-0 flex-1 text-xs text-white/50">
              Use my website
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://example.com"
                inputMode="url"
                autoComplete="url"
                maxLength={2048}
                className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm text-white/85"
              />
            </label>
            <button
              type="submit"
              disabled={suggesting || !siteUrl.trim()}
              className="rounded-full border border-lantern-400/50 px-4 py-2 text-sm text-lantern-200 disabled:opacity-50"
            >
              {suggesting ? "Reading…" : "Suggest"}
            </button>
          </form>
          <p className="mt-1 text-[11px] text-white/35">
            Glasshouse reads only the site&apos;s name, theme colour and icon colour. Nothing is saved until you apply and save.
          </p>
          {suggestErr ? <p className="mt-2 text-xs text-red-300">{suggestErr}</p> : null}
          {suggestion ? (
            <div className="mt-3 space-y-1 text-xs text-white/70" aria-live="polite">
              <p className="text-white/50">From {suggestion.source.url}</p>
              {suggestion.name ? <p>Sign text: {suggestion.name}</p> : null}
              {suggestion.accent ? (
                <p className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full border border-white/20" style={{ background: suggestion.accent.accent }} aria-hidden />
                  {suggestionColourLine(suggestion)}
                </p>
              ) : null}
              {suggestion.notes.map((n) => (
                <p key={n} className="text-white/45">
                  {n}
                </p>
              ))}
              <p className="text-white/45">The preview below shows the suggestion.</p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={applyWebsite}
                  className="rounded-full bg-lantern-400 px-3 py-1 text-xs font-medium text-dusk-950"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => setSuggestion(null)}
                  className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/60"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div>
          <p className="text-xs text-white/50">Accent colour</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => edit({ accent: "" })}
              aria-pressed={!d.accent.trim()}
              className={`h-7 rounded-full border px-3 text-xs ${!d.accent.trim() ? "border-lantern-400/60 text-lantern-200" : "border-white/15 text-white/60"}`}
            >
              None
            </button>
            {BRAND_PALETTE.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.label}
                aria-label={p.label}
                aria-pressed={swatch === p.key}
                onClick={() => edit({ accent: p.hex })}
                className={`h-7 w-7 rounded-full border-2 ${swatch === p.key ? "border-white" : "border-white/10"}`}
                style={{ background: p.hex }}
              />
            ))}
            <label className="flex items-center gap-2 text-xs text-white/50">
              <span className="sr-only">Custom colour</span>
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(d.accent.trim()) ? d.accent.trim() : "#7dd3fc"}
                onChange={(e) => edit({ accent: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-white/10 bg-transparent"
              />
              <input
                value={d.accent}
                onChange={(e) => edit({ accent: e.target.value })}
                placeholder="#rrggbb"
                maxLength={7}
                aria-label="Accent hex"
                className="w-24 rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1 font-mono text-xs text-white/85"
              />
            </label>
          </div>
          {check.accentError ? <p className="mt-1 text-xs text-red-300">{check.accentError}</p> : null}
        </div>

        <label className="block text-xs text-white/50">
          Sign text
          <input
            value={d.signText}
            onChange={(e) => edit({ signText: e.target.value })}
            placeholder="Open late on Fridays"
            className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm text-white/85"
          />
          <span className={`mt-1 block ${check.signTextCount > SIGN_TEXT_MAX ? "text-red-300" : "text-white/35"}`}>
            {check.signTextError ?? `${check.signTextCount}/${SIGN_TEXT_MAX}`}
          </span>
        </label>

        <div>
          <p className="text-xs text-white/50">Emblem</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => edit({ emblem: null })}
              aria-pressed={d.emblem === null}
              className={`h-9 rounded-lg border px-3 text-xs ${d.emblem === null ? "border-lantern-400/60 text-lantern-200" : "border-white/10 text-white/60"}`}
            >
              None
            </button>
            {BRAND_EMBLEMS.map((key) => (
              <button
                key={key}
                type="button"
                title={BRAND_EMBLEM_LABEL[key]}
                aria-label={BRAND_EMBLEM_LABEL[key]}
                aria-pressed={d.emblem === key}
                onClick={() => edit({ emblem: key })}
                className={`grid h-9 w-9 place-items-center rounded-lg border ${d.emblem === key ? "border-lantern-400/60 bg-lantern-400/10" : "border-white/10"}`}
              >
                <EmblemIcon emblem={key} colour={check.valid.accent ?? "#f4d19a"} />
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-white/50">{suggestion ? "Preview of the website suggestion" : "Preview"}</p>
          {space.policy_preset === "private" ? (
            <p className="mt-1 text-xs text-white/40">
              This space is Private, so the map shows a held sign with none of this on it. This is how it will look once it is Watch only or Open.
            </p>
          ) : null}
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {THEME_IDS.map((id) => (
              <SignPreview key={id} themeId={id} plot={previewPlot(space, orgs, previewCheck.valid)} />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || invalid}
            className="rounded-full bg-lantern-400 px-4 py-1.5 text-sm font-medium text-dusk-950 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save branding"}
          </button>
          {saved ? <span className="text-xs text-white/50">Saved. The map picks it up on its next refresh.</span> : null}
        </div>
        {err ? <p className="text-sm text-red-300">{err}</p> : null}
      </div>
    </section>
  );
}

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

function EmblemIcon({ emblem, colour }: { emblem: (typeof BRAND_EMBLEMS)[number]; colour: string }) {
  const ref = useCanvas((ctx) => drawBrandEmblem(ctx, emblem, 10, 10, 16, colour), 20, 20, [emblem, colour]);
  return <canvas ref={ref} style={{ width: 20, height: 20 }} aria-hidden />;
}

export function SignPreview({ themeId, plot }: { themeId: (typeof THEME_IDS)[number]; plot: ReturnType<typeof previewPlot> }) {
  const theme = THEMES[themeId];
  const W = 220;
  const H = 84;
  const ref = useCanvas(
    (ctx, w, h) => {
      // The theme's own ground colour behind the sign, plus a hint of its plot tint.
      ctx.fillStyle = theme.palette.fog;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = theme.palette.plotTint[plot.preset as "public_view" | "public_write"] ?? theme.palette.plotTint.public_write;
      ctx.fillRect(0, 0, w, h);
      const family = theme.art.speechFont ?? "ui-sans-serif, system-ui, sans-serif";
      const measure = (text: string, px: number) => {
        ctx.font = `${px >= 11 ? "600 " : ""}${px}px ${family}`;
        return ctx.measureText(text).width;
      };
      // Zoom 1: the size a sign is read at on the map, org line included.
      const board = layoutSignboard(signContent(plot, theme.lexicon), { x: w / 2, y: h / 2 }, 1, measure);
      if (board) theme.art.signboard(ctx, board, 0);
    },
    W,
    H,
    [themeId, JSON.stringify(plot)],
  );
  return (
    <figure className="overflow-hidden rounded-lg border border-white/10">
      <canvas ref={ref} style={{ width: W, maxWidth: "100%", height: "auto", display: "block", margin: "0 auto" }} aria-label={`${theme.lexicon.name} sign preview`} />
      <figcaption className="border-t border-white/10 px-2 py-1 text-[11px] text-white/45">{theme.lexicon.name}</figcaption>
    </figure>
  );
}

export type { SpaceBranding };
