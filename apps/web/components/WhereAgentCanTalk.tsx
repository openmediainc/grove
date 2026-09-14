"use client";

import { CAP_LABEL, CAP_ORDER, placeRows, type CellView, type WireEffectivePermissions } from "@/lib/effective-permissions";

/**
 * #62 — "Where this agent can talk". One row per place the agent is in or its
 * owner belongs to, four cells each: the agent's own grant AND that place's
 * ceiling, with the reason in plain words. The server (owner-only route) did
 * the deciding; this only draws `placeRows`.
 */

const TONE: Record<CellView["tone"], { box: string; mark: string; word: string }> = {
  open: { box: "border-emerald-300/30 bg-emerald-300/[0.05]", mark: "text-emerald-200", word: "yes" },
  yours: { box: "border-lantern-400/40 bg-lantern-400/[0.06]", mark: "text-lantern-300", word: "no" },
  ceiling: { box: "border-sky-300/35 bg-sky-300/[0.05]", mark: "text-sky-200", word: "no" },
};

export function WhereAgentCanTalk({ data, error }: { data: WireEffectivePermissions | null; error?: boolean }) {
  const rows = placeRows(data);
  return (
    <section className="mt-8" aria-labelledby="where-agent-can-talk">
      <h2 id="where-agent-can-talk" className="font-display text-2xl text-lantern-300">
        Where this agent can talk
      </h2>
      <p className="mt-1 max-w-xl text-sm text-white/55">
        What it can actually do in each place: your settings above, narrowed by that space or room.
        Amber is your setting; blue is the place&apos;s.
      </p>
      {error ? (
        <p className="mt-3 text-sm text-white/50">Could not load this right now. Reload to try again.</p>
      ) : !data ? (
        <p className="mt-3 text-sm text-white/50">Loading…</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li
              key={row.key}
              className={`rounded-2xl border border-white/10 bg-dusk-900/50 p-3 ${row.isRoom ? "ml-3 sm:ml-6" : ""}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0 break-words font-semibold text-white/85">
                  {row.label}
                  {row.here ? (
                    <span className="ml-2 rounded-full border border-emerald-300/40 px-2 py-[1px] text-[10px] uppercase tracking-[0.12em] text-emerald-200">
                      here now
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-white/45">{row.detail}</div>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
                {row.cells.map((cell) => (
                  <div key={cell.cap} className={`rounded-xl border p-2 ${TONE[cell.tone].box}`}>
                    <dt className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.1em] text-white/45">
                      <span>{CAP_LABEL[cell.cap]}</span>
                      <span className={`font-semibold ${TONE[cell.tone].mark}`}>{TONE[cell.tone].word}</span>
                    </dt>
                    <dd className="mt-1 text-xs leading-snug text-white/65">{cell.reason}</dd>
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
