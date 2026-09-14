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
import { ErrorNotice } from "@/components/ErrorNotice";
import { CHECKBOX_CLASS, INPUT_CLASS, SECTION_TITLE_CLASS, buttonClass, optionClass } from "@/lib/brand-ui";

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
  const [suggestErr, setSuggestErr] = useState<unknown>(null);
  const [preview, setPreview] = useState<WireClaimPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<unknown>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [viewAs, setViewAs] = useState<ViewAs>("owner");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
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
      setPreviewErr(e);
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
      setSuggestErr(e);
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
      setErr(code === "SLUG_TAKEN" ? `${(e as Error).message} Go back and pick another slug.` : e);
      setBusy(false);
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className={SECTION_TITLE_CLASS}>Create a space</h2>
        <p className="mt-1 text-sm text-muted">
          {step === "details"
            ? "Step 1 of 2: details. You get the next free plot on the shared world, and it stays yours. Six rooms come with it."
            : step === "preview"
              ? "Step 2 of 2: preview. Nothing is claimed until you confirm."
              : "Your space is claimed."}
        </p>
      </div>
      <button type="button" onClick={onClose} className={buttonClass("ghost", "sm", "min-h-11 shrink-0 sm:min-h-8")}>
        Close
      </button>
    </div>
  );

  if (step === "moved" && moved && preview) {
    const at = plotCentre(moved.to);
    return (
      <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-gh-lg border border-line bg-surface-raised p-4 shadow-gh-1 sm:p-6">
        {header}
        <p className="rounded-gh-md border border-line-strong bg-tint p-3 text-sm text-ink" role="status">
          {moved.message}
        </p>
        <ClaimPreview preview={preview} draft={draft} viewAs={viewAs} onViewAs={setViewAs} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <a
            href={gp(spaceHref(moved.slug))}
            className={buttonClass("primary", "md")}
          >
            Go to your space
          </a>
          <a
            href={gp(`/?at=${at.tx},${at.ty}`)}
            className={buttonClass("secondary", "md")}
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
      <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-gh-lg border border-line bg-surface-raised p-4 shadow-gh-1 sm:p-6">
        {header}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-gh-md border border-line bg-surface p-3 text-sm text-ink sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Name</dt>
          <dd className="min-w-0 break-words">{name.trim()}</dd>
          <dt className="text-muted">Page</dt>
          <dd className="min-w-0 break-all font-brand-mono text-xs leading-5">/s/{finalSlug}</dd>
          <dt className="text-muted">Access</dt>
          <dd>
            <strong>{copy.word}</strong> <span className="text-muted">· {copy.line}</span>
          </dd>
          <dt className="text-muted">Branding</dt>
          <dd className="text-muted">
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
            <p className="text-xs text-muted">
              Nothing is reserved: {plotCaption(preview.plot_index, preview.ring).toLowerCase()} is the next free plot right now. Your plot
              may shift if someone claims first.{" "}
              <button type="button" onClick={() => void loadPreview()} disabled={loadingPreview} className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                {loadingPreview ? "Checking…" : "Check again"}
              </button>
            </p>
          </>
        ) : loadingPreview ? (
          <p className="text-sm text-muted">Finding your plot…</p>
        ) : null}
        <ErrorNotice error={previewErr} />

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => {
              setStep("details");
              scrollTop();
            }}
            className={buttonClass("secondary", "md")}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || !preview}
            className={buttonClass("primary", "md")}
          >
            {busy ? "Claiming…" : "Confirm and create"}
          </button>
        </div>
        <ErrorNotice error={err} />
      </section>
    );
  }

  const swatch = paletteKeyOf(brand.accent);
  return (
    <section ref={topRef} id="create" className="mt-8 space-y-4 rounded-gh-lg border border-line bg-surface-raised p-4 shadow-gh-1 sm:p-6">
      {header}

      <label className="block">
        <span className="text-sm text-muted">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(suggestSlug(e.target.value));
          }}
          placeholder="Harbour workshop"
          className={`mt-1 ${INPUT_CLASS}`}
        />
      </label>

      <label className="block">
        <span className="text-sm text-muted">Slug</span>
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          onBlur={() => setSlug(suggestSlug(slug))}
          placeholder="harbour-workshop"
          className={`mt-1 font-brand-mono text-sm ${INPUT_CLASS}`}
        />
        <span className="mt-1 block break-all text-xs text-muted">
          Lowercase and dashes. Its page will be <code>/s/{finalSlug || "your-slug"}</code>.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm text-muted">Access</legend>
        {ACCESS_ORDER.map((p) => {
          const copy = accessCopy(p);
          return (
            <label
              key={p}
              className={`flex cursor-pointer items-start gap-3 ${optionClass(preset === p)}`}
            >
              <input
                type="radio"
                name="access"
                className={`mt-1 ${CHECKBOX_CLASS}`}
                checked={preset === p}
                onChange={() => setPreset(p)}
              />
              <span>
                <strong>{copy.word}</strong>
                <span className="block text-sm text-muted">{copy.line}</span>
              </span>
            </label>
          );
        })}
        <p className="text-xs text-muted">You can change it later under Manage on the space&apos;s page.</p>
      </fieldset>

      <details className="rounded-gh-md border border-line bg-surface p-3" open={hasBranding || undefined}>
        <summary className="min-h-11 cursor-pointer text-sm text-ink sm:min-h-0">Branding (optional)</summary>
        <div className="mt-3 space-y-4">
          <div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void suggest();
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <label className="block min-w-0 flex-1 text-xs text-muted">
                Use my website
                <input
                  value={siteUrl}
                  onChange={(e) => setSiteUrl(e.target.value)}
                  placeholder="https://example.com"
                  inputMode="url"
                  autoComplete="url"
                  maxLength={2048}
                  className={`mt-1 text-sm ${INPUT_CLASS}`}
                />
              </label>
              <button
                type="submit"
                disabled={suggesting || !siteUrl.trim()}
                className={buttonClass("secondary", "md")}
              >
                {suggesting ? "Reading…" : "Suggest"}
              </button>
            </form>
            <p className="mt-1 text-[11px] text-muted">
              Glasshouse reads only the site&apos;s name, theme colour and icon colour. Nothing is saved.
            </p>
            <ErrorNotice error={suggestErr} size="xs" className="mt-2" />
            {suggestion ? (
              <div className="mt-3 space-y-1 text-xs text-muted" aria-live="polite">
                <p className="break-all text-muted">From {suggestion.source.url}</p>
                {suggestion.name ? <p>Sign text: {suggestion.name}</p> : null}
                {suggestion.accent ? (
                  <p className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-line-strong" style={{ background: suggestion.accent.accent }} aria-hidden />
                    {suggestionColourLine(suggestion)}
                  </p>
                ) : null}
                {suggestion.notes.map((n) => (
                  <p key={n} className="text-muted">
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
                    className={buttonClass("secondary", "sm")}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={() => setSuggestion(null)}
                    className={buttonClass("ghost", "sm")}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <p className="text-xs text-muted">Accent colour</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setBrand({ ...brand, accent: "" })}
                aria-pressed={!brand.accent.trim()}
                className={`h-8 rounded-gh-pill border px-3 text-xs ${!brand.accent.trim() ? "border-signal bg-tint text-ink" : "border-line-strong text-muted"}`}
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
                  className={`h-8 w-8 rounded-gh-pill border-2 ${swatch === p.key ? "border-ink shadow-gh-ring" : "border-line"}`}
                  style={{ background: p.hex }}
                />
              ))}
              <input
                value={brand.accent}
                onChange={(e) => setBrand({ ...brand, accent: e.target.value })}
                placeholder="#rrggbb"
                maxLength={7}
                aria-label="Accent hex"
                className={`${INPUT_CLASS} !w-24 font-brand-mono text-xs`}
              />
            </div>
            {check.accentError ? <p className="mt-1 text-xs text-danger-ink">{check.accentError}</p> : null}
          </div>

          <label className="block text-xs text-muted">
            Sign text
            <input
              value={brand.signText}
              onChange={(e) => setBrand({ ...brand, signText: e.target.value })}
              placeholder="Open late on Fridays"
              className={`mt-1 text-sm ${INPUT_CLASS}`}
            />
            <span className={`mt-1 block ${check.signTextCount > SIGN_TEXT_MAX ? "text-danger-ink" : "text-muted"}`}>
              {check.signTextError ?? `${check.signTextCount}/${SIGN_TEXT_MAX}`}
            </span>
          </label>

          <div>
            <p className="text-xs text-muted">Emblem</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setBrand({ ...brand, emblem: null })}
                aria-pressed={brand.emblem === null}
                className={`h-9 rounded-gh-md border px-3 text-xs ${brand.emblem === null ? "border-signal bg-tint text-ink" : "border-line-strong text-muted"}`}
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
                  className={`grid h-9 w-9 place-items-center rounded-gh-md border ${brand.emblem === key ? "border-signal bg-tint" : "border-line-strong"}`}
                >
                  <Emblem emblem={key} colour={check.valid.accent ?? "#f4d19a"} />
                </button>
              ))}
            </div>
          </div>
          {preset === "private" ? (
            <p className="text-xs text-muted">
              This space is Private, so the map will show everyone else a held plot with none of this on it. The preview shows both views.
            </p>
          ) : null}
        </div>
      </details>

      <button
        type="button"
        onClick={toPreview}
        disabled={!detailsOk}
        className={buttonClass("primary", "md", "w-full")}
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
