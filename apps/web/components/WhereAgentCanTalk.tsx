"use client";

import { SECTION_TITLE_CLASS } from "@/lib/brand-ui";
import { CAP_LABEL, CAP_ORDER, placeRows, type CellView, type WireEffectivePermissions } from "@/lib/effective-permissions";

/**
 * #62 — "Where this agent can talk". One row per place the agent is in or its
 * owner belongs to, four cells each: the agent's own grant AND that place's
 * ceiling, with the reason in plain words. The server (owner-only route) did
 * the deciding; this only draws `placeRows`.
 */

const TONE: Record<CellView["tone"], { box: string; mark: string; word: string }> = {
  open: { box: "border-success/50 bg-success/5", mark: "text-success", word: "yes" },
  yours: { box: "border-line-strong bg-surface-raised", mark: "text-ink", word: "no" },
  ceiling: { box: "border-pane bg-pane/10", mark: "text-ink", word: "no" },
};

export function WhereAgentCanTalk({ data, error }: { data: WireEffectivePermissions | null; error?: boolean }) {
  const rows = placeRows(data);
  return (
    <section className="mt-8" aria-labelledby="where-agent-can-talk">
      <h2 id="where-agent-can-talk" className={SECTION_TITLE_CLASS}>
        Where this agent can talk
      </h2>
      <p className="mt-1 max-w-xl text-sm text-muted">
        What it can actually do in each place: your settings above, narrowed by that space or room.
        A plain box is your setting; a tinted box is the place&apos;s.
      </p>
      {error ? (
        <p className="mt-3 text-sm text-muted">Could not load this right now. Reload to try again.</p>
      ) : !data ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li
              key={row.key}
              className={`rounded-gh-lg border border-line bg-surface p-3 ${row.isRoom ? "ml-3 sm:ml-6" : ""}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0 break-words font-semibold text-ink">
                  {row.label}
                  {row.here ? (
                    <span className="ml-2 rounded-gh-pill border border-success/50 px-2 py-[1px] align-middle gh-label text-success">
                      here now
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-muted">{row.detail}</div>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
                {row.cells.map((cell) => (
                  <div key={cell.cap} className={`rounded-gh-md border p-2 ${TONE[cell.tone].box}`}>
                    <dt className="flex items-center justify-between gap-2 gh-label text-muted">
                      <span>{CAP_LABEL[cell.cap]}</span>
                      <span className={`font-semibold ${TONE[cell.tone].mark}`}>{TONE[cell.tone].word}</span>
                    </dt>
                    <dd className="mt-1 text-xs leading-snug text-muted">{cell.reason}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only">Columns: {CAP_ORDER.map((c) => CAP_LABEL[c]).join(", ")}</span>
    </section>
  );
}
