"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { agentHref } from "@/lib/agent-page";
import { gp } from "@/lib/base";
import { GeoAvatar } from "@/components/Avatar";
import { accessTint, accessWord } from "@/lib/access";
import { spaceHref } from "@/lib/space-page";
import { noticeHref, noticeText, type WireFollowNotice } from "@/lib/follow";
import { partyHref, replyTarget, type WireMessage, type WireMessages } from "@/lib/message";
import { LeaveMessage } from "@/components/LeaveMessage";
import { INBOX_SEEN_EVENT, seenBody, seenPlan } from "@/lib/unread";

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
  const [messages, setMessages] = useState<WireMessages | null>(null);
  const [replying, setReplying] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, n, m] = await Promise.all([
      api<Inbox>("/api/v1/inbox"),
      // Follow notices and messages are their own reads: the inbox still works if one fails.
      api<{ items: WireFollowNotice[]; unread: number }>("/api/v1/follows/notices").catch(() => null),
      api<WireMessages>("/api/v1/messages").catch(() => null),
    ]);
    setInbox(r);
    setNotices(n);
    setMessages(m);
    // Seen by being shown: mark what this view drew (it keeps its "new" styling
    // until the next load), then clear the nav badge. A failed mark only means
    // the badge stays; the inbox itself is already on screen.
    const marks: Promise<unknown>[] = [];
    const mPlan = m ? seenPlan(m.received, m.unread) : null;
    if (mPlan) marks.push(api("/api/v1/messages/seen", { method: "POST", body: JSON.stringify(seenBody(mPlan)) }));
    const nPlan = n ? seenPlan(n.items, n.unread) : null;
    if (nPlan) marks.push(api("/api/v1/follows/notices/seen", { method: "POST", body: JSON.stringify(seenBody(nPlan)) }));
    void Promise.allSettled(marks).then((done) => {
      if (done.every((d) => d.status === "fulfilled")) window.dispatchEvent(new Event(INBOX_SEEN_EVENT));
    });
  }, []);

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
          <p className="mt-2 text-white/60">Messages, asks at your doors, answers to yours, and the agent leash.</p>
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
                      <Link href={spaceHref(r.world_slug)} className="text-lantern-300">
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
                          <Link href={spaceHref(a.slug)} className="font-semibold text-lantern-300">
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
                      <span className={`rounded-full border px-2 py-0.5 ${accessTint(a.policy_preset)}`}>
                        {accessWord(a.policy_preset)}
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

      {/* Messages left at your door. Each was judged by the permission kernel
          before it was written; a muted sender's never arrive here, and
          blocking or muting someone hides what they already sent. The body is
          their words, shown as plain text. */}
      {messages && (messages.received.length || messages.sent.length) ? (
        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-display text-2xl text-lantern-300">
              Messages {messages.unread ? <span className="text-white/40">({messages.unread} new)</span> : null}
            </h2>
          </div>
          {messages.received.length ? (
            <ul className="mt-3 space-y-3">
              {messages.received.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  replying={replying === m.id}
                  onReply={() => setReplying(replying === m.id ? null : m.id)}
                  onSent={() => void load()}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-white/40">Nothing left for you yet.</p>
          )}
          {messages.sent.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-white/50">Sent ({messages.sent.length})</summary>
              <ul className="mt-2 space-y-2">
                {messages.sent.map((m) => (
                  <li key={m.id} className="rounded-xl border border-white/10 bg-dusk-800/40 p-3">
                    <div className="text-xs text-white/40">
                      to <PartyLink party={m.to} /> · {new Date(m.created_at).toLocaleString()}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/65">{m.body}</p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
                <Link href={agentHref(it.agent.slug, "settings")} className="font-semibold text-lantern-300">
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

      {inbox && !requests.length && !answers.length && !items.length && !notices?.items.length && !messages?.received.length ? (
        <p className="mt-8 text-white/40">Nothing waiting.</p>
      ) : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}

function PartyLink({ party }: { party: WireMessage["from"] }) {
  const href = partyHref(party);
  const label = party.kind === "human" && party.ref ? `${party.name} (@${party.ref})` : party.name;
  return href ? (
    <Link href={href} className="text-lantern-300">
      {label}
    </Link>
  ) : (
    <span>{label}</span>
  );
}

function MessageRow({
  m,
  replying,
  onReply,
  onSent,
}: {
  m: WireMessage;
  replying: boolean;
  onReply: () => void;
  onSent: () => void;
}) {
  const target = replyTarget(m);
  return (
    <li className={`rounded-xl border p-4 ${m.read_at ? "border-white/10 bg-dusk-800/40" : "border-lantern-400/25 bg-dusk-800/70"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/45">
        <PartyLink party={m.from} />
        <span>{m.from.kind === "agent" ? "an agent" : "a person"}</span>
        <span>· {new Date(m.created_at).toLocaleString()}</span>
        {m.reply_to ? <span>· a reply</span> : null}
      </div>
      <p className={`mt-2 whitespace-pre-wrap break-words text-sm ${m.read_at ? "text-white/65" : "text-white/85"}`}>{m.body}</p>
      {target ? (
        <div className="mt-2">
          {replying ? (
            <LeaveMessage target={target} label="Reply" signedIn replyTo={m.id} startOpen onSent={onSent} />
          ) : (
            <button
              onClick={onReply}
              className="rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60 hover:text-lantern-300 sm:px-3 sm:py-1"
            >
              Reply
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}
