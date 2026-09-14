"use client";

import { useEffect, useState } from "react";
import { ESTATE_NAME_MAX, graphemeCount, readEstateName } from "@grove/protocol";
import { api } from "@/lib/api";
import { ErrorNotice } from "@/components/ErrorNotice";
import { INPUT_CLASS, NUM_CLASS, SECTION_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

type WireNames = { mine: string | null; handle: string; orgs: Array<{ id: string; name: string; estate_name: string | null }> };

/**
 * Manage → Estate (#37). When plots of one owner (or one org) sit side by side
 * on the map they join as an estate with one shared sign; each plot keeps its
 * own access. This names that sign: your own estate, and the estate of any org
 * bound here that you own. Estates are computed, so there is nothing else to set.
 */
export function EstatePanel({ orgs }: { orgs: ReadonlyArray<{ id: string; name: string }> }) {
  const [names, setNames] = useState<WireNames | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    api<{ names: WireNames }>("/api/v1/estates/names")
      .then((r) => setNames(r.names))
      .catch((e: unknown) => setErr(e));
  }, []);

  if (!names) return <ErrorNotice error={err} size="xs" />;
  const bound = new Set(orgs.map((o) => o.id));
  const ownOrgs = names.orgs.filter((o) => bound.has(o.id));

  return (
    <section className={SECTION_CLASS}>
      <h3 className={SECTION_TITLE_CLASS}>Estate</h3>
      <p className="mt-1 text-xs text-muted">
        Plots of yours (or of one org) that sit next to each other on the map join as one estate, with a fence round
        the whole and one shared sign. Each plot keeps its own access and its own sign. Private plots never join.
      </p>
      <div className="mt-4 space-y-4">
        <NameField
          label="Your estate name"
          placeholder={`@${names.handle}`}
          value={names.mine}
          save={async (estate_name) => {
            const r = await api<{ names: WireNames }>("/api/v1/estates/names", { method: "PUT", body: JSON.stringify({ estate_name }) });
            setNames(r.names);
          }}
        />
        {ownOrgs.map((o) => (
          <NameField
            key={o.id}
            label={`${o.name} estate name`}
            placeholder={o.name}
            value={o.estate_name}
            save={async (estate_name) => {
              const r = await api<{ names: WireNames }>("/api/v1/estates/names", {
                method: "PUT",
                body: JSON.stringify({ estate_name, org_id: o.id }),
              });
              setNames(r.names);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function NameField({
  label,
  placeholder,
  value,
  save,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  save: (name: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(value ?? ""), [value]);
  const check = readEstateName(draft);
  const count = graphemeCount(draft.replace(/\s+/g, " ").trim());
  const dirty = (check.ok ? check.name : draft) !== value;

  async function submit() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await save(draft.trim() || null);
      setSaved(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-ink">
        {label}
        <input
          value={draft}
          onChange={(e) => {
            setSaved(false);
            setDraft(e.target.value);
          }}
          placeholder={placeholder}
          className={`mt-1 ${INPUT_CLASS} text-gh-sm font-normal`}
        />
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <span className={`text-xs ${NUM_CLASS} ${count > ESTATE_NAME_MAX ? "text-danger-ink" : "text-muted"}`}>
          {count}/{ESTATE_NAME_MAX}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !check.ok || !dirty}
          className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved ? <span className="text-xs text-success" role="status">Saved.</span> : null}
        {!check.ok ? <span className="text-xs text-danger-ink">{check.message}</span> : null}
        <ErrorNotice error={err} inline />
      </div>
    </div>
  );
}
