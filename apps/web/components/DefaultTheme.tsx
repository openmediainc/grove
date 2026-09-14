"use client";

import { useEffect, useState } from "react";
import { isSpaceThemeId, type SpaceBranding } from "@grove/protocol";
import { api } from "@/lib/api";
import { previewPlot } from "@/lib/branding";
import { THEMES, THEME_IDS, type ThemeId } from "@/lib/themes";
import { SignPreview } from "./Branding";
import { ErrorNotice } from "@/components/ErrorNotice";
import { SECTION_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/**
 * Manage → Default theme (#59). The owner picks how this space's part of the
 * map looks to visitors who arrive through its links or zoom to its plot, as
 * a soft default: anyone who has picked a theme of their own, or opened a link
 * pinned to one, keeps theirs. Each choice shows the plot's sign in that theme
 * (the Branding preview), so it is the map's art, not a label.
 */
export function DefaultThemePanel({
  worldId,
  space,
  orgs,
  branding,
  defaultTheme,
  reload,
}: {
  worldId: string;
  space: { name: string; policy_preset: string };
  orgs: ReadonlyArray<{ name: string; colour: string }>;
  branding: SpaceBranding;
  defaultTheme: string | null;
  reload: () => Promise<void>;
}) {
  const stored: ThemeId | null = isSpaceThemeId(defaultTheme) ? defaultTheme : null;
  const [choice, setChoice] = useState<ThemeId | null>(stored);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setChoice(stored), [stored]);
  const plot = previewPlot(space, orgs, branding);

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api(`/api/v1/worlds/${worldId}/default-theme`, { method: "PUT", body: JSON.stringify({ theme: choice }) });
      await reload();
      setSaved(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const tile = (on: boolean) =>
    `block w-full overflow-hidden rounded-gh-md border-2 text-left focus-visible:outline-none focus-visible:shadow-gh-ring ${on ? "border-signal" : "border-transparent hover:border-line-strong"}`;

  return (
    <section className={SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>Default theme</h3>
      <p className="mt-1 text-xs text-muted">
        How your plot looks to people who arrive through this space&apos;s links or zoom in on it. Anyone who has picked a
        theme of their own keeps theirs, and the map goes back to their usual look when they move on.
      </p>
      {space.policy_preset === "private" ? (
        <p className="mt-2 text-xs text-muted">This space is private, so only its members see the default. Everyone else sees a held plot in their own theme.</p>
      ) : null}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Default theme">
        {THEME_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            onClick={() => {
              setSaved(false);
              setChoice(id);
            }}
            className={tile(choice === id)}
          >
            <SignPreview themeId={id} plot={plot} />
          </button>
        ))}
      </div>
      <button
        type="button"
        role="radio"
        aria-checked={choice === null}
        onClick={() => {
          setSaved(false);
          setChoice(null);
        }}
        className={`mt-2 min-h-11 rounded-gh-pill border px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:shadow-gh-ring sm:min-h-8 sm:py-1 ${
          choice === null ? "border-signal bg-tint text-ink" : "border-line-strong bg-surface-raised text-muted hover:bg-tint"
        }`}
      >
        No default: each visitor&apos;s own theme
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || choice === stored}
          className={buttonClass("secondary")}
        >
          {busy ? "Saving…" : "Save default theme"}
        </button>
        {saved ? (
          <span className="text-xs text-success" role="status">
            Saved{stored ? ` as ${THEMES[stored].lexicon.name}` : ""}. The map picks it up on its next refresh.
          </span>
        ) : null}
      </div>
      <ErrorNotice error={err} className="mt-2" />
    </section>
  );
}
