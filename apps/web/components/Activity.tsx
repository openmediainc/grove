"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import {
  ACTIVITY_WINDOWS,
  EMPTY_TOTALS,
  KIND_ORDER,
  activityQuery,
  activitySince,
  clock,
  detailChips,
  groupActivity,
  kindCopy,
  readActivityFilters,
  windowLabel,
  writeActivityFilters,
  type ActivityEntry,
  type ActivityFilters,
  type ActivityPage,
  type WindowKey,
} from "@/lib/activity";
import { actorRef } from "@/lib/chronicle-link";
import { GeoAvatar } from "@/components/Avatar";
import { Reactions } from "@/components/Reactions";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * <Activity> — the ledger as a readable list. ONE component for every place
 * Glasshouse shows what happened: the agent page, /chronicle, the space page
 * (#26) and the map's History drawer (#28).
 *
 * Usage:
 *   <Activity />                                   everything this viewer may see
 *   <Activity actorId={agent.id} />                one agent (fixed; no "only this")
 *   <Activity worldId={space.id} />                one space
 *   <Activity defaultWindow="today" summary={(w) => <AgentDay since={w.since} … />} />
 *
 * Props:
 *   actorId        fixed actor filter, sent as `actor_id`. When unset, the viewer
 *                  can narrow to one actor with "only this" (`?actor=` ref).
 *   worldId        fixed space filter, sent as `world_id`.
 *   defaultWindow  the window when the URL names none (default "24h").
 *   urlSync        write `win`, `kinds` (and `actor` when not fixed) into the
 *                  address with replaceState so a filtered view is a link.
 *                  Default true; pass false where two lists share one page.
 *   summary        rendered between the filters and the list with the chosen
 *                  window, for a view that adds its own roll-up (the owner's day).
 *   emptyText      what an empty window says.
 *   inPanel        the list scrolls inside a drawer (the map's History), so day
 *                  headings stick to the panel's top rather than under the nav.
 *
 * PERMISSIONS: none decided here. GET /api/v1/chronicle filtered every row in
 * SQL for this viewer and withheld any body they may not read (DECISIONS #4:
 * a non-owner sees exactly what the chronicle already permits them).
 */
export type ActivityWindow = { key: WindowKey; label: string; since: string | null };

export type ActivityProps = {
  actorId?: string | null;
  worldId?: string | null;
  defaultWindow?: WindowKey;
  urlSync?: boolean;
  summary?: (w: ActivityWindow) => ReactNode;
  emptyText?: string;
  inPanel?: boolean;
};

type ActivityTone = {
  clock: string;
  ink: string;
  faint: string;
  link: string;
  accent: string;
  quote: string;
  withheld: string;
  moderation: string;
  pillOn: string;
  pillOff: string;
  note: string;
  day: string;
  rule: string;
  kind: string;
  button: string;
};

const TONE: ActivityTone = {
  clock: "font-brand-mono text-muted",
  ink: "text-ink",
  faint: "text-muted",
  link: "text-muted underline decoration-line-strong underline-offset-2 hover:text-ink",
  accent: "text-ink underline decoration-line-strong underline-offset-2",
  quote: "border-line-strong text-ink",
  withheld: "border-line text-muted",
  moderation: "border-danger-ink/60 text-danger-ink",
  pillOn: "border-ink bg-tint text-ink",
  pillOff: "border-line-strong bg-surface-raised text-muted hover:text-ink",
  note: "border-line bg-surface-raised text-muted",
  day: "gh-frost font-brand font-extrabold tracking-tight text-ink",
  rule: "border-line",
  kind: "border-line-strong font-brand-mono text-ink",
  button: "border-line-strong bg-surface-raised text-ink hover:bg-tint",
};

function ActorFace({ entry }: { entry: ActivityEntry }) {
  const kind = entry.actor?.kind === "agent" ? "agent" : "human";
  return <GeoAvatar kind={kind} seed={entry.actor?.id ?? entry.id} size={22} label={false} />;
}

function Row({
  entry,
  onActor,
  signedIn,
  t,
}: {
  entry: ActivityEntry;
  onActor: ((ref: string) => void) | null;
  signedIn: boolean;
  t: ActivityTone;
}) {
  const chips = detailChips(entry);
  return (
    <li className="flex gap-3 py-2">
      <span className={`w-12 shrink-0 pt-0.5 text-right text-[11px] tabular-nums ${t.clock}`}>
        {clock(entry.created_at)}
      </span>
      <span className="shrink-0 pt-0.5">
        <ActorFace entry={entry} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`break-words text-sm ${t.ink}`}>
          {entry.moderation ? (
            <span className={`mr-2 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${t.moderation}`}>
              moderation
            </span>
          ) : null}
          {entry.summary}
          {entry.actor && onActor ? (
            <button
              type="button"
              onClick={() => onActor(actorRef(entry.actor) ?? entry.actor!.id)}
              title="Only this actor"
              className={`tap-inline tap-hit ml-2 text-[11px] ${t.link}`}
            >
              only this
            </button>
          ) : null}
        </p>
        {entry.body ? (
          <p className={`mt-1 break-words border-l-2 pl-3 text-sm ${t.quote}`}>{entry.body}</p>
        ) : null}
        {entry.body_withheld ? (
          <p className={`mt-1 border-l-2 pl-3 text-xs italic ${t.withheld}`}>
            You were not among the recipients, so the line is not yours to read.
          </p>
        ) : null}
        {entry.reaction_target ? (
          <Reactions target={entry.reaction_target} summary={entry.reactions} canReact asGuest={!signedIn}  />
        ) : null}
        {chips.length ? (
          <p className={`mt-1 flex flex-wrap gap-x-3 text-[11px] ${t.faint}`}>
            {chips.map((c) => (
              <span key={c} className="break-all">
                {c}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function Activity({
  actorId = null,
  worldId = null,
  defaultWindow = "24h",
  urlSync = true,
  summary,
  emptyText = "Nothing in this window.",
  inPanel = false,
}: ActivityProps) {
  // Brand chrome (DECISIONS #7): in the map's History drawer in the viewer's
  // mode; on pages still in the legacy frame the tokens render night.
  const t = TONE;
  const defaults = useMemo(() => ({ win: defaultWindow }), [defaultWindow]);
  const [filters, setFilters] = useState<ActivityFilters>({ win: defaultWindow, kinds: [], actor: null });
  // The first fetch waits until the URL has been read, so a shared link never
  // flashes the unfiltered list first.
  const [urlRead, setUrlRead] = useState(!urlSync);
  useEffect(() => {
    if (!urlSync) return;
    const f = readActivityFilters(window.location.search, defaults);
    setFilters(actorId ? { ...f, actor: null } : f);
    setUrlRead(true);
  }, [urlSync, defaults, actorId]);

  const update = useCallback(
    (next: ActivityFilters) => {
      setFilters(next);
      if (!urlSync) return;
      const { pathname, search, hash } = window.location;
      const qs = writeActivityFilters(search, next, defaults, { withActor: !actorId });
      window.history.replaceState(window.history.state, "", `${pathname}${qs}${hash}`);
    },
    [urlSync, defaults, actorId],
  );

  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [meta, setMeta] = useState<ActivityPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  // Recomputed per filter change only, so "today" does not creep while paging.
  const since = useMemo(() => activitySince(filters.win), [filters.win]);
  const kindsKey = filters.kinds.join(",");

  const fetchPage = useCallback(
    async (from: string | null) => {
      setLoading(true);
      try {
        const r = await api<ActivityPage>(
          activityQuery({
            since,
            kinds: kindsKey ? kindsKey.split(",") : [],
            actorId,
            actor: filters.actor,
            worldId,
            cursor: from,
          }),
        );
        setMeta(r);
        setEntries((prev) => (from ? [...prev, ...r.entries] : r.entries));
        setCursor(r.next_cursor);
        setErr(null);
      } catch (e) {
        setErr(e);
      } finally {
        setLoading(false);
      }
    },
    [since, kindsKey, actorId, filters.actor, worldId],
  );

  useEffect(() => {
    if (!urlRead) return;
    void fetchPage(null);
  }, [fetchPage, urlRead]);

  const blocks = useMemo(() => groupActivity(entries), [entries]);
  const totals = meta?.totals ?? EMPTY_TOTALS;
  const availableKinds = KIND_ORDER.filter((k) => (totals.by_kind[k] ?? 0) > 0 || filters.kinds.includes(k));
  const signedIn = Boolean(meta?.viewer.signed_in);
  const onActor = actorId ? null : (ref: string) => update({ ...filters, actor: ref });

  function toggleKind(k: string) {
    const kinds = filters.kinds.includes(k) ? filters.kinds.filter((x) => x !== k) : [...filters.kinds, k];
    update({ ...filters, kinds });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {ACTIVITY_WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => update({ ...filters, win: w.key })}
            className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 ${
              filters.win === w.key ? t.pillOn : t.pillOff
            }`}
          >
            {w.label}
          </button>
        ))}
        {meta ? (
          <span className={`ml-auto text-xs ${t.faint}`}>
            {totals.events} {totals.events === 1 ? "event" : "events"}
          </span>
        ) : null}
      </div>

      {availableKinds.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {availableKinds.map((k) => {
            const on = filters.kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleKind(k)}
                className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 ${
                  on ? t.pillOn : t.pillOff
                }`}
              >
                {kindCopy(k).label}
                <span className={`ml-1.5 tabular-nums ${t.faint}`}>{totals.by_kind[k] ?? 0}</span>
              </button>
            );
          })}
          {filters.kinds.length ? (
            <button type="button" onClick={() => update({ ...filters, kinds: [] })} className={`text-xs ${t.link}`}>
              clear
            </button>
          ) : null}
        </div>
      ) : null}

      {!actorId && filters.actor ? (
        <p className={`mt-3 text-xs ${t.faint}`}>
          Showing only <code className={`break-all ${t.faint}`}>{filters.actor}</code>.{" "}
          <button type="button" onClick={() => update({ ...filters, actor: null })} className={t.accent}>
            show everyone
          </button>
        </p>
      ) : null}

      {meta && !meta.viewer.signed_in ? (
        <p className={`mt-4 rounded-xl border p-3 text-xs ${t.note}`}>
          Signed out, this is the public record only: arrivals, claims and permission changes. Talk,
          notices and moderation need a{" "}
          <Link href="/login" className={t.accent}>
            sign-in
          </Link>
          .
        </p>
      ) : null}

      {summary ? summary({ key: filters.win, label: windowLabel(filters.win), since }) : null}

      <section className="mt-6">
        {blocks.map((b) => {
          if (b.block === "day") {
            // Under the drawer's h2 a day is an h3; on a page (under the h1) an h2.
            const DayHeading = inPanel ? "h3" : "h2";
            return (
              <DayHeading
                key={b.key}
                className={`sticky ${inPanel ? "top-0" : "top-14"} z-10 -mx-2 mb-1 mt-8 px-2 py-1 text-lg backdrop-blur first:mt-0 ${t.day}`}
              >
                {b.label}
              </DayHeading>
            );
          }
          if (b.block === "run") {
            const open = expanded[b.key] ?? false;
            const first = b.entries[b.entries.length - 1];
            const last = b.entries[0];
            const copy = kindCopy(b.kind);
            return (
              <div key={b.key} className={`border-t py-1 ${t.rule}`}>
                <button
                  type="button"
                  onClick={() => setExpanded((p) => ({ ...p, [b.key]: !open }))}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 text-left"
                >
                  <span className={`w-12 shrink-0 text-right text-[11px] tabular-nums ${t.clock}`}>
                    {first ? clock(first.created_at) : ""}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${t.kind}`}>
                    {copy.label}
                  </span>
                  <span className={`min-w-0 flex-1 text-sm ${t.faint}`}>
                    {copy.plural(b.entries.length)}
                    {first && last && first.created_at !== last.created_at
                      ? ` between ${clock(first.created_at)} and ${clock(last.created_at)}`
                      : ""}
                  </span>
                  <span className={`text-[11px] ${t.faint}`}>{open ? "hide" : "show"}</span>
                </button>
                {open ? (
                  <ul className="pl-2">
                    {b.entries.map((e) => (
                      <Row key={e.id} entry={e} onActor={onActor} signedIn={signedIn} t={t} />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          }
          return (
            <ul key={b.key} className={`border-t ${t.rule}`}>
              <Row entry={b.entry} onActor={onActor} signedIn={signedIn} t={t} />
            </ul>
          );
        })}
      </section>

      {!loading && urlRead && !entries.length && !err ? <p className={`mt-6 text-sm ${t.faint}`}>{emptyText}</p> : null}

      <div className="mt-6 flex items-center gap-4">
        {cursor ? (
          <button
            type="button"
            onClick={() => void fetchPage(cursor)}
            disabled={loading}
            className={`rounded-full border px-4 py-2 text-sm disabled:opacity-40 sm:py-1.5 ${t.button}`}
          >
            {loading ? "Reading…" : "Older"}
          </button>
        ) : null}
        {loading && !entries.length ? <span className={`text-sm ${t.faint}`}>Reading the record…</span> : null}
      </div>

      <ErrorNotice error={err} className="mt-4" />
    </div>
  );
}
