"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_EMBLEMS, BRAND_EMBLEM_LABEL, BRAND_PALETTE, type BrandEmblem } from "@grove/protocol";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { ACCESS_ORDER, accessCopy, type SpacePolicyPreset } from "@/lib/access";
import {
  SIGN_TEXT_MAX,
  applySuggestion,
  checkDraft,
  draftToBody,
  paletteKeyOf,
  suggestionColourLine,
  type BrandingDraft,
  type BrandingSuggestion,
} from "@/lib/branding";
import {
  createOutcome,
  defaultViewAs,
  plotCaption,
  plotCentre,
  previewForPlot,
  type CreateOutcome,
  type DraftSpace,
  type ViewAs,
  type WireClaimPreview,
  type WireCreated,
} from "@/lib/claim-preview";
import { spaceHref, suggestSlug } from "@/lib/space-page";
import { drawBrandEmblem } from "@/lib/themes/kit";
import { ClaimPreview } from "@/components/ClaimPreview";

/**
 * Create space (queue #26), as two steps (queue #48):
 *
 *   1. Details: name, slug, access, and optional branding (accent, sign text,
 *      emblem, "Use my website").
 *   2. Preview: the plot the space would get RIGHT NOW on a small read-only
 *      map, with its building, sign and neighbours, in any theme. Nothing is
 *      reserved and nothing is written until Confirm; the create request sends
 *      what was previewed and the server checks it all again.
 */
export function CreateSpaceFlow({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<"details" | "preview" | "moved">("details");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [preset, setPreset] = useState<SpacePolicyPreset>("public_write");
  const [brand, setBrand] = useState<BrandingDraft>({ accent: "", signText: "", emblem: null });
  const [siteUrl, setSiteUrl] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<BrandingSuggestion | null>(null);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<WireClaimPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [viewAs, setViewAs] = useState<ViewAs>("owner");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [moved, setMoved] = useState<Extract<CreateOutcome, { kind: "moved" }> | null>(null);
  const topRef = useRef<HTMLElement>(null);

  const check = useMemo(() => checkDraft(brand), [brand]);
  const brandInvalid = Boolean(check.accentError || check.signTextError);
  const finalSlug = slug || suggestSlug(name);
  const detailsOk = Boolean(name.trim()) && finalSlug.length >= 2 && !brandInvalid;
  const hasBranding = Boolean(brand.accent.trim() || brand.signText.trim() || brand.emblem);
  const draft: DraftSpace = useMemo(
    () => ({ name: name.trim(), preset, branding: hasBranding ? check.valid : null }),
    [name, preset, hasBranding, check.valid],
  );

  function scrollTop() {
    topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function loadPreview() {
    setLoadingPreview(true);
    setPreviewErr(null);
    try {
      const r = await api<{ preview: WireClaimPreview }>("/api/v1/spaces/claim-preview");
      setPreview(r.preview);
    } catch (e) {
      setPreviewErr((e as Error).message);
    } finally {
      setLoadingPreview(false);
    }
  }

  function toPreview() {
    if (!detailsOk) return;
    setErr(null);
    setViewAs(defaultViewAs(preset));
    setStep("preview");
    void loadPreview();
    scrollTop();
  }

  async function suggest() {
    if (!siteUrl.trim()) return;
    setSuggesting(true);
    setSuggestErr(null);
    setSuggestion(null);
    try {
      const r = await api<BrandingSuggestion>("/api/v1/spaces/branding/suggest", {
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

  async function confirm() {
    if (!preview) return;
    setErr(null);
    setBusy(true);
    try {
      const created = await api<WireCreated>("/api/v1/worlds", {
        method: "POST",
        body: JSON.stringify({
          name,
          slug: finalSlug,
          policy_preset: preset,
          ...(hasBranding ? { branding: draftToBody(brand) } : {}),
          expected_plot_index: preview.plot_index,
        }),
      });
      const outcome = createOutcome(created);
      if (outcome.kind === "as_previewed") {
        window.location.href = gp(spaceHref(outcome.slug));
        return;
      }
      // Someone claimed the previewed plot first: say so and show the real one.
      setMoved(outcome);
      try {
        const map = await api<{ spaces?: Array<Record<string, unknown>> }>("/api/v1/world/minimap");
        setPreview(previewForPlot(outcome.to, (map.spaces ?? []) as Parameters<typeof previewForPlot>[1]));
      } catch {
        setPreview({ plot_index: outcome.to, ring: previewForPlot(outcome.to, []).ring, neighbours: [] });
      }
      setStep("moved");
      setBusy(false);
      scrollTop();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(code === "SLUG_TAKEN" ? `${(e as Error).message} Go back and pick another slug.` : (e as Error).message);
      setBusy(false);
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-2xl text-lantern-300">Create a space</h2>
        <p className="mt-1 text-sm text-white/50">
          {step === "details"
            ? "Step 1 of 2: details. You get the next free plot on the shared world, and it stays yours. Six rooms come with it."
            : step === "preview"
              ? "Step 2 of 2: preview. Nothing is claimed until you confirm."
              : "Your space is claimed."}
        </p>
      </div>
      <button type="button" onClick={onClose} className="shrink-0 text-xs text-white/40 hover:text-white/70">
        Close
      </button>
    </div>
  );

  if (step === "moved" && moved && preview) {
    const at = plotCentre(moved.to);
    return (
      <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
        {header}
        <p className="rounded-lg border border-amber-300/30 bg-amber-300/5 p-3 text-sm text-amber-100" role="status">
          {moved.message}
        </p>
        <ClaimPreview preview={preview} draft={draft} viewAs={viewAs} onViewAs={setViewAs} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <a
            href={gp(spaceHref(moved.slug))}
            className="rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
          >
            Go to your space
          </a>
          <a
            href={gp(`/?at=${at.tx},${at.ty}`)}
            className="rounded-full border border-white/15 px-4 py-3 text-center text-sm text-white/70 sm:py-2"
          >
            See it on the map
          </a>
        </div>
      </section>
    );
  }

  if (step === "preview") {
    const copy = accessCopy(preset);
    return (
      <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
        {header}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-white/10 p-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-white/45">Name</dt>
          <dd className="min-w-0 break-words">{name.trim()}</dd>
          <dt className="text-white/45">Page</dt>
          <dd className="min-w-0 break-all font-mono text-xs leading-5">/s/{finalSlug}</dd>
          <dt className="text-white/45">Access</dt>
          <dd>
            <strong>{copy.word}</strong> <span className="text-white/50">· {copy.line}</span>
          </dd>
          <dt className="text-white/45">Branding</dt>
          <dd className="text-white/70">
            {hasBranding
              ? [check.valid.accent ? "colour" : null, check.valid.signText ? `"${check.valid.signText}"` : null, check.valid.emblem ? BRAND_EMBLEM_LABEL[check.valid.emblem].toLowerCase() : null]
                  .filter(Boolean)
                  .join(" · ")
              : "none"}
          </dd>
        </dl>

        {preview ? (
          <>
            <ClaimPreview preview={preview} draft={draft} viewAs={viewAs} onViewAs={setViewAs} />
            <p className="text-xs text-white/40">
              Nothing is reserved: {plotCaption(preview.plot_index, preview.ring).toLowerCase()} is the next free plot right now. Your plot
              may shift if someone claims first.{" "}
              <button type="button" onClick={() => void loadPreview()} disabled={loadingPreview} className="underline hover:text-white/70">
                {loadingPreview ? "Checking…" : "Check again"}
              </button>
            </p>
          </>
        ) : loadingPreview ? (
          <p className="text-sm text-white/40">Finding your plot…</p>
        ) : null}
        {previewErr ? <p className="text-sm text-red-300">{previewErr}</p> : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => {
              setStep("details");
              scrollTop();
            }}
            className="rounded-full border border-white/15 px-4 py-3 text-sm text-white/70 sm:py-2"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || !preview}
            className="rounded-full bg-lantern-400 px-5 py-3 font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
          >
            {busy ? "Claiming…" : "Confirm and create"}
          </button>
        </div>
        {err ? <p className="text-sm text-red-300">{err}</p> : null}
      </section>
    );
  }

  const swatch = paletteKeyOf(brand.accent);
  return (
    <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
      {header}

      <label className="block">
        <span className="text-sm text-white/70">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(suggestSlug(e.target.value));
          }}
          placeholder="Harbour workshop"
          className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 outline-none focus:border-lantern-400/50"
        />
      </label>

      <label className="block">
        <span className="text-sm text-white/70">Slug</span>
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          onBlur={() => setSlug(suggestSlug(slug))}
          placeholder="harbour-workshop"
          className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 font-mono text-sm outline-none focus:border-lantern-400/50"
        />
        <span className="mt-1 block break-all text-xs text-white/40">
          Lowercase and dashes. Its page will be <code>/s/{finalSlug || "your-slug"}</code>.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm text-white/70">Access</legend>
        {ACCESS_ORDER.map((p) => {
          const copy = accessCopy(p);
          return (
            <label
              key={p}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                preset === p ? "border-lantern-400/50 bg-lantern-400/5" : "border-white/10"
              }`}
            >
              <input
                type="radio"
                name="access"
                className="mt-1 h-4 w-4 shrink-0 accent-lantern-400"
                checked={preset === p}
                onChange={() => setPreset(p)}
              />
              <span>
                <strong>{copy.word}</strong>
                <span className="block text-sm text-white/50">{copy.line}</span>
              </span>
            </label>
          );
        })}
        <p className="text-xs text-white/35">You can change it later under Manage on the space&apos;s page.</p>
      </fieldset>

      <details className="rounded-lg border border-white/10 p-3" open={hasBranding || undefined}>
        <summary className="cursor-pointer text-sm text-white/70">Branding (optional)</summary>
        <div className="mt-3 space-y-4">
          <div>
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
              Glasshouse reads only the site&apos;s name, theme colour and icon colour. Nothing is saved.
            </p>
            {suggestErr ? <p className="mt-2 text-xs text-red-300">{suggestErr}</p> : null}
            {suggestion ? (
              <div className="mt-3 space-y-1 text-xs text-white/70" aria-live="polite">
                <p className="break-all text-white/50">From {suggestion.source.url}</p>
                {suggestion.name ? <p>Sign text: {suggestion.name}</p> : null}
                {suggestion.accent ? (
                  <p className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-white/20" style={{ background: suggestion.accent.accent }} aria-hidden />
                    {suggestionColourLine(suggestion)}
                  </p>
                ) : null}
                {suggestion.notes.map((n) => (
                  <p key={n} className="text-white/45">
                    {n}
                  </p>
                ))}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setBrand(applySuggestion(brand, suggestion));
                      setSuggestion(null);
                    }}
                    className="rounded-full bg-lantern-400 px-3 py-1.5 text-xs font-medium text-dusk-950"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setSuggestion(null)}
                    className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-white/60"
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
                onClick={() => setBrand({ ...brand, accent: "" })}
                aria-pressed={!brand.accent.trim()}
                className={`h-8 rounded-full border px-3 text-xs ${!brand.accent.trim() ? "border-lantern-400/60 text-lantern-200" : "border-white/15 text-white/60"}`}
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
                  onClick={() => setBrand({ ...brand, accent: p.hex })}
                  className={`h-8 w-8 rounded-full border-2 ${swatch === p.key ? "border-white" : "border-white/10"}`}
                  style={{ background: p.hex }}
                />
              ))}
              <input
                value={brand.accent}
                onChange={(e) => setBrand({ ...brand, accent: e.target.value })}
                placeholder="#rrggbb"
                maxLength={7}
                aria-label="Accent hex"
                className="w-24 rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1.5 font-mono text-xs text-white/85"
              />
            </div>
            {check.accentError ? <p className="mt-1 text-xs text-red-300">{check.accentError}</p> : null}
          </div>

          <label className="block text-xs text-white/50">
            Sign text
            <input
              value={brand.signText}
              onChange={(e) => setBrand({ ...brand, signText: e.target.value })}
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
                onClick={() => setBrand({ ...brand, emblem: null })}
                aria-pressed={brand.emblem === null}
                className={`h-9 rounded-lg border px-3 text-xs ${brand.emblem === null ? "border-lantern-400/60 text-lantern-200" : "border-white/10 text-white/60"}`}
              >
                None
              </button>
              {BRAND_EMBLEMS.map((key) => (
                <button
                  key={key}
                  type="button"
                  title={BRAND_EMBLEM_LABEL[key]}
                  aria-label={BRAND_EMBLEM_LABEL[key]}
                  aria-pressed={brand.emblem === key}
                  onClick={() => setBrand({ ...brand, emblem: key })}
                  className={`grid h-9 w-9 place-items-center rounded-lg border ${brand.emblem === key ? "border-lantern-400/60 bg-lantern-400/10" : "border-white/10"}`}
                >
                  <Emblem emblem={key} colour={check.valid.accent ?? "#f4d19a"} />
                </button>
              ))}
            </div>
          </div>
          {preset === "private" ? (
            <p className="text-xs text-white/40">
              This space is Private, so the map will show everyone else a held plot with none of this on it. The preview shows both views.
            </p>
          ) : null}
        </div>
      </details>

      <button
        type="button"
        onClick={toPreview}
        disabled={!detailsOk}
        className="w-full rounded-full bg-lantern-400 py-3 font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
      >
        Next: preview on the map
      </button>
    </section>
  );
}

function Emblem({ emblem, colour }: { emblem: BrandEmblem; colour: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = 20 * dpr;
    c.height = 20 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 20, 20);
    drawBrandEmblem(ctx, emblem, 10, 10, 16, colour);
  }, [emblem, colour]);
  return <canvas ref={ref} style={{ width: 20, height: 20 }} aria-hidden />;
}
