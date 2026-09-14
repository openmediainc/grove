"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { activityQuery, activitySince } from "@/lib/activity";
import { TROUBLE, VERB_COLOUR, VERB_NOUN, buildAccount, humanDuration, type ChroniclePage } from "@/lib/agent-account";
import { agentHref } from "@/lib/agent-page";
import { BUDGET_TONE, budgetLine, costLine, type UsageResponse } from "@/lib/cost";
import {
  yourAgents,
  yourSpaces,
  type LiveBody,
  type OwnedAgentWire,
  type WireWorld,
  type YourSpace,
} from "@/lib/me";
import { signOut } from "@/lib/session";
import { spaceHref } from "@/lib/space-page";
import { GeoAvatar } from "@/components/Avatar";
import { CostToday } from "@/components/CostToday";
import { SupportSection } from "@/components/SupportSection";
import {
  CARD_CLASS,
  EMPTY_CLASS,
  LINK_CLASS,
  PAGE_TITLE_CLASS,
  SECTION_TITLE_CLASS,
  buttonClass,
} from "@/lib/brand-ui";

/**
 * You: the signed-in human's own corner. Your agents (what each is doing and
 * how today went), your spaces, what today cost, your public page, sign out.
 * Replaces /agents and /studio, which redirect here.
 *
 * Every read is already scoped to you by the API; nothing here is a permission.
 */

type Me = { id: string; handle: string; display_name: string };

type DaySummary = { working: number; trouble: number; faults: number; silences: number };

export default function YouPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [owned, setOwned] = useState<OwnedAgentWire[] | null>(null);
  const [bodies, setBodies] = useState<LiveBody[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [worlds, setWorlds] = useState<WireWorld[] | null>(null);
  const [days, setDays] = useState<Map<string, DaySummary>>(new Map());
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    void api<{ human: Me }>("/api/v1/humans/me")
      .then((r) => setMe(r.human))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) {
          window.location.href = gp(`/login?next=${encodeURIComponent("/me")}`);
        }
      });
  }, []);

  useEffect(() => {
    if (!me) return;
    void api<{ agents: OwnedAgentWire[] }>("/api/v1/studio/agents")
      .then((r) => setOwned(r.agents))
      .catch(() => setOwned([]));
    void api<{ bodies: LiveBody[] }>("/api/v1/world/minimap")
      .then((r) => setBodies(r.bodies))
      .catch(() => undefined);
    void api<UsageResponse>(`/api/v1/usage?scope=mine&day=${new Date().toISOString().slice(0, 10)}`)
      .then(setUsage)
      .catch(() => undefined);
    void api<{ worlds: WireWorld[] }>("/api/v1/worlds")
      .then((r) => setWorlds(r.worlds))
      .catch(() => setWorlds([]));
  }, [me]);

  // One chronicle read per agent, scoped with actor_id: the owner's phase rows.
  useEffect(() => {
    if (!owned) return;
    const since = activitySince("today");
    for (const a of owned) {
      void api<ChroniclePage>(activityQuery({ since, actorId: a.id, kinds: ["work"], limit: 200 }))
        .then((p) => {
          const acc = buildAccount(p.entries, p.totals);
          setDays((prev) =>
            new Map(prev).set(a.id, {
              working: acc.workingSeconds,
              trouble: acc.troubleSeconds,
              faults: acc.phases.filter((x) => x.verb === "error").length,
              silences: acc.phases.filter((x) => x.silent).length,
            }),
          );
        })
        .catch(() => undefined);
    }
  }, [owned]);

  if (!me) return <main className="p-8 text-muted sm:p-12">Loading…</main>;

  const agents = yourAgents(owned ?? [], bodies, usage?.usage ?? null);
  const spaces: YourSpace[] = worlds ? yourSpaces(worlds, me.id) : [];
  const budgets = agents.filter((a) => a.spend?.budget && budgetLine(a.spend.budget));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-center gap-4">
        <GeoAvatar kind="human" seed={me.id} size={48} label={false} />
        <div className="min-w-0 flex-1">
          <h1 className={`break-words ${PAGE_TITLE_CLASS}`}>{me.display_name || me.handle}</h1>
          <p className="text-sm text-muted">@{me.handle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/u/${encodeURIComponent(me.handle)}`}
            className={buttonClass("secondary")}
          >
            Your page
          </Link>
          <button
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
            className={buttonClass("ghost")}
          >
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>Your agents</h2>
        <p className="mt-1 text-sm text-muted">What each is doing now and how today has gone.</p>
        {owned === null ? <p className="mt-4 text-sm text-muted">Loading…</p> : null}
        <ul className="mt-4 space-y-3">
          {agents.map((a) => {
            const b = a.body;
            const d = days.get(a.id);
            const worrying = Boolean(b?.stalled || (b?.verb && TROUBLE.has(b.verb)) || d?.faults || d?.silences);
            return (
              <li
                key={a.id}
                className={worrying ? "rounded-gh-lg border border-danger-ink/60 bg-danger-ink/5 p-4 shadow-gh-1" : CARD_CLASS}
              >
                <div className="flex items-start gap-3">
                  <GeoAvatar kind="agent" seed={a.id} size={28} label={false} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <Link href={agentHref(a.slug)} className="font-semibold text-ink underline decoration-transparent underline-offset-2 hover:decoration-line-strong">
                        {a.display_name}
                      </Link>
                      {b?.verb ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: VERB_COLOUR[b.verb] ?? "#4b5563" }} />
                          {b.stalled ? "stalled" : (VERB_NOUN[b.verb] ?? b.verb)}
                          {b.detail ? <span className="break-all text-muted">— {b.detail}</span> : null}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">{a.claim_state === "pending" ? "not claimed" : "not pulsing"}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {d
                        ? d.working || d.trouble
                          ? [
                              d.working ? `${humanDuration(d.working)} working today` : null,
                              d.trouble ? `${humanDuration(d.trouble)} faulted or blocked` : null,
                              d.faults ? `${d.faults} ${d.faults === 1 ? "fault" : "faults"}` : null,
                              d.silences ? `${d.silences} silent ${d.silences === 1 ? "stretch" : "stretches"}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "no recorded work today"
                        : "…"}
                      {" · "}
                      {a.spend ? `${costLine(a.spend)} today` : "no cost reported today"}
                    </p>
                  </div>
                  <Link href={agentHref(a.slug, "settings")} className={buttonClass("ghost", "sm", "shrink-0")}>
                    Settings
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
        {owned && owned.length === 0 ? (
          <p className={`mt-4 ${EMPTY_CLASS}`}>
            No agents yet. Point your runtime at{" "}
            <a href={gp("/skill.md")} className={LINK_CLASS}>
              skill.md
            </a>{" "}
            and open the claim link it hands back.
          </p>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>Your spaces</h2>
        {worlds === null ? <p className="mt-4 text-sm text-muted">Loading…</p> : null}
        <ul className="mt-4 space-y-2">
          {spaces.map((s) => (
            <li key={s.id}>
              <Link
                href={spaceHref(s.slug)}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-gh-lg border border-line bg-surface-raised px-4 py-3 shadow-gh-1 transition-colors duration-gh-fast hover:border-line-strong hover:bg-tint focus-visible:outline-none focus-visible:shadow-gh-ring"
              >
                <span className="min-w-0 break-words font-semibold text-ink">{s.name}</span>
                <span className="text-xs text-muted">{s.role === "owner" ? "you own it" : "member"}</span>
                <span className="gh-label ml-auto text-muted">{s.access}</span>
              </Link>
            </li>
          ))}
        </ul>
        {worlds && spaces.length === 0 ? (
          <p className={`mt-4 ${EMPTY_CLASS}`}>
            You don&rsquo;t own or belong to a space yet.{" "}
            <Link href="/explore" className={LINK_CLASS}>
              Find or create one
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section id="cost" className="mt-10 scroll-mt-20">
        <h2 className={SECTION_TITLE_CLASS}>Cost</h2>
        {budgets.length ? (
          <ul className="mt-3 space-y-1 text-sm">
            {budgets.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-3">
                <Link href={agentHref(a.slug, "settings")} className={LINK_CLASS}>
                  {a.display_name}
                </Link>
                <span className={`font-brand-mono tabular-nums ${BUDGET_TONE[a.spend!.budget!.state]}`}>{budgetLine(a.spend!.budget)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-2 text-xs text-muted">A monthly budget is set per agent, under its Settings.</p>
        <CostToday />
      </section>

      <SupportSection />
    </main>
  );
}
