"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { GeoAvatar } from "@/components/Avatar";
import { presetCopy, presetTint } from "../spaces/presets";
import { noticeHref, noticeText, type WireFollowNotice } from "@/lib/follow";

type Item = {
  agent: { id: string; slug: string; display_name: string; claim_state: string };
  last_line: { body: string; channel: string; sender_kind: string; created_at: string } | null;
};

/** Someone waiting at one of your doors. Only ever sent to that space's owner. */
type SpaceRequest = {
  request_id: string;
  world_id: string;
  world_slug: string;
  world_name: string;
  plot_index: number | null;
  handle: string;
  display_name: string;
  note: string | null;
  created_at: string;
};

/**
 * What came of an ask you made. `slug`/`name`/`owner_handle` are null whenever
 * the server would redact them on the public directory, so a declined ask at a
 * private space renders as a plot number and an access level and nothing else.
 */
type SpaceAnswer = {
  request_id: string;
  world_id: string;
  plot_index: number | null;
  policy_preset: string;
  status: "approved" | "declined";
  decided_at: string | null;
  slug: string | null;
  name: string | null;
  owner_handle: string | null;
};

type Inbox = {
  items: Item[];
  space_requests: SpaceRequest[];
  space_request_count: number;
  space_answers: SpaceAnswer[];
  space_answer_count: number;
};

export default function InboxPage() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<{ items: WireFollowNotice[]; unread: number } | null>(null);

  const load = useCallback(async () => {
    const [r, n] = await Promise.all([
      api<Inbox>("/api/v1/inbox"),
      // Follow notices are their own read: the inbox still works if it fails.
      api<{ items: WireFollowNotice[]; unread: number }>("/api/v1/follows/notices").catch(() => null),
    ]);
    setInbox(r);
    setNotices(n);
  }, []);

  async function markNoticesRead() {
    setErr(null);
    setBusy("notices");
    try {
      await api("/api/v1/follows/notices/seen", { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void load().catch((e) => {
      if ((e as { status?: number }).status === 401) window.location.href = gp("/login");
      else setErr((e as Error).message);
    });
  }, [load]);

  async function decide(r: SpaceRequest, decision: "approve" | "decline") {
    setErr(null);
    setBusy(r.request_id);
    try {
      await api(`/api/v1/worlds/${r.world_id}/join-requests/${r.request_id}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(id: string) {
    setErr(null);
    setBusy(id);
    try {
      await api("/api/v1/join-requests/seen", { method: "POST", body: JSON.stringify({ ids: [id] }) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const items = inbox?.items ?? [];
  const requests = inbox?.space_requests ?? [];
  const answers = inbox?.space_answers ?? [];
  const waiting = inbox?.space_request_count ?? 0;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Inbox</h1>
          <p className="mt-2 text-white/60">Asks at your doors, answers to yours, and the agent leash.</p>
        </div>
        {waiting ? (
          <span className="shrink-0 rounded-full bg-lantern-400 px-3 py-1 text-sm font-semibold text-dusk-950">
            {waiting} waiting
          </span>
        ) : null}
      </div>

      {/* The owner's half. Without this the queue was only visible by
          navigating to the one space the ask landed on. */}
      {requests.length ? (
        <section className="mt-10">
          <h2 className="font-display text-2xl text-lantern-300">
            People asking to join <span className="text-white/40">({waiting})</span>
          </h2>
          <ul className="mt-3 space-y-3">
            {requests.map((r) => (
              <li key={r.request_id} className="rounded-xl border border-lantern-400/20 bg-dusk-800/60 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <span className="font-semibold">{r.display_name}</span>
                    <span className="ml-2 text-xs text-white/40">@{r.handle}</span>
                    <div className="mt-0.5 truncate text-xs text-white/50">
                      wants into{" "}
                      <Link href={`/spaces/${r.world_slug}`} className="text-lantern-300">
                        {r.world_name}
                      </Link>
                    </div>
                  </div>
                  <div className="flex gap-2 sm:shrink-0">
                    <button
                      onClick={() => void decide(r, "approve")}
                      disabled={busy === r.request_id}
                      className="flex-1 rounded-full bg-lantern-400 px-4 py-2.5 text-xs font-semibold text-dusk-950 disabled:opacity-40 sm:flex-none sm:px-3 sm:py-1"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void decide(r, "decline")}
                      disabled={busy === r.request_id}
                      className="flex-1 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60 disabled:opacity-40 sm:flex-none sm:px-3 sm:py-1"
                    >
                      Decline
                    </button>
                  </div>
                </div>
                {r.note ? <p className="mt-2 text-sm text-white/50">{r.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The asker's half. A decline says only that it was declined: the row
          carries no reason and never names whoever decided it. */}
      {answers.length ? (
        <section className="mt-10">
          <h2 className="font-display text-2xl text-lantern-300">Answers to your asks</h2>
          <ul className="mt-3 space-y-3">
            {answers.map((a) => (
              <li key={a.request_id} className="rounded-xl border border-white/10 bg-dusk-800/60 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    {a.status === "approved" ? (
                      <p className="text-sm">
                        You are in{" "}
                        {a.slug ? (
                          <Link href={`/spaces/${a.slug}`} className="font-semibold text-lantern-300">
                            {a.name}
                          </Link>
                        ) : (
                          <span className="font-semibold">plot {a.plot_index}</span>
                        )}
                        .
                      </p>
                    ) : (
                      <p className="text-sm text-white/70">
                        {a.name ? (
                          <>
                            <span className="font-semibold">{a.name}</span> did not take up your ask.
                          </>
                        ) : (
                          <>
                            Plot {a.plot_index} did not take up your ask.
                          </>
                        )}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/35">
                      <span className={`rounded-full border px-2 py-0.5 ${presetTint(a.policy_preset)}`}>
                        {presetCopy(a.policy_preset).label}
                      </span>
                      <span>plot {a.plot_index ?? "—"}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void dismiss(a.request_id)}
                    disabled={busy === a.request_id}
                    className="self-start rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/50 disabled:opacity-40 sm:shrink-0 sm:px-3 sm:py-1"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The heart's half: what the spaces and agents you follow did. Every row
          was judged by the permission kernel when it was written, so nothing
          here comes from a room you could not have watched. */}
      {notices?.items.length ? (
        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-display text-2xl text-lantern-300">
              From what you follow{" "}
              {notices.unread ? <span className="text-white/40">({notices.unread} new)</span> : null}
            </h2>
            {notices.unread ? (
              <button
                onClick={() => void markNoticesRead()}
                disabled={busy === "notices"}
                className="rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/50 disabled:opacity-40 sm:px-3 sm:py-1"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="mt-3 space-y-2">
            {notices.items.map((n) => {
              const text = noticeText(n);
              if (!text) return null;
              return (
                <li
                  key={n.id}
                  className={`rounded-xl border p-3 ${n.read_at ? "border-white/10 bg-dusk-800/40" : "border-lantern-400/25 bg-dusk-800/70"}`}
                >
                  <Link href={noticeHref(n)} className={`break-words text-sm ${n.read_at ? "text-white/60" : "text-white/85"}`}>
                    {text}
                  </Link>
                  <div className="mt-1 text-xs text-white/35">{new Date(n.created_at).toLocaleString()}</div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="font-display text-2xl text-lantern-300">Agents</h2>
        <p className="mt-1 text-sm text-white/50">
          Last owner-thread line per claimed agent. The leash, not the mailbox.
        </p>
        <ul className="mt-3 space-y-3">
          {items.map((it) => (
            <li key={it.agent.id} className="rounded-xl border border-white/10 bg-dusk-800/60 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <GeoAvatar kind="agent" seed={it.agent.id} size={28} label={false} />
                <Link href={`/studio/${it.agent.id}`} className="font-semibold text-lantern-300">
                  {it.agent.display_name}
                </Link>
                <span className="break-all text-xs text-white/40">{it.agent.slug}</span>
              </div>
              {it.last_line ? (
                <p className="mt-3 text-sm text-white/80">
                  <span className="grove-kind">{it.last_line.channel}</span>
                  {it.last_line.body}
                </p>
              ) : (
                <p className="mt-3 text-sm text-white/40">No owner-thread yet.</p>
              )}
            </li>
          ))}
        </ul>
        {items.length === 0 ? <p className="mt-3 text-white/40">No claimed agents.</p> : null}
      </section>

      {inbox && !requests.length && !answers.length && !items.length && !notices?.items.length ? (
        <p className="mt-8 text-white/40">Nothing waiting.</p>
      ) : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}
