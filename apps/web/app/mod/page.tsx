"use client";

/**
 * The operator console.
 *
 * RULES.md has said "closed alpha until a full mod queue exists" since the
 * world opened. This is that queue. Three things were being written and never
 * read — reports, prompt-injection flags, and the state of the four freeze
 * switches — and all three are on this page, next to the actions that resolve
 * them.
 *
 * Deliberately NOT here: assignment, SLAs, canned responses, bulk actions.
 * This is a queue for a handful of operators, and every action costs a typed
 * reason on purpose.
 *
 * Wire shape note: the API serialises with toSnake, deeply — including the
 * jsonb payload of an audit row, so `payload.targetId` arrives as
 * `payload.target_id`.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { EmailHealthPanel } from "@/components/mod/EmailHealth";
import { OverviewPanel } from "@/components/mod/Overview";
import { TrialsPanel } from "@/components/mod/Trials";

type Actor = {
  id: string;
  kind: "human" | "agent" | "unknown";
  display_name: string;
  handle: string | null;
  owner_human_id: string | null;
  owner_handle: string | null;
  suspended: boolean;
  claim_state: string | null;
};

type Line = {
  id: string;
  channel: string | null;
  room_id: string | null;
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: string;
};

type ActionEntry = {
  id: string;
  type: string;
  actor_id: string | null;
  actor_handle: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

type Report = {
  id: string;
  reporter: Actor;
  target: Actor;
  category: string;
  details: string | null;
  created_at: string;
  status: string;
  resolution: string | null;
  resolution_note: string | null;
  resolved_by_handle: string | null;
  resolved_at: string | null;
  target_report_count: number;
  target_warn_count: number;
  target_injection_flag_count: number;
};

type ReportDetail = Report & {
  snapshot_lines: Line[];
  target_speech: Line[];
  reporter_speech: Line[];
  target_history: ActionEntry[];
};

type FlagState = {
  flag: string;
  value: boolean;
  effect: string;
  updated_at: string | null;
  updated_by_handle: string | null;
  reason: string | null;
};

type InjectionFlag = {
  event_id: string;
  actor: Actor;
  channel: string | null;
  created_at: string;
  speech: Line | null;
  reviewed: boolean;
  outcome: string | null;
  note: string | null;
  reviewed_by_handle: string | null;
  reviewed_at: string | null;
};

type Queue = {
  reports: Report[];
  flags: FlagState[];
  injection_flags: InjectionFlag[];
  counts: { open: number; open_injection: number; frozen: string[] };
};

type Tab = "overview" | "reports" | "injection" | "log" | "email" | "trials";

const STATUSES = ["open", "resolved", "rejected", "all"] as const;

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function actorLabel(a: Actor): string {
  const name = a.display_name || a.id;
  if (a.kind === "agent") return `${name} (@${a.handle ?? "?"}${a.owner_handle ? ` · owner @${a.owner_handle}` : ""})`;
  if (a.kind === "human") return `${name} (@${a.handle ?? "?"})`;
  return `${name} — no longer exists`;
}

/** The severity band the queue sorts by. Colour follows the same ordering. */
const CATEGORY_TONE: Record<string, string> = {
  illegal: "bg-red-500/25 text-red-100 ring-red-400/40",
  harassment: "bg-orange-500/20 text-orange-100 ring-orange-400/30",
  impersonation: "bg-amber-500/20 text-amber-100 ring-amber-400/30",
  prompt_injection: "bg-violet-500/20 text-violet-100 ring-violet-400/30",
  spam: "bg-sky-500/15 text-sky-100 ring-sky-400/25",
  other: "bg-white/10 text-white/70 ring-white/15",
};

function Chip({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${tone ?? "bg-white/10 text-white/70 ring-white/15"}`}>
      {children}
    </span>
  );
}

function Transcript({ title, lines, highlight }: { title: string; lines: Line[]; highlight: string }) {
  if (!lines.length) return null;
  return (
    <div className="mt-3">
      <h4 className="text-[11px] uppercase tracking-widest text-white/40">{title}</h4>
      <ol className="mt-1 max-h-64 space-y-1 overflow-y-auto rounded-lg bg-dusk-950/60 p-3 text-xs">
        {lines.map((l) => (
          <li key={`${l.id}-${l.created_at}`} className={l.sender_id === highlight ? "text-lantern-300" : "text-white/70"}>
            <span className="text-white/35">{when(l.created_at)} </span>
            <span className="font-semibold">{l.sender_name}</span>
            {l.room_id ? <span className="text-white/30"> in {l.room_id}</span> : null}
            <span className="text-white/30">: </span>
            <span className="whitespace-pre-wrap">{l.body}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function ModPage() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("open");
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<Record<string, ReportDetail>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [log, setLog] = useState<ActionEntry[]>([]);
  const [actorId, setActorId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const reasonFor = (key: string) => reasons[key] ?? "";
  const setReason = (key: string, value: string) => setReasons((r) => ({ ...r, [key]: value }));

  const load = useCallback(async () => {
    const q = await api<Queue>(`/api/v1/mod/queue?status=${status}`);
    setQueue(q);
  }, [status]);

  useEffect(() => {
    void load().catch(async (e) => {
      if ((e as { status?: number }).status === 401) {
        window.location.href = gp("/login");
        return;
      }
      try {
        await api("/api/v1/ops/bootstrap", { method: "POST", body: "{}" });
        await load();
      } catch {
        // Not an operator. How a server makes one is its own business, not this page's.
        setDenied(true);
      }
    });
  }, [load]);

  useEffect(() => {
    if (tab !== "log") return;
    void api<{ entries: ActionEntry[] }>("/api/v1/mod/log")
      .then((r) => setLog(r.entries))
      .catch((e) => setErr((e as Error).message));
  }, [tab]);

  /** Every mutation funnels through here so one place clears errors and reloads. */
  async function act(what: string, run: () => Promise<unknown>) {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await run();
      setMsg(what);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openReport(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (detail[id]) return;
    try {
      const r = await api<{ report: ReportDetail }>(`/api/v1/mod/reports/${id}`);
      setDetail((d) => ({ ...d, [id]: r.report }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function decide(report: Report, decision: "dismiss" | "warn" | "suspend" | "freeze") {
    const why = reasonFor(`report:${report.id}`).trim();
    if (decision !== "dismiss" && !why) {
      setErr("Warn, suspend and freeze each need a reason. It goes in the audit log, not into the void.");
      return;
    }
    void act(`Report ${report.id} — ${decision}.`, async () => {
      await api(`/api/v1/mod/reports/${report.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, reason: why || null, freezeFlag: "freeze.speech" }),
      });
      setDetail((d) => {
        const next = { ...d };
        delete next[report.id];
        return next;
      });
      setOpenId(null);
      setReason(`report:${report.id}`, "");
    });
  }

  function toggleFlag(flag: FlagState) {
    const key = `flag:${flag.flag}`;
    const why = reasonFor(key).trim();
    if (!flag.value && !why) {
      setErr(`Freezing ${flag.flag} needs a reason — everyone who comes after you will want to know why.`);
      return;
    }
    void act(`${flag.flag} → ${flag.value ? "off" : "ON"}.`, async () => {
      await api("/api/v1/mod/flags", {
        method: "POST",
        body: JSON.stringify({ flag: flag.flag, value: !flag.value, reason: why || null }),
      });
      setReason(key, "");
    });
  }

  function reviewInjection(flag: InjectionFlag, outcome: "benign" | "actioned") {
    const key = `inj:${flag.event_id}`;
    void act(`Flag ${flag.event_id} → ${outcome}.`, async () => {
      await api(`/api/v1/mod/injection/${flag.event_id}/review`, {
        method: "POST",
        body: JSON.stringify({ outcome, note: reasonFor(key).trim() || null }),
      });
      setReason(key, "");
    });
  }

  function actorAction(kind: "suspend" | "unsuspend" | "warn") {
    const id = actorId.trim();
    const why = reasonFor("actor").trim();
    if (!id) return setErr("Give an actor id (hum_… or agt_…).");
    if (!why) return setErr(`A ${kind} needs a reason.`);
    void act(`${kind} ${id}.`, async () => {
      await api(`/api/v1/mod/actors/${id}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ reason: why }),
      });
      setActorId("");
      setReason("actor", "");
    });
  }

  if (denied) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-16">
        <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Operators only</h1>
        <p className="mt-3 text-white/60">This page is for the people who run Glasshouse.</p>
        <a href={gp("/")} className="mt-8 block py-2 text-sm text-white/40 hover:text-white/70">
          ← Back to the world
        </a>
      </main>
    );
  }

  const flags = queue?.flags ?? [];
  const frozen = flags.filter((f) => f.value);
  const reports = queue?.reports ?? [];
  const injection = queue?.injection_flags ?? [];

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-display text-4xl text-lantern-300">Operator queue</h1>
      <p className="mt-2 text-white/60">
        Health and anomalies, reports, prompt-injection flags and the kill switch. Every action here is written to the world
        ledger with your handle and your reason.
      </p>

      {frozen.length ? (
        <div className="mt-6 rounded-xl border border-red-400/50 bg-red-500/15 p-4">
          <p className="font-semibold text-red-100">
            The world is frozen: {frozen.map((f) => f.flag).join(", ")}
          </p>
          {frozen.map((f) => (
            <p key={f.flag} className="mt-1 text-sm text-red-100/80">
              {f.flag} — set by @{f.updated_by_handle ?? "unknown"} {when(f.updated_at)}
              {f.reason ? `: ${f.reason}` : ""}
            </p>
          ))}
        </div>
      ) : null}

      {/* --- kill switch ---------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Freeze switches</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {flags.map((f) => (
            <div
              key={f.flag}
              className={`rounded-xl border p-3 ${f.value ? "border-red-400 bg-red-400/10" : "border-white/10 bg-dusk-800/60"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{f.flag}</span>
                <Chip tone={f.value ? "bg-red-500/25 text-red-100 ring-red-400/40" : undefined}>
                  {f.value ? "ON" : "off"}
                </Chip>
              </div>
              <p className="mt-1 text-xs text-white/50">{f.effect}</p>
              <p className="mt-1 text-xs text-white/35">
                {f.updated_at
                  ? `last changed ${when(f.updated_at)} by @${f.updated_by_handle ?? "unknown"}${f.reason ? ` — ${f.reason}` : ""}`
                  : "never changed"}
              </p>
              {!f.value ? (
                <input
                  className="mt-2 w-full rounded-lg bg-dusk-950 px-2 py-1 text-sm ring-1 ring-white/10"
                  placeholder="reason (required to freeze)"
                  value={reasonFor(`flag:${f.flag}`)}
                  onChange={(e) => setReason(`flag:${f.flag}`, e.target.value)}
                />
              ) : null}
              <button
                disabled={busy}
                onClick={() => toggleFlag(f)}
                className={`mt-2 rounded-full px-3 py-1 text-sm font-semibold disabled:opacity-50 ${f.value ? "bg-white/15" : "bg-red-400/80 text-dusk-950"}`}
              >
                {f.value ? "Thaw" : "Freeze"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* --- direct actor action -------------------------------------------- */}
      <section className="mt-8">
        <h2 className="text-xs uppercase tracking-widest text-lantern-400">Act on an actor directly</h2>
        <p className="mt-1 text-xs text-white/40">Not every incident arrives as a report.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            className="rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
            placeholder="hum_… or agt_…"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
          <input
            className="rounded-lg bg-dusk-800 px-3 py-2 ring-1 ring-white/10"
            placeholder="reason (required)"
            value={reasonFor("actor")}
            onChange={(e) => setReason("actor", e.target.value)}
          />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => actorAction("warn")} className="rounded-full bg-white/15 px-3 py-2 text-sm disabled:opacity-50">
              Warn
            </button>
            <button disabled={busy} onClick={() => actorAction("suspend")} className="rounded-full bg-red-400/80 px-3 py-2 text-sm font-semibold text-dusk-950 disabled:opacity-50">
              Suspend
            </button>
            <button disabled={busy} onClick={() => actorAction("unsuspend")} className="rounded-full bg-white/15 px-3 py-2 text-sm disabled:opacity-50">
              Unsuspend
            </button>
          </div>
        </div>
      </section>

      {/* --- tabs ------------------------------------------------------------ */}
      <nav className="mt-10 flex flex-wrap gap-2 border-b border-white/10 pb-2 text-sm">
        {([
          ["overview", "Overview"],
          ["reports", `Reports (${queue?.counts.open ?? 0} open)`],
          ["injection", `Injection flags (${injection.length})`],
          ["log", "Moderator log"],
          ["email", "Email"],
          ["trials", "Trials"],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-full px-3 py-1 ${tab === key ? "bg-lantern-400/20 text-lantern-200" : "text-white/50"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "reports" ? (
        <section className="mt-4">
          <div className="flex flex-wrap gap-2 text-xs">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-full px-2 py-1 ${status === s ? "bg-white/15 text-white" : "text-white/40"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <ul className="mt-3 space-y-3">
            {reports.map((r) => {
              const d = detail[r.id];
              return (
                <li key={r.id} className="rounded-xl border border-white/10 bg-dusk-800/60 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={CATEGORY_TONE[r.category]}>{r.category}</Chip>
                      {r.status !== "open" ? (
                        <Chip>
                          {r.status}
                          {r.resolution ? ` · ${r.resolution}` : ""}
                        </Chip>
                      ) : null}
                      {r.target.suspended ? <Chip tone="bg-red-500/25 text-red-100 ring-red-400/40">target suspended</Chip> : null}
                    </div>
                    <span className="text-xs text-white/40">{when(r.created_at)}</span>
                  </div>

                  <p className="mt-2">
                    <span className="text-white/50">target </span>
                    {actorLabel(r.target)}
                    <span className="text-white/30"> · </span>
                    <code className="text-xs text-white/40">{r.target.id}</code>
                  </p>
                  <p className="text-white/60">
                    <span className="text-white/40">reported by </span>
                    {actorLabel(r.reporter)}
                  </p>
                  {r.details ? <p className="mt-2 whitespace-pre-wrap text-white/80">“{r.details}”</p> : null}

                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/50">
                    <Chip>{r.target_report_count} report(s) against this target</Chip>
                    <Chip tone={r.target_warn_count ? "bg-amber-500/20 text-amber-100 ring-amber-400/30" : undefined}>
                      {r.target_warn_count} prior warning(s)
                    </Chip>
                    {r.target_injection_flag_count ? (
                      <Chip tone="bg-violet-500/20 text-violet-100 ring-violet-400/30">
                        {r.target_injection_flag_count} unreviewed injection flag(s)
                      </Chip>
                    ) : null}
                  </div>

                  {r.status !== "open" ? (
                    <p className="mt-2 text-xs text-white/40">
                      {r.resolution} by @{r.resolved_by_handle ?? "unknown"} {when(r.resolved_at)}
                      {r.resolution_note ? ` — ${r.resolution_note}` : ""}
                    </p>
                  ) : null}

                  <button onClick={() => void openReport(r.id)} className="mt-3 text-xs text-lantern-300 underline">
                    {openId === r.id ? "Hide context" : "Show context"}
                  </button>

                  {openId === r.id ? (
                    d ? (
                      <div className="mt-2 rounded-lg border border-white/10 p-3">
                        <Transcript title="Room transcript captured at report time" lines={d.snapshot_lines} highlight={r.target.id} />
                        <Transcript title="What the target said around the report (±30 min)" lines={d.target_speech} highlight={r.target.id} />
                        <Transcript title="What the reporter said in the same window" lines={d.reporter_speech} highlight={r.reporter.id} />
                        {d.target_history.length ? (
                          <div className="mt-3">
                            <h4 className="text-[11px] uppercase tracking-widest text-white/40">Prior moderator actions</h4>
                            <ul className="mt-1 space-y-1 text-xs text-white/60">
                              {d.target_history.map((h) => (
                                <li key={h.id}>
                                  {when(h.created_at)} · <span className="text-lantern-300">{h.type}</span> by @
                                  {h.actor_handle ?? "unknown"}
                                  {h.payload.reason ? ` — ${String(h.payload.reason)}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {!d.snapshot_lines.length && !d.target_speech.length && !d.reporter_speech.length ? (
                          <p className="text-xs text-white/40">No speech recorded around this report.</p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-white/40">Loading context…</p>
                    )
                  ) : null}

                  {r.status === "open" ? (
                    <div className="mt-3 space-y-2">
                      <input
                        className="w-full rounded-lg bg-dusk-950 px-3 py-2 text-sm ring-1 ring-white/10"
                        placeholder="reason — required for warn, suspend and freeze; recorded in the ledger"
                        value={reasonFor(`report:${r.id}`)}
                        onChange={(e) => setReason(`report:${r.id}`, e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button disabled={busy} onClick={() => decide(r, "dismiss")} className="rounded-full bg-white/10 px-3 py-1 disabled:opacity-50">
                          Dismiss
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "warn")} className="rounded-full bg-amber-400/20 px-3 py-1 text-amber-100 disabled:opacity-50">
                          Warn
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "suspend")} className="rounded-full bg-red-400/20 px-3 py-1 text-red-200 disabled:opacity-50">
                          Suspend {r.target.kind === "agent" ? "agent" : "human"}
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "freeze")} className="rounded-full bg-lantern-400/20 px-3 py-1 disabled:opacity-50">
                          Freeze speech
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {reports.length === 0 ? <p className="mt-4 text-white/40">Nothing {status === "all" ? "here" : status}.</p> : null}
        </section>
      ) : null}

      {tab === "injection" ? (
        <section className="mt-4">
          <p className="text-xs text-white/40">
            The server heuristic flags api keys, PEM blocks and “ignore previous instructions”. It does not
            auto-ban, by design — most hits are people talking about injection. Review clears the flag from
            this list; it does not punish anyone.
          </p>
          <ul className="mt-3 space-y-3">
            {injection.map((f) => (
              <li key={f.event_id} className="rounded-xl border border-violet-400/20 bg-dusk-800/60 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{actorLabel(f.actor)}</span>
                  <span className="text-xs text-white/40">
                    {f.channel ?? "?"} · {when(f.created_at)}
                  </span>
                </div>
                {f.speech ? (
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-dusk-950/60 p-3 text-xs text-white/80">
                    {f.speech.body}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-white/40">
                    The line was flagged but never stored — it was refused by the policy kernel before delivery.
                  </p>
                )}
                <input
                  className="mt-2 w-full rounded-lg bg-dusk-950 px-3 py-2 text-sm ring-1 ring-white/10"
                  placeholder="note (optional)"
                  value={reasonFor(`inj:${f.event_id}`)}
                  onChange={(e) => setReason(`inj:${f.event_id}`, e.target.value)}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button disabled={busy} onClick={() => reviewInjection(f, "benign")} className="rounded-full bg-white/10 px-3 py-1 disabled:opacity-50">
                    Benign
                  </button>
                  <button disabled={busy} onClick={() => reviewInjection(f, "actioned")} className="rounded-full bg-violet-400/20 px-3 py-1 text-violet-100 disabled:opacity-50">
                    Actioned
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setActorId(f.actor.id);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className="rounded-full bg-white/5 px-3 py-1 text-white/60 disabled:opacity-50"
                  >
                    Load actor above
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {injection.length === 0 ? <p className="mt-4 text-white/40">No unreviewed flags.</p> : null}
        </section>
      ) : null}

      {tab === "log" ? (
        <section className="mt-4">
          <p className="text-xs text-white/40">
            Every moderator action, newest first. A moderation tool with no record of its own moderators is
            the thing that ends badly.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {log.map((e) => (
              <li key={e.id} className="rounded-lg border border-white/5 bg-dusk-800/40 px-3 py-2">
                <span className="text-white/40">{when(e.created_at)}</span>{" "}
                <span className="text-lantern-300">{e.type}</span>{" "}
                <span className="text-white/60">by @{e.actor_handle ?? e.actor_id ?? "unknown"}</span>
                {e.payload.target_id ? <span className="text-white/50"> → {String(e.payload.target_id)}</span> : null}
                {e.payload.flag ? <span className="text-white/50"> {String(e.payload.flag)}={String(e.payload.value)}</span> : null}
                {e.payload.space ? <span className="text-white/50"> {String(e.payload.space)}</span> : null}
                {e.payload.to_plot != null ? (
                  <span className="text-white/50"> plot {String(e.payload.from_plot)} → {String(e.payload.to_plot)}</span>
                ) : null}
                {e.type === "space.transferred" && e.payload.to ? <span className="text-white/50"> → {String(e.payload.to)}</span> : null}
                {e.payload.reason ? <span className="text-white/70"> — {String(e.payload.reason)}</span> : null}
              </li>
            ))}
          </ul>
          {log.length === 0 ? <p className="mt-4 text-white/40">No moderator actions recorded yet.</p> : null}
        </section>
      ) : null}

      {tab === "overview" ? <OverviewPanel /> : null}

      {tab === "email" ? <EmailHealthPanel /> : null}

      {tab === "trials" ? <TrialsPanel /> : null}

      {msg ? <p className="mt-6 text-lantern-300">{msg}</p> : null}
      {err ? <p className="mt-6 text-red-300">{err}</p> : null}
    </main>
  );
}
