"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { spaceHref } from "@/lib/space-page";
import {
  PREVIEW_ASPECT,
  canOfferTransfer,
  canRelocate,
  previewCells,
  timeLeft,
  transferBody,
  type PreviewCell,
  type TransferPick,
} from "@/lib/space-moves";
import { ErrorNotice } from "@/components/ErrorNotice";

/**
 * Transfer & relocate (queue #35): two Manage sections for the space's holder,
 * and the recipient's half in the Inbox. Both acts ask the owner to type the
 * space's slug; the API checks the same thing.
 */

type Party = { human_id: string; handle: string; display_name: string };
type OrgRef = { id: string; slug: string; name: string; colour: string };

export type WireTransfer = {
  id: string;
  world_id: string;
  world_slug: string;
  world_name: string;
  plot_index: number | null;
  from: Party;
  to: Party;
  to_org: OrgRef | null;
  from_leaves: boolean;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

type TransferState = {
  pending: WireTransfer | null;
  last: WireTransfer | null;
  candidates: { members: Party[]; orgs: Array<OrgRef & { owner_handle: string }> };
};

type Space = { id: string; slug: string; name: string };

function Confirm({ slug, value, onChange, id }: { slug: string; value: string; onChange: (v: string) => void; id: string }) {
  return (
    <label htmlFor={id} className="mt-3 block text-xs text-white/50">
      Type <span className="font-mono text-white/80">{slug}</span> to confirm
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 block w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 font-mono text-sm text-white outline-none focus:border-lantern-400"
      />
    </label>
  );
}

const STATUS_LINE: Record<WireTransfer["status"], string> = {
  pending: "waiting",
  accepted: "accepted",
  declined: "declined",
  cancelled: "withdrawn",
  expired: "ran out",
};

function recipientLabel(t: WireTransfer): string {
  return t.to_org ? `${t.to_org.name} (@${t.to.handle} accepts for it)` : `${t.to.display_name} (@${t.to.handle})`;
}

export function TransferPanel({ space, reload }: { space: Space; reload: () => Promise<void> }) {
  const [state, setState] = useState<TransferState | null>(null);
  const [pickKey, setPickKey] = useState("");
  const [typed, setTyped] = useState("");
  const [leave, setLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async () => {
    setState(await api<TransferState>(`/api/v1/worlds/${space.id}/transfer`));
  }, [space.id]);

  useEffect(() => {
    void load().catch((e) => setErr(e));
  }, [load]);

  const pick: TransferPick = pickKey.startsWith("m:")
    ? { kind: "member", humanId: pickKey.slice(2) }
    : pickKey.startsWith("o:")
      ? { kind: "org", orgId: pickKey.slice(2) }
      : null;

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      setTyped("");
      setPickKey("");
      await load();
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const pending = state?.pending ?? null;
  const members = state?.candidates.members ?? [];
  const orgs = state?.candidates.orgs ?? [];

  return (
    <div>
      <h3 className="font-display text-xl text-lantern-300">Transfer ownership</h3>
      <p className="mt-1 text-xs text-white/55">
        Hand this space to one of its members, or to an org bound to it. They have 7 days to accept. The name, card,
        branding, marks, rooms and plot stay with the space; you stay a member unless you choose to leave.
      </p>

      {pending ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-lantern-400/30 bg-lantern-400/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-sm text-white/80">
            Offered to <strong>{recipientLabel(pending)}</strong>. {timeLeft(pending.expires_at)} left
            {pending.from_leaves ? "; you leave when they accept" : ""}.
          </p>
          <button
            disabled={busy}
            onClick={() => void run(() => api(`/api/v1/worlds/${space.id}/transfer`, { method: "DELETE" }))}
            className="shrink-0 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/70 disabled:opacity-40 sm:py-1"
          >
            Cancel offer
          </button>
        </div>
      ) : state ? (
        members.length || orgs.length ? (
          <div className="mt-3">
            <label className="block text-xs text-white/50">
              Hand it to
              <select
                value={pickKey}
                onChange={(e) => setPickKey(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm text-white"
              >
                <option value="">Pick a member or org…</option>
                {members.length ? (
                  <optgroup label="Members">
                    {members.map((m) => (
                      <option key={m.human_id} value={`m:${m.human_id}`}>
                        {m.display_name} (@{m.handle})
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {orgs.length ? (
                  <optgroup label="Bound orgs">
                    {orgs.map((o) => (
                      <option key={o.id} value={`o:${o.id}`}>
                        {o.name} (owner @{o.owner_handle})
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
            <label className="mt-2 flex items-center gap-2 py-1 text-sm text-white/60">
              <input type="checkbox" className="h-5 w-5 shrink-0 accent-lantern-400" checked={leave} onChange={(e) => setLeave(e.target.checked)} />
              Leave the space once they accept
            </label>
            <Confirm id="transfer-confirm" slug={space.slug} value={typed} onChange={setTyped} />
            <button
              disabled={!canOfferTransfer({ pick, typed, slug: space.slug, busy, pending: Boolean(pending) })}
              onClick={() =>
                pick &&
                void run(() =>
                  api(`/api/v1/worlds/${space.id}/transfer`, { method: "POST", body: JSON.stringify(transferBody(pick, typed, leave)) }),
                )
              }
              className="mt-3 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
            >
              {busy ? "Sending…" : "Offer the space"}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-white/55">
            Nobody to hand it to yet. Admit a member or bind an org someone else owns first.
          </p>
        )
      ) : null}

      {!pending && state?.last ? (
        <p className="mt-3 text-xs text-white/55">
          Last offer, to {recipientLabel(state.last)}: {STATUS_LINE[state.last.status]}.
        </p>
      ) : null}
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}

type Rect = { x0: number; y0: number; x1: number; y1: number };
type RelocationPlan = {
  current: number;
  current_rect: Rect;
  next_allowed_at: string | null;
  options: Array<{ plot_index: number; near: boolean; next_to: number | null; rect: Rect }>;
  taken: number[];
  anchors: number[];
};

const CELL_FILL: Record<PreviewCell["role"], string> = {
  core: "rgba(255,255,255,0.10)",
  taken: "rgba(255,255,255,0.22)",
  anchor: "rgba(250,204,120,0.45)",
  current: "rgba(250,204,120,0.95)",
  option: "rgba(140,200,255,0.18)",
  target: "rgba(140,200,255,0.95)",
};

function MiniPlots({ plan, target }: { plan: RelocationPlan; target: number | null }) {
  const view = previewCells({
    current: plan.current,
    taken: plan.taken,
    anchors: plan.anchors,
    options: plan.options.map((o) => o.plot_index),
    target,
  });
  const w = 14 * PREVIEW_ASPECT;
  const h = 14;
  return (
    <svg
      role="img"
      aria-label={target === null ? `Plot ${plan.current} on the world` : `Moving from plot ${plan.current} to plot ${target}`}
      viewBox={`0 0 ${view.cols * w} ${view.rows * h}`}
      className="mt-3 block h-auto w-full max-w-xs rounded-lg border border-white/10 bg-dusk-950/60"
    >
      {view.cells.map((c) => (
        <rect
          key={`${c.bx},${c.by}`}
          x={(c.bx - view.minBx) * w + 1}
          y={(c.by - view.minBy) * h + 1}
          width={w - 2}
          height={h - 2}
          rx={2}
          fill={CELL_FILL[c.role]}
        />
      ))}
    </svg>
  );
}

export function RelocatePanel({ space, reload }: { space: Space; reload: () => Promise<void> }) {
  const [plan, setPlan] = useState<RelocationPlan | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPlan(await api<RelocationPlan>(`/api/v1/worlds/${space.id}/relocate`));
  }, [space.id]);

  useEffect(() => {
    void load().catch((e) => setErr(e));
  }, [load]);

  async function move() {
    if (target === null) return;
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/worlds/${space.id}/relocate`, {
        method: "POST",
        body: JSON.stringify({ plot_index: target, confirm: typed }),
      });
      setDone(`Moved to plot ${target}.`);
      setTarget(null);
      setTyped("");
      await load();
      await reload();
    } catch (e) {
      setErr(e);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!plan) return <ErrorNotice error={err} />;
  const cooling = plan.next_allowed_at && new Date(plan.next_allowed_at).getTime() > Date.now();

  return (
    <div>
      <h3 className="font-display text-xl text-lantern-300">Move to another plot</h3>
      <p className="mt-1 text-xs text-white/55">
        The space keeps everything; only its place on the map changes, and the old plot is freed. A space can move once a
        week. Plots next to your other plots come first.
      </p>
      <MiniPlots plan={plan} target={target} />
      <p className="mt-1 text-[11px] text-white/50">
        Now on plot {plan.current}
        {plan.anchors.length ? " · gold: your other plots" : ""} · blue: free plots on offer
      </p>

      {cooling ? (
        <p className="mt-3 text-sm text-white/50">
          This space moved recently. It can move again after {new Date(plan.next_allowed_at!).toLocaleString()}.
        </p>
      ) : plan.options.length ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {plan.options.map((o) => (
              <button
                key={o.plot_index}
                onClick={() => setTarget(target === o.plot_index ? null : o.plot_index)}
                aria-pressed={target === o.plot_index}
                className={`rounded-full border px-3 py-2 text-xs sm:py-1 ${
                  target === o.plot_index ? "border-sky-300/70 bg-sky-300/10 text-sky-200" : "border-white/15 text-white/70"
                }`}
              >
                plot {o.plot_index}
                {o.near ? <span className="ml-1 text-lantern-300">· next to {o.next_to}</span> : null}
              </button>
            ))}
          </div>
          {target !== null ? (
            <>
              <Confirm id="relocate-confirm" slug={space.slug} value={typed} onChange={setTyped} />
              <button
                disabled={!canRelocate({ target, current: plan.current, typed, slug: space.slug, nextAllowedAt: plan.next_allowed_at, busy })}
                onClick={() => void move()}
                className="mt-3 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
              >
                {busy ? "Moving…" : `Move to plot ${target}`}
              </button>
            </>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-sm text-white/55">No free plot to move to right now.</p>
      )}
      {done ? <p className="mt-2 text-sm text-lantern-300">{done}</p> : null}
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}

/** The recipient's half, for the Inbox. Renders nothing when no offer waits. */
export function TransferOffers({ onChange }: { onChange?: () => void }) {
  const [offers, setOffers] = useState<WireTransfer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async () => {
    const r = await api<{ offers: WireTransfer[] }>("/api/v1/transfers/incoming");
    setOffers(r.offers ?? []);
  }, []);

  useEffect(() => {
    void load().catch(() => setOffers([]));
  }, [load]);

  async function answer(t: WireTransfer, decision: "accept" | "decline") {
    setErr(null);
    setBusy(t.id);
    try {
      await api(`/api/v1/transfers/${encodeURIComponent(t.id)}/${decision}`, { method: "POST" });
      await load();
      onChange?.();
    } catch (e) {
      setErr(e);
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  if (!offers?.length) return <ErrorNotice error={err} className="mt-4" />;
  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl text-lantern-300">
        Transfer offers <span className="text-white/55">({offers.length})</span>
      </h2>
      <ul className="mt-3 space-y-3">
        {offers.map((t) => (
          <li key={t.id} className="rounded-xl border border-lantern-400/20 bg-dusk-800/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-sm">
                <span className="font-semibold">{t.from.display_name}</span>
                <span className="ml-1 text-xs text-white/55">@{t.from.handle}</span> offers you{" "}
                <Link href={spaceHref(t.world_slug)} className="font-semibold text-lantern-300">
                  {t.world_name}
                </Link>
                {t.to_org ? <> for your org {t.to_org.name}</> : null}.
                <div className="mt-1 text-xs text-white/55">
                  plot {t.plot_index ?? "—"} · {timeLeft(t.expires_at)} left to answer
                  {t.from_leaves ? ` · @${t.from.handle} leaves when you accept` : ` · @${t.from.handle} stays a member`}
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <button
                  onClick={() => void answer(t, "accept")}
                  disabled={busy === t.id}
                  className="flex-1 rounded-full bg-lantern-400 px-4 py-2.5 text-xs font-semibold text-dusk-950 disabled:opacity-40 sm:flex-none sm:px-3 sm:py-1"
                >
                  Accept
                </button>
                <button
                  onClick={() => void answer(t, "decline")}
                  disabled={busy === t.id}
                  className="flex-1 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60 disabled:opacity-40 sm:flex-none sm:px-3 sm:py-1"
                >
                  Decline
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <ErrorNotice error={err} className="mt-2" />
    </section>
  );
}
