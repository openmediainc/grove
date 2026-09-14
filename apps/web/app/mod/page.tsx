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
import { ErrorNotice } from "@/components/ErrorNotice";
import { Tabs, tabPanelProps } from "@/components/Tabs";
import {
  CARD_CLASS,
  EMPTY_CLASS,
  INPUT_CLASS,
  LINK_CLASS,
  PAGE_TITLE_CLASS,
  PILL_CLASS,
  SECTION_TITLE_CLASS,
  buttonClass,
  tabClass,
} from "@/lib/brand-ui";

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
  /** 041: a report about a board post names it here. */
  target_kind?: string | null;
  board_post?: {
    id: string;
    kind: string;
    caption: string | null;
    link_url: string | null;
    link_title: string | null;
    image_url: string | null;
    hidden_by_mod: boolean;
    hidden_reason: string | null;
    space_slug: string;
    space_name: string;
  } | null;
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
/** The words carry the category; only the two most severe bands add a tone. */
const CATEGORY_TONE: Record<string, string> = {
  illegal: "border-danger-ink/60 bg-danger-ink/5 text-danger-ink",
  harassment: "border-signal/60 bg-signal/10 text-ink",
  impersonation: "border-line-strong text-ink",
  prompt_injection: "border-line-strong text-ink",
  spam: "border-line-strong text-ink",
  other: "border-line text-muted",
};

const TONE_DANGER = "border-danger-ink/60 bg-danger-ink/5 text-danger-ink";
const TONE_WARN = "border-signal/60 bg-signal/10 text-ink";

function Chip({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`${PILL_CLASS} ${tone ?? "border-line text-muted"}`}>{children}</span>;
}

const MOD_TABS = ["overview", "reports", "injection", "log", "email", "trials"] as const;

function Transcript({ title, lines, highlight }: { title: string; lines: Line[]; highlight: string }) {
  if (!lines.length) return null;
  return (
    <div className="mt-3">
      <h4 className="gh-label text-muted">{title}</h4>
      <ol className="mt-1 max-h-64 space-y-1 overflow-y-auto rounded-gh-md border border-line bg-surface p-3 text-xs">
        {lines.map((l) => (
          <li key={`${l.id}-${l.created_at}`} className={l.sender_id === highlight ? "text-ink" : "text-muted"}>
            <span className="text-muted">{when(l.created_at)} </span>
            <span className="font-semibold text-ink">{l.sender_name}</span>
            {l.room_id ? <span className="text-muted"> in {l.room_id}</span> : null}
            <span className="text-muted">: </span>
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
  const [err, setErr] = useState<unknown>(null);
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
      .catch((e) => setErr(e));
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
      setErr(e);
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
      setErr(e);
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
        <h1 className={PAGE_TITLE_CLASS}>Operators only</h1>
        <p className="mt-3 text-muted">This page is for the people who run Glasshouse.</p>
        <a href={gp("/")} className="mt-8 inline-block py-2 text-sm text-muted hover:text-ink">
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
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-12">
      <h1 className={PAGE_TITLE_CLASS}>Operator queue</h1>
      <p className="mt-2 text-muted">
        Health and anomalies, reports, prompt-injection flags and the kill switch. Every action here is written to the world
        ledger with your handle and your reason.
      </p>

      {frozen.length ? (
        <div role="status" className="mt-6 rounded-gh-lg border border-danger-ink/60 bg-danger-ink/5 p-4">
          <p className="font-semibold text-danger-ink">
            The world is frozen: {frozen.map((f) => f.flag).join(", ")}
          </p>
          {frozen.map((f) => (
            <p key={f.flag} className="mt-1 text-sm text-danger-ink">
              {f.flag} — set by @{f.updated_by_handle ?? "unknown"} {when(f.updated_at)}
              {f.reason ? `: ${f.reason}` : ""}
            </p>
          ))}
        </div>
      ) : null}

      {/* --- kill switch ---------------------------------------------------- */}
      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Freeze switches</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {flags.map((f) => (
            <div
              key={f.flag}
              className={`rounded-gh-lg border p-3 shadow-gh-1 ${f.value ? "border-danger-ink/60 bg-danger-ink/5" : "border-line bg-surface-raised"}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-brand-mono text-gh-sm text-ink">{f.flag}</span>
                <Chip tone={f.value ? TONE_DANGER : undefined}>
                  {f.value ? "ON" : "off"}
                </Chip>
              </div>
              <p className="mt-1 text-xs text-muted">{f.effect}</p>
              <p className="mt-1 text-xs text-muted">
                {f.updated_at
                  ? `last changed ${when(f.updated_at)} by @${f.updated_by_handle ?? "unknown"}${f.reason ? ` — ${f.reason}` : ""}`
                  : "never changed"}
              </p>
              {!f.value ? (
                <input
                  className={`mt-2 ${INPUT_CLASS}`}
                  aria-label={`Reason to freeze ${f.flag}`}
                  placeholder="reason (required to freeze)"
                  value={reasonFor(`flag:${f.flag}`)}
                  onChange={(e) => setReason(`flag:${f.flag}`, e.target.value)}
                />
              ) : null}
              <button
                disabled={busy}
                onClick={() => toggleFlag(f)}
                className={buttonClass(f.value ? "secondary" : "danger", "sm", "mt-2")}
              >
                {f.value ? "Thaw" : "Freeze"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* --- direct actor action -------------------------------------------- */}
      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>Act on an actor directly</h2>
        <p className="mt-1 text-xs text-muted">Not every incident arrives as a report.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input
            className={INPUT_CLASS}
            aria-label="Actor id"
            placeholder="hum_… or agt_…"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
          <input
            className={INPUT_CLASS}
            aria-label="Reason"
            placeholder="reason (required)"
            value={reasonFor("actor")}
            onChange={(e) => setReason("actor", e.target.value)}
          />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => actorAction("warn")} className={buttonClass("secondary")}>
              Warn
            </button>
            <button disabled={busy} onClick={() => actorAction("suspend")} className={buttonClass("danger")}>
              Suspend
            </button>
            <button disabled={busy} onClick={() => actorAction("unsuspend")} className={buttonClass("ghost")}>
              Unsuspend
            </button>
          </div>
        </div>
      </section>

      {/* --- tabs ------------------------------------------------------------ */}
      <Tabs
        label="Operator"
        tabs={MOD_TABS}
        current={tab}
        onChoose={setTab}
        labels={{
          overview: "Overview",
          reports: `Reports (${queue?.counts.open ?? 0} open)`,
          injection: `Injection flags (${injection.length})`,
          log: "Moderator log",
          email: "Email",
          trials: "Trials",
        }}
      />
      <div {...tabPanelProps("Operator", tab)} className="focus-visible:outline-none">

      {tab === "reports" ? (
        <section className="mt-4">
          <div className="flex flex-wrap gap-1 border-b border-line" role="group" aria-label="Report status">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={tabClass(status === s)}
              >
                {s}
              </button>
            ))}
          </div>
          <ul className="mt-3 space-y-3">
            {reports.map((r) => {
              const d = detail[r.id];
              return (
                <li key={r.id} className={`${CARD_CLASS} text-sm`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={CATEGORY_TONE[r.category]}>{r.category}</Chip>
                      {r.status !== "open" ? (
                        <Chip>
                          {r.status}
                          {r.resolution ? ` · ${r.resolution}` : ""}
                        </Chip>
                      ) : null}
                      {r.target.suspended ? <Chip tone={TONE_DANGER}>target suspended</Chip> : null}
                    </div>
                    <span className="font-brand-mono text-xs tabular-nums text-muted">{when(r.created_at)}</span>
                  </div>

                  <p className="mt-2 text-ink">
                    <span className="text-muted">target </span>
                    {actorLabel(r.target)}
                    <span className="text-muted"> · </span>
                    <code className="text-xs text-muted">{r.target.id}</code>
                  </p>
                  <p className="text-muted">
                    <span className="text-muted">reported by </span>
                    {actorLabel(r.reporter)}
                  </p>
                  {r.details ? <p className="mt-2 whitespace-pre-wrap text-ink">“{r.details}”</p> : null}
                  {r.target_kind === "board_post" ? (
                    r.board_post ? (
                      <div className="mt-3 rounded-gh-md border border-line bg-surface p-3">
                        <p className="text-xs text-muted">
                          Board post ({r.board_post.kind}) in{" "}
                          <a className={LINK_CLASS} href={gp(`/s/${encodeURIComponent(r.board_post.space_slug)}`)}>
                            {r.board_post.space_name}
                          </a>
                          {r.board_post.hidden_by_mod ? (
                            <span className="text-danger-ink"> · hidden{r.board_post.hidden_reason ? ` — ${r.board_post.hidden_reason}` : ""}</span>
                          ) : null}
                        </p>
                        {r.board_post.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- operator-only API route, never cached
                          <img src={gp(r.board_post.image_url)} alt="Reported image" className="mt-2 max-h-64 max-w-full rounded-gh-sm object-contain" />
                        ) : null}
                        {r.board_post.link_url ? (
                          <p className="mt-2 break-all text-xs text-muted">
                            {r.board_post.link_title ? `${r.board_post.link_title} — ` : ""}
                            {r.board_post.link_url}
                          </p>
                        ) : null}
                        {r.board_post.caption ? <p className="mt-2 whitespace-pre-wrap text-ink">{r.board_post.caption}</p> : null}
                        <button
                          disabled={busy}
                          onClick={() => {
                            const post = r.board_post!;
                            const why = reasonFor(`report:${r.id}`).trim();
                            if (!post.hidden_by_mod && !why) {
                              setErr("Write a reason before hiding a post.");
                              return;
                            }
                            void act(post.hidden_by_mod ? "Post restored." : "Post hidden.", () =>
                              api(`/api/v1/mod/board/posts/${encodeURIComponent(post.id)}/hide`, {
                                method: "POST",
                                body: JSON.stringify({ hidden: !post.hidden_by_mod, reason: why || undefined }),
                              }),
                            );
                          }}
                          className={buttonClass("danger", "sm", "mt-2")}
                        >
                          {r.board_post.hidden_by_mod ? "Unhide post" : "Hide post"}
                        </button>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted">The reported board post has been deleted.</p>
                    )
                  ) : null}

                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                    <Chip>{r.target_report_count} report(s) against this target</Chip>
                    <Chip tone={r.target_warn_count ? TONE_WARN : undefined}>
                      {r.target_warn_count} prior warning(s)
                    </Chip>
                    {r.target_injection_flag_count ? (
                      <Chip tone="border-line-strong text-ink">
                        {r.target_injection_flag_count} unreviewed injection flag(s)
                      </Chip>
                    ) : null}
                  </div>

                  {r.status !== "open" ? (
                    <p className="mt-2 text-xs text-muted">
                      {r.resolution} by @{r.resolved_by_handle ?? "unknown"} {when(r.resolved_at)}
                      {r.resolution_note ? ` — ${r.resolution_note}` : ""}
                    </p>
                  ) : null}

                  <button onClick={() => void openReport(r.id)} className={`mt-3 text-xs ${LINK_CLASS}`}>
                    {openId === r.id ? "Hide context" : "Show context"}
                  </button>

                  {openId === r.id ? (
                    d ? (
                      <div className="mt-2 rounded-gh-md border border-line bg-surface p-3">
                        <Transcript title="Room transcript captured at report time" lines={d.snapshot_lines} highlight={r.target.id} />
                        <Transcript title="What the target said around the report (±30 min)" lines={d.target_speech} highlight={r.target.id} />
                        <Transcript title="What the reporter said in the same window" lines={d.reporter_speech} highlight={r.reporter.id} />
                        {d.target_history.length ? (
                          <div className="mt-3">
                            <h4 className="gh-label text-muted">Prior moderator actions</h4>
                            <ul className="mt-1 space-y-1 text-xs text-muted">
                              {d.target_history.map((h) => (
                                <li key={h.id}>
                                  {when(h.created_at)} · <span className="text-ink">{h.type}</span> by @
                                  {h.actor_handle ?? "unknown"}
                                  {h.payload.reason ? ` — ${String(h.payload.reason)}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {!d.snapshot_lines.length && !d.target_speech.length && !d.reporter_speech.length ? (
                          <p className="text-xs text-muted">No speech recorded around this report.</p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted">Loading context…</p>
                    )
                  ) : null}

                  {r.status === "open" ? (
                    <div className="mt-3 space-y-2">
                      <input
                        className={INPUT_CLASS}
                        aria-label="Reason"
                        placeholder="reason — required for warn, suspend and freeze; recorded in the ledger"
                        value={reasonFor(`report:${r.id}`)}
                        onChange={(e) => setReason(`report:${r.id}`, e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button disabled={busy} onClick={() => decide(r, "dismiss")} className={buttonClass("ghost", "sm")}>
                          Dismiss
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "warn")} className={buttonClass("secondary", "sm")}>
                          Warn
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "suspend")} className={buttonClass("danger", "sm")}>
                          Suspend {r.target.kind === "agent" ? "agent" : "human"}
                        </button>
                        <button disabled={busy} onClick={() => decide(r, "freeze")} className={buttonClass("secondary", "sm")}>
                          Freeze speech
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {reports.length === 0 ? <p className={`mt-4 ${EMPTY_CLASS}`}>No {status === "all" ? "" : `${status} `}reports.</p> : null}
        </section>
      ) : null}

      {tab === "injection" ? (
        <section className="mt-4">
          <p className="text-xs text-muted">
            The server heuristic flags api keys, PEM blocks and “ignore previous instructions”. It does not
            auto-ban, by design — most hits are people talking about injection. Review clears the flag from
            this list; it does not punish anyone.
          </p>
          <ul className="mt-3 space-y-3">
            {injection.map((f) => (
              <li key={f.event_id} className={`${CARD_CLASS} text-sm`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ink">{actorLabel(f.actor)}</span>
                  <span className="font-brand-mono text-xs tabular-nums text-muted">
                    {f.channel ?? "?"} · {when(f.created_at)}
                  </span>
                </div>
                {f.speech ? (
                  <p className="mt-2 whitespace-pre-wrap rounded-gh-md border border-line bg-surface p-3 font-brand-mono text-xs text-ink">
                    {f.speech.body}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted">
                    The line was flagged but never stored — it was refused by the policy kernel before delivery.
                  </p>
                )}
                <input
                  className={`mt-2 ${INPUT_CLASS}`}
                  aria-label="Review note"
                  placeholder="note (optional)"
                  value={reasonFor(`inj:${f.event_id}`)}
                  onChange={(e) => setReason(`inj:${f.event_id}`, e.target.value)}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button disabled={busy} onClick={() => reviewInjection(f, "benign")} className={buttonClass("secondary", "sm")}>
                    Benign
                  </button>
                  <button disabled={busy} onClick={() => reviewInjection(f, "actioned")} className={buttonClass("secondary", "sm")}>
                    Actioned
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setActorId(f.actor.id);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className={buttonClass("ghost", "sm")}
                  >
                    Load actor above
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {injection.length === 0 ? <p className={`mt-4 ${EMPTY_CLASS}`}>No unreviewed flags.</p> : null}
        </section>
      ) : null}

      {tab === "log" ? (
        <section className="mt-4">
          <p className="text-xs text-muted">
            Every moderator action, newest first. A moderation tool with no record of its own moderators is
            the thing that ends badly.
          </p>
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-gh-lg border border-line bg-surface-raised text-sm">
            {log.map((e) => (
              <li key={e.id} className="break-words px-3 py-2">
                <span className="font-brand-mono text-xs tabular-nums text-muted">{when(e.created_at)}</span>{" "}
                <span className="text-ink">{e.type}</span>{" "}
                <span className="text-muted">by @{e.actor_handle ?? e.actor_id ?? "unknown"}</span>
                {e.payload.target_id ? <span className="text-muted"> → {String(e.payload.target_id)}</span> : null}
                {e.payload.flag ? <span className="text-muted"> {String(e.payload.flag)}={String(e.payload.value)}</span> : null}
                {e.payload.space ? <span className="text-muted"> {String(e.payload.space)}</span> : null}
                {e.payload.to_plot != null ? (
                  <span className="text-muted"> plot {String(e.payload.from_plot)} → {String(e.payload.to_plot)}</span>
                ) : null}
                {e.type === "space.transferred" && e.payload.to ? <span className="text-muted"> → {String(e.payload.to)}</span> : null}
                {e.payload.reason ? <span className="text-muted"> — {String(e.payload.reason)}</span> : null}
              </li>
            ))}
          </ul>
          {log.length === 0 ? <p className={`mt-4 ${EMPTY_CLASS}`}>No moderator actions recorded yet.</p> : null}
        </section>
      ) : null}

      {tab === "overview" ? <OverviewPanel /> : null}

      {tab === "email" ? <EmailHealthPanel /> : null}

      {tab === "trials" ? <TrialsPanel /> : null}
      </div>

      {msg ? (
        <p role="status" className="mt-6 text-gh-sm text-success">
          {msg}
        </p>
      ) : null}
      <ErrorNotice error={err} className="mt-6" />
    </main>
  );
}
