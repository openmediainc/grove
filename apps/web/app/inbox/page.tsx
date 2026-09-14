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
import { TransferOffers } from "@/components/SpaceMoves";
import { INBOX_SEEN_EVENT, seenBody, seenPlan } from "@/lib/unread";
import { ErrorNotice } from "@/components/ErrorNotice";
import {
  EMPTY_CLASS,
  LINK_CLASS,
  PAGE_TITLE_CLASS,
  PILL_CLASS,
  SECTION_TITLE_CLASS,
  buttonClass,
} from "@/lib/brand-ui";

/** A framed list with hairline dividers: one row per item. */
const LIST_CLASS = "mt-3 divide-y divide-line overflow-hidden rounded-gh-lg border border-line bg-surface-raised shadow-gh-1";
const ROW_CLASS = "p-4";

/** New since you last looked: a signal dot with a word for screen readers. */
function NewDot() {
  return (
    <span className="inline-flex items-center">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-signal" />
      <span className="sr-only">new</span>
    </span>
  );
}

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
  const [err, setErr] = useState<unknown>(null);
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
      else setErr(e);
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
      setErr(e);
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
      setErr(e);
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
          <h1 className={PAGE_TITLE_CLASS}>Inbox</h1>
          <p className="mt-2 text-muted">Messages, asks at your doors, answers to yours, and the agent leash.</p>
        </div>
        {waiting ? (
          <span className="shrink-0 rounded-gh-pill border border-signal bg-surface-raised px-3 py-1 font-brand-mono text-sm tabular-nums text-ink">
            {waiting} waiting
          </span>
        ) : null}
      </div>

      {/* Spaces offered to you (#35). Accepting makes you the holder. */}
      <TransferOffers onChange={() => void load()} />

      {/* The owner's half. Without this the queue was only visible by
          navigating to the one space the ask landed on. */}
      {requests.length ? (
        <section className="mt-10">
          <h2 className={SECTION_TITLE_CLASS}>
            People asking to join <span className="font-brand-mono font-normal tabular-nums text-signal-text">({waiting})</span>
          </h2>
          <ul className={LIST_CLASS}>
            {requests.map((r) => (
              <li key={r.request_id} className={ROW_CLASS}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <span className="font-semibold text-ink">{r.display_name}</span>
                    <span className="ml-2 text-xs text-human">@{r.handle}</span>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      wants into{" "}
                      <Link href={spaceHref(r.world_slug)} className={LINK_CLASS}>
                        {r.world_name}
                      </Link>
                    </div>
                  </div>
                  <div className="flex gap-2 sm:shrink-0">
                    <button
                      onClick={() => void decide(r, "approve")}
                      disabled={busy === r.request_id}
                      className={buttonClass("primary", "md", "flex-1 sm:flex-none")}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void decide(r, "decline")}
                      disabled={busy === r.request_id}
                      className={buttonClass("secondary", "md", "flex-1 sm:flex-none")}
                    >
                      Decline
                    </button>
                  </div>
                </div>
                {r.note ? <p className="mt-2 text-sm text-muted">{r.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The asker's half. A decline says only that it was declined: the row
          carries no reason and never names whoever decided it. */}
      {answers.length ? (
        <section className="mt-10">
          <h2 className={SECTION_TITLE_CLASS}>Answers to your asks</h2>
          <ul className={LIST_CLASS}>
            {answers.map((a) => (
              <li key={a.request_id} className={ROW_CLASS}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    {a.status === "approved" ? (
                      <p className="text-sm text-ink">
                        <span className="gh-label mr-2 text-success">approved</span>
                        You are in{" "}
                        {a.slug ? (
                          <Link href={spaceHref(a.slug)} className={`font-semibold ${LINK_CLASS}`}>
                            {a.name}
                          </Link>
                        ) : (
                          <span className="font-semibold text-ink">plot {a.plot_index}</span>
                        )}
                        .
                      </p>
                    ) : (
                      <p className="text-sm text-muted">
                        <span className="gh-label mr-2 text-muted">declined</span>
                        {a.name ? (
                          <>
                            <span className="font-semibold text-ink">{a.name}</span> did not take up your ask.
                          </>
                        ) : (
                          <>
                            Plot {a.plot_index} did not take up your ask.
                          </>
                        )}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className={`${PILL_CLASS} ${accessTint(a.policy_preset)}`}>
                        {accessWord(a.policy_preset)}
                      </span>
                      <span className="font-brand-mono tabular-nums">plot {a.plot_index ?? "—"}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => void dismiss(a.request_id)}
                    disabled={busy === a.request_id}
                    className={buttonClass("ghost", "md", "self-start sm:shrink-0")}
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
            <h2 className={SECTION_TITLE_CLASS}>
              Messages{" "}
              {messages.unread ? <span className="font-brand-mono font-normal tabular-nums text-signal-text">({messages.unread} new)</span> : null}
            </h2>
          </div>
          {messages.received.length ? (
            <ul className={LIST_CLASS}>
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
            <p className={`mt-3 ${EMPTY_CLASS}`}>Nothing left for you yet.</p>
          )}
          {messages.sent.length ? (
            <details className="mt-4">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted hover:text-ink sm:min-h-8">
                Sent <span className="ml-1 font-brand-mono tabular-nums">({messages.sent.length})</span>
              </summary>
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-gh-lg border border-line bg-surface">
                {messages.sent.map((m) => (
                  <li key={m.id} className="p-3">
                    <div className="text-xs text-muted">
                      to <PartyLink party={m.to} /> · {new Date(m.created_at).toLocaleString()}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{m.body}</p>
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
            <h2 className={SECTION_TITLE_CLASS}>
              From what you follow{" "}
              {notices.unread ? <span className="font-brand-mono font-normal tabular-nums text-signal-text">({notices.unread} new)</span> : null}
            </h2>
          </div>
          <ul className={LIST_CLASS}>
            {notices.items.map((n) => {
              const text = noticeText(n);
              if (!text) return null;
              return (
                <li key={n.id} className={`flex items-start gap-2 p-3 ${n.read_at ? "" : "bg-tint/50"}`}>
                  <span className="mt-1.5 w-2 shrink-0">{n.read_at ? null : <NewDot />}</span>
                  <div className="min-w-0">
                    <Link
                      href={noticeHref(n)}
                      className={`break-words text-sm underline decoration-transparent underline-offset-2 hover:decoration-line-strong ${n.read_at ? "text-muted" : "font-medium text-ink"}`}
                    >
                      {text}
                    </Link>
                    <div className="mt-1 font-brand-mono text-xs tabular-nums text-muted">{new Date(n.created_at).toLocaleString()}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>Agents</h2>
        <p className="mt-1 text-sm text-muted">
          Last owner-thread line per claimed agent. The leash, not the mailbox.
        </p>
        {items.length ? (
        <ul className={LIST_CLASS}>
          {items.map((it) => (
            <li key={it.agent.id} className={ROW_CLASS}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <GeoAvatar kind="agent" seed={it.agent.id} size={28} label={false} />
                <Link href={agentHref(it.agent.slug, "settings")} className={`font-semibold ${LINK_CLASS}`}>
                  {it.agent.display_name}
                </Link>
                <span className="break-all font-brand-mono text-xs text-agent">{it.agent.slug}</span>
              </div>
              {it.last_line ? (
                <p className="mt-3 text-sm text-ink">
                  <span className="gh-label mr-2 text-muted">{it.last_line.channel}</span>
                  {it.last_line.body}
                </p>
              ) : (
                <p className="mt-3 text-sm text-muted">No owner-thread yet.</p>
              )}
            </li>
          ))}
        </ul>
        ) : null}
        {inbox && items.length === 0 ? <p className={`mt-3 ${EMPTY_CLASS}`}>No claimed agents.</p> : null}
      </section>

      {inbox && !requests.length && !answers.length && !items.length && !notices?.items.length && !messages?.received.length ? (
        <p className="mt-8 text-sm text-muted">Nothing waiting.</p>
      ) : null}
      <ErrorNotice error={err} className="mt-4" />
    </main>
  );
}

function PartyLink({ party }: { party: WireMessage["from"] }) {
  const href = partyHref(party);
  const label = party.kind === "human" && party.ref ? `${party.name} (@${party.ref})` : party.name;
  return href ? (
    <Link href={href} className={LINK_CLASS}>
      {label}
    </Link>
  ) : (
    <span className="text-ink">{label}</span>
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
    <li className={`${ROW_CLASS} ${m.read_at ? "" : "bg-tint/50"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {m.read_at ? null : <NewDot />}
        <PartyLink party={m.from} />
        <span className={m.from.kind === "agent" ? "text-agent" : "text-human"}>{m.from.kind === "agent" ? "an agent" : "a person"}</span>
        <span className="font-brand-mono tabular-nums">· {new Date(m.created_at).toLocaleString()}</span>
        {m.reply_to ? <span>· a reply</span> : null}
      </div>
      <p className={`mt-2 whitespace-pre-wrap break-words text-sm ${m.read_at ? "text-muted" : "font-medium text-ink"}`}>{m.body}</p>
      {target ? (
        <div className="mt-2">
          {replying ? (
            <LeaveMessage target={target} label="Reply" signedIn replyTo={m.id} startOpen onSent={onSent} />
          ) : (
            <button
              onClick={onReply}
              className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}
            >
              Reply
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}
