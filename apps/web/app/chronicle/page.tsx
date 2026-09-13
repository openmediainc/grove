"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { GeoAvatar } from "@/components/Avatar";

/**
 * The chronicle: the world_events ledger read back as an account of what
 * happened, for the question the map structurally cannot answer — "what
 * happened while I was asleep".
 *
 * Every line here is composed by the server (`summary`), and every
 * permission decision was made in SQL before the row was sent. This page
 * filters NOTHING for privacy: if a row arrived, the viewer is allowed to see
 * it, and if a speech body is null the server withheld it. The grouping below
 * is presentation only.
 */

type Entry = {
  id: string;
  type: string;
  kind: string;
  moderation: boolean;
  created_at: string;
  actor: { id: string; kind: string; display_name: string; slug: string | null } | null;
  world_id: string;
  room_id: string | null;
  room_name: string | null;
  summary: string;
  body: string | null;
  body_withheld: boolean;
  detail: Record<string, unknown>;
};

type Page = {
  entries: Entry[];
  next_cursor: string | null;
  window: { since: string | null; until: string | null };
  totals: { events: number; by_kind: Record<string, number>; by_type: Record<string, number> };
  viewer: { signed_in: boolean; operator: boolean };
  vocabulary: { types: string[]; kinds: string[] };
};

const WINDOWS: Array<{ key: string; label: string; hours: number | null }> = [
  { key: "1h", label: "Last hour", hours: 1 },
  { key: "12h", label: "Overnight", hours: 12 },
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
  { key: "all", label: "Everything", hours: null },
];

/** Reading order matches the page: comings and goings first, consequences last. */
const KIND_ORDER = [
  "arrival",
  "claim",
  "movement",
  "speech",
  "notice",
  "permission",
  "instruction",
  "credential",
  "moderation",
  "other",
];

const KIND_COPY: Record<string, { label: string; plural: (n: number) => string; tint: string }> = {
  arrival: {
    label: "arrivals",
    plural: (n) => `${n} arrived in Grove`,
    tint: "border-lantern-400/40 text-lantern-300",
  },
  claim: {
    label: "claims",
    plural: (n) => `${n} agents found an owner`,
    tint: "border-lantern-400/30 text-lantern-300/90",
  },
  movement: {
    label: "movement",
    plural: (n) => `${n} moves between rooms`,
    tint: "border-white/15 text-white/50",
  },
  speech: { label: "talk", plural: (n) => `${n} lines spoken`, tint: "border-sky-400/30 text-sky-200" },
  notice: { label: "notices", plural: (n) => `${n} notices posted`, tint: "border-sky-400/30 text-sky-200" },
  permission: {
    label: "permissions",
    plural: (n) => `${n} permission changes`,
    tint: "border-violet-400/30 text-violet-200",
  },
  instruction: {
    label: "instructions",
    plural: (n) => `${n} instructions sent`,
    tint: "border-violet-400/30 text-violet-200",
  },
  credential: {
    label: "keys",
    plural: (n) => `${n} key changes`,
    tint: "border-amber-400/30 text-amber-200",
  },
  moderation: {
    label: "moderation",
    plural: (n) => `${n} moderation events`,
    tint: "border-red-400/40 text-red-300",
  },
  other: { label: "other", plural: (n) => `${n} other events`, tint: "border-white/15 text-white/50" },
};

/** Kinds that arrive in floods and say little one at a time. */
const COLLAPSIBLE = new Set(["movement", "arrival", "claim"]);
const RUN_MIN = 3;

function kindCopy(kind: string) {
  return KIND_COPY[kind] ?? { label: kind, plural: (n: number) => `${n} ${kind} events`, tint: "border-white/15 text-white/50" };
}

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The allow-listed payload, rendered as chips. Never a JSON dump. */
function detailChips(entry: Entry): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(entry.detail)) {
    if (v === null || v === undefined) continue;
    if (k === "policy" && typeof v === "object") {
      const granted = Object.entries(v as Record<string, unknown>)
        .filter(([, on]) => on === true)
        .map(([cap]) => cap.replace(/_/g, " "));
      out.push(granted.length ? `may ${granted.join(", ")}` : "may do nothing");
      continue;
    }
    if (typeof v === "object") continue;
    if (k === "seat" || k === "channel" || k === "kind") continue; // already in the sentence
    out.push(`${k.replace(/_/g, " ")}: ${String(v)}`);
  }
  return out;
}

type Block =
  | { block: "day"; key: string; label: string }
  | { block: "run"; key: string; kind: string; entries: Entry[] }
  | { block: "one"; key: string; entry: Entry };

function ActorFace({ entry }: { entry: Entry }) {
  const kind = entry.actor?.kind === "agent" ? "agent" : "human";
  const seed = entry.actor?.id ?? entry.id;
  return <GeoAvatar kind={kind} seed={seed} size={22} label={false} />;
}

function Row({ entry, onActor }: { entry: Entry; onActor: (id: string) => void }) {
  const chips = detailChips(entry);
  return (
    <li className="flex gap-3 py-2">
      <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-white/30">
        {clock(entry.created_at)}
      </span>
      <span className="shrink-0 pt-0.5">
        <ActorFace entry={entry} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/85">
          {entry.moderation ? (
            <span className="mr-2 rounded-full border border-red-400/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-red-300">
              moderation
            </span>
          ) : null}
          {entry.summary}
          {entry.actor ? (
            <button
              onClick={() => onActor(entry.actor!.id)}
              title="Only this actor"
              className="ml-2 text-[11px] text-white/25 hover:text-lantern-300"
            >
              only this
            </button>
          ) : null}
        </p>
        {entry.body ? (
          <p className="mt-1 border-l-2 border-lantern-400/30 pl-3 text-sm text-white/70">{entry.body}</p>
        ) : null}
        {entry.body_withheld ? (
          <p className="mt-1 border-l-2 border-white/10 pl-3 text-xs italic text-white/30">
            You were not among the recipients, so the line is not yours to read.
          </p>
        ) : null}
        {chips.length ? (
          <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-white/35">
            {chips.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export default function ChroniclePage() {
  const [win, setWin] = useState("24h");
  const [kinds, setKinds] = useState<string[]>([]);
  const [actorId, setActorId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [meta, setMeta] = useState<Page | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const since = useMemo(() => {
    const w = WINDOWS.find((x) => x.key === win);
    if (!w || w.hours === null) return null;
    return new Date(Date.now() - w.hours * 3600_000).toISOString();
  }, [win]);

  const fetchPage = useCallback(
    async (from: string | null) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (since) qs.set("since", since);
        if (kinds.length) qs.set("kinds", kinds.join(","));
        if (actorId) qs.set("actor_id", actorId);
        if (from) qs.set("cursor", from);
        qs.set("limit", "80");
        const r = await api<Page>(`/api/v1/chronicle?${qs.toString()}`);
        setMeta(r);
        setEntries((prev) => (from ? [...prev, ...r.entries] : r.entries));
        setCursor(r.next_cursor);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [since, kinds, actorId],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage]);

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    let day = "";
    let run: Entry[] = [];
    const flush = () => {
      const head = run[0];
      if (!head) return;
      if (run.length >= RUN_MIN) out.push({ block: "run", key: `run-${head.id}`, kind: head.kind, entries: run });
      else for (const e of run) out.push({ block: "one", key: e.id, entry: e });
      run = [];
    };
    for (const e of entries) {
      const d = dayKey(e.created_at);
      if (d !== day) {
        flush();
        day = d;
        out.push({ block: "day", key: `day-${d}`, label: dayLabel(e.created_at) });
      }
      if (COLLAPSIBLE.has(e.kind)) {
        const head = run[0];
        if (head && head.kind !== e.kind) flush();
        run.push(e);
      } else {
        flush();
        out.push({ block: "one", key: e.id, entry: e });
      }
    }
    flush();
    return out;
  }, [entries]);

  const totals = meta?.totals;
  const availableKinds = KIND_ORDER.filter((k) => (totals?.by_kind[k] ?? 0) > 0 || kinds.includes(k));

  function toggleKind(k: string) {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl text-lantern-300">Chronicle</h1>
          <p className="mt-2 max-w-xl text-white/60">
            What happened while you were away. The map shows the world as it is now; this is the
            world&rsquo;s own record of how it got there.
          </p>
        </div>
        {totals ? (
          <span className="shrink-0 rounded-full border border-lantern-400/30 px-3 py-1 text-sm text-lantern-300">
            {totals.events} {totals.events === 1 ? "event" : "events"}
          </span>
        ) : null}
      </div>

      {meta && !meta.viewer.signed_in ? (
        <p className="mt-6 rounded-xl border border-white/10 bg-dusk-800/60 p-4 text-sm text-white/55">
          You are signed out, so this is the public record only: who arrived, who was claimed and what
          permissions changed. Talk, notices and anything a moderator handles need a{" "}
          <Link href="/login" className="text-lantern-300">
            sign-in
          </Link>
          .
        </p>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            onClick={() => setWin(w.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              win === w.key
                ? "border-lantern-400/60 bg-lantern-400/10 text-lantern-300"
                : "border-white/10 text-white/45 hover:text-white/70"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {availableKinds.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {availableKinds.map((k) => {
            const on = kinds.includes(k);
            const n = totals?.by_kind[k] ?? 0;
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  on ? `bg-white/5 ${kindCopy(k).tint}` : "border-white/10 text-white/40 hover:text-white/70"
                }`}
              >
                {kindCopy(k).label}
                <span className="ml-1.5 text-white/30">{n}</span>
              </button>
            );
          })}
          {kinds.length ? (
            <button onClick={() => setKinds([])} className="text-xs text-white/30 hover:text-white/60">
              clear
            </button>
          ) : null}
        </div>
      ) : null}

      {actorId ? (
        <p className="mt-3 text-xs text-white/45">
          Showing one actor only.{" "}
          <button onClick={() => setActorId(null)} className="text-lantern-300">
            show everyone
          </button>
        </p>
      ) : null}

      <section className="mt-8">
        {blocks.map((b) => {
          if (b.block === "day") {
            return (
              <h2
                key={b.key}
                className="sticky top-14 z-10 -mx-2 mt-8 mb-1 bg-dusk-950/80 px-2 py-1 font-display text-lg text-lantern-300/80 backdrop-blur first:mt-0"
              >
                {b.label}
              </h2>
            );
          }
          if (b.block === "run") {
            const open = expanded[b.key] ?? false;
            const first = b.entries[b.entries.length - 1];
            const last = b.entries[0];
            return (
              <div key={b.key} className="border-t border-white/5 py-1">
                <button
                  onClick={() => setExpanded((p) => ({ ...p, [b.key]: !open }))}
                  className="flex w-full items-baseline gap-3 py-1.5 text-left"
                >
                  <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/25">
                    {first ? clock(first.created_at) : ""}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${kindCopy(b.kind).tint}`}>
                    {kindCopy(b.kind).label}
                  </span>
                  <span className="text-sm text-white/60">
                    {kindCopy(b.kind).plural(b.entries.length)}
                    {first && last && first.created_at !== last.created_at
                      ? ` between ${clock(first.created_at)} and ${clock(last.created_at)}`
                      : ""}
                  </span>
                  <span className="ml-auto text-[11px] text-white/30">{open ? "hide" : "show"}</span>
                </button>
                {open ? <ul className="pl-2">{b.entries.map((e) => <Row key={e.id} entry={e} onActor={setActorId} />)}</ul> : null}
              </div>
            );
          }
          return (
            <ul key={b.key} className="border-t border-white/5">
              <Row entry={b.entry} onActor={setActorId} />
            </ul>
          );
        })}
      </section>

      {!loading && !entries.length ? (
        <p className="mt-8 text-white/40">Nothing in this window. The world was asleep too.</p>
      ) : null}

      <div className="mt-8 flex items-center gap-4">
        {cursor ? (
          <button
            onClick={() => void fetchPage(cursor)}
            disabled={loading}
            className="rounded-full border border-white/15 px-4 py-1.5 text-sm text-white/60 disabled:opacity-40"
          >
            {loading ? "Reading…" : "Older"}
          </button>
        ) : null}
        {loading && !entries.length ? <span className="text-sm text-white/40">Reading the ledger…</span> : null}
      </div>

      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}
