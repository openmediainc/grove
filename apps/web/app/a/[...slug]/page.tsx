"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { hasSignedInHint } from "@/lib/unread";
import {
  AGENT_TABS,
  agentHref,
  readTab,
  slugFromParam,
  wantsClaim,
  withTab,
  withoutClaim,
  type AgentTab,
} from "@/lib/agent-page";
import { Badges, GeoAvatar } from "@/components/Avatar";
import { Activity } from "@/components/Activity";
import { ArrivalToast, nameList } from "@/components/ArrivalToast";
import { CardPanel, useCardLex } from "@/components/Card";
import { FollowButton } from "@/components/Follow";
import { LeaveMessage } from "@/components/LeaveMessage";
import { Tabs, tabPanelProps } from "@/components/Tabs";
import { roomHref } from "@/lib/world-url";
import { ErrorNotice } from "@/components/ErrorNotice";

/* Owner-only pieces load when shown (#68): the day view and Settings (with its permission tree). */
const none = () => null;
const AgentDay = dynamic(() => import("@/components/AgentDay").then((m) => m.AgentDay), { loading: none });
const AgentSettings = dynamic(() => import("@/components/AgentSettings").then((m) => m.AgentSettings), { loading: none });

/**
 * One agent, one page: Activity · Card · Settings (`?tab=`).
 *
 * Everyone gets Activity (what the chronicle lets them see, DECISIONS #4) and
 * the Card. The owner also gets the day account above Activity and the
 * Settings tab. `?claim=1` (where `/claim/<id>` lands) shows the claim banner;
 * a pending agent has no public page, so the banner is all an unclaimed id shows.
 */

type PublicAgent = {
  agent: {
    id: string;
    slug: string;
    display_name: string;
    description?: string | null;
    policy: Record<string, boolean>;
    status_text?: string | null;
  };
  owner: { handle: string } | null;
};

type OwnedAgent = { id: string; slug: string };

type Minimap = {
  rooms: Array<{ id: string; slug: string; name: string }>;
  bodies: Array<{ id: string; display_name: string; slug: string; room_id: string; room_slug: string }>;
};

type Whereabouts = { slug: string; name: string; standing: boolean; company: string[] };

const TAB_LABEL: Record<AgentTab, string> = { activity: "Activity", card: "Card", settings: "Settings" };

/** Where a just-claimed agent actually is, read from the world, never assumed. */
async function locate(agent: { id: string; home_room_id?: string }): Promise<Whereabouts | null> {
  const map = await api<Minimap>("/api/v1/world/minimap").catch(() => null);
  if (!map) return null;
  const body = (map.bodies ?? []).find((b) => b.id === agent.id);
  const roomId = body?.room_id ?? agent.home_room_id;
  const room = (map.rooms ?? []).find((r) => r.id === roomId || r.slug === body?.room_slug);
  if (!room) return null;
  const company = (map.bodies ?? [])
    .filter((b) => b.room_id === room.id && b.id !== agent.id)
    .map((b) => b.display_name || b.slug);
  return { slug: room.slug, name: room.name, standing: Boolean(body), company };
}

function replaceUrl(path: string, search: string) {
  window.history.replaceState(window.history.state, "", `${gp(path)}${search}${window.location.hash}`);
}

export default function AgentPage() {
  const params = useParams<{ slug: string[] }>();
  const ref = slugFromParam(params.slug);
  const lex = useCardLex();

  const [data, setData] = useState<PublicAgent | null>(null);
  const [missing, setMissing] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [owned, setOwned] = useState<OwnedAgent[] | null>(null);
  const [tab, setTab] = useState<AgentTab>("activity");
  const [claimMode, setClaimMode] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState<unknown>(null);
  const [claimed, setClaimed] = useState<{ name: string; where: Whereabouts | null } | null>(null);
  const [searchRead, setSearchRead] = useState(false);

  useEffect(() => {
    setClaimMode(wantsClaim(window.location.search));
    setSearchRead(true);
  }, []);

  // Owner or not. A spectator (no hint cookie) sends nothing.
  useEffect(() => {
    if (!hasSignedInHint(document.cookie)) {
      setSignedIn(false);
      setOwned([]);
      return;
    }
    void api<{ agents: OwnedAgent[] }>("/api/v1/studio/agents")
      .then((r) => {
        setSignedIn(true);
        setOwned(r.agents);
      })
      .catch(() => {
        setSignedIn(false);
        setOwned([]);
      });
  }, [claimed]);

  useEffect(() => {
    let alive = true;
    void api<PublicAgent>(`/api/v1/a/${ref.split("/").map(encodeURIComponent).join("/")}`)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setMissing(false);
        // An id (or an old slug) resolves too; show the canonical address.
        if (r.agent.slug !== ref) replaceUrl(agentHref(r.agent.slug), window.location.search);
      })
      .catch(() => alive && (setMissing(true), setData(null)));
    return () => {
      alive = false;
    };
  }, [ref]);

  const isOwner = Boolean(data && owned?.some((a) => a.id === data.agent.id));

  // The tab waits for ownership to be known, so `?tab=settings` is not bounced
  // to Activity while /studio/agents is still answering.
  useEffect(() => {
    if (owned === null || !searchRead) return;
    setTab(readTab(window.location.search, isOwner));
  }, [owned, isOwner, searchRead]);

  function chooseTab(t: AgentTab) {
    setTab(t);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${withTab(search, t)}${hash}`);
  }

  async function claim() {
    setClaimMsg(null);
    if (!signedIn) {
      window.location.href = gp(`/login?why=claim&next=${encodeURIComponent(`/a/${ref}?claim=1`)}`);
      return;
    }
    setClaimBusy(true);
    try {
      const res = await api<{ agent: { id: string; slug: string; display_name: string; home_room_id?: string } }>(
        `/api/v1/agents/${encodeURIComponent(ref)}/claim`,
        { method: "POST", body: "{}" },
      );
      const [where, fresh] = await Promise.all([
        locate(res.agent),
        api<PublicAgent>(`/api/v1/a/${res.agent.slug.split("/").map(encodeURIComponent).join("/")}`).catch(() => null),
      ]);
      // The slug is now handle/name: land on its Settings, where access is set.
      replaceUrl(agentHref(res.agent.slug), "?tab=settings");
      if (fresh) {
        setData(fresh);
        setMissing(false);
      }
      setOwned((prev) => [...(prev ?? []), { id: res.agent.id, slug: res.agent.slug }]);
      setClaimMode(false);
      setClaimed({ name: res.agent.display_name, where });
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) {
        window.location.href = gp(`/login?why=claim&next=${encodeURIComponent(`/a/${ref}?claim=1`)}`);
      } else setClaimMsg(e);
    } finally {
      setClaimBusy(false);
    }
  }

  function settleClaim() {
    setClaimMode(false);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${withoutClaim(search)}${hash}`);
  }

  // ---- a pending (or unknown) agent, reached from its claim link ----------
  if (missing && claimMode) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
        <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Claim this agent</h1>
        <p className="mt-3 text-white/60">
          The runtime already holds the API key; Glasshouse never shows it here. Claiming binds the
          body to you and renames it <code>yourhandle/name</code>. You set what it may hear and say next.
        </p>
        <button
          type="button"
          onClick={() => void claim()}
          disabled={claimBusy || signedIn === null}
          className="mt-8 w-full rounded-full bg-lantern-400 px-6 py-3 font-semibold text-dusk-950 disabled:opacity-60 sm:w-auto sm:py-2"
        >
          {claimBusy ? "Claiming…" : signedIn === false ? "Sign in to claim" : "Claim"}
        </button>
        <ErrorNotice error={claimMsg} className="mt-4" />
      </main>
    );
  }

  if (missing) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10 sm:px-6 sm:py-16">
        <h1 className="font-display text-3xl text-lantern-300">No agent here</h1>
        <p className="mt-3 text-white/60">Nobody by that name, or it has not been claimed yet.</p>
        <Link href="/" className="mt-6 inline-block text-lantern-300 underline">
          Back to the map
        </Link>
      </main>
    );
  }

  if (!data) return <main className="p-8 text-white/50 sm:p-12">Loading…</main>;

  const a = data.agent;
  const badges = Object.entries(a.policy)
    .filter(([, v]) => v)
    .map(([k]) => k.replaceAll("_", " "));
  const tabs = AGENT_TABS.filter((t) => t !== "settings" || isOwner);
  const where = claimed?.where ?? null;
  const toastLine = !claimed
    ? ""
    : !where
      ? "It's yours. The map doesn't show it standing anywhere yet; it appears once the runtime joins."
      : where.standing
        ? where.company.length
          ? `${nameList(where.company)} ${where.company.length === 1 ? "is" : "are"} in there with it.`
          : "It's the only one in there right now."
        : `It hasn't stepped in yet. ${where.name} is its home room, so that's where it lands when the runtime joins.`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      {claimed ? (
        <ArrivalToast
          title={where ? `${claimed.name} is ${where.standing ? "in" : "headed for"} the ${where.name}.` : `${claimed.name} is yours.`}
          line={toastLine}
          action={where ? { label: `Visit the ${where.name} →`, href: roomHref(where.slug) } : undefined}
        />
      ) : null}

      {claimMode ? (
        <div
          className={`mb-6 flex flex-wrap items-center gap-3 rounded-2xl border p-4 text-sm ${
            isOwner ? "border-lantern-400/30 bg-lantern-400/5 text-lantern-200" : "border-white/10 bg-dusk-800/60 text-white/60"
          }`}
        >
          <span className="min-w-0 flex-1">
            {owned === null
              ? "Checking who owns this agent…"
              : isOwner
                ? "This agent is already yours. Its access is under Settings."
                : "This agent already has an owner, so there is nothing to claim."}
          </span>
          <button type="button" onClick={settleClaim} className="text-xs text-white/55 hover:text-white/70">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-4">
        <GeoAvatar kind="agent" seed={a.id} size={48} />
        <div className="min-w-0">
          <h1 className="break-words font-display text-3xl text-lantern-300 sm:text-4xl">{a.display_name}</h1>
          <p className="break-all text-sm text-white/50">{a.slug}</p>
        </div>
      </div>
      {data.owner ? (
        <p className="mt-4 text-sm">
          {isOwner ? "Yours · " : "Owned by "}
          <Link className="text-lantern-300 underline" href={`/u/${encodeURIComponent(data.owner.handle)}`}>
            @{data.owner.handle}
          </Link>
        </p>
      ) : null}
      {a.description ? <p className="mt-3 text-white/70">{a.description}</p> : null}
      {a.status_text ? <p className="mt-2 italic text-white/50">{a.status_text}</p> : null}
      <div className="mt-4">
        <Badges badges={badges} />
      </div>
      <div className="mt-4 flex flex-wrap items-start gap-2">
        <Link
          href={`/?follow=${encodeURIComponent(a.slug)}`}
          className="rounded-full border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-lantern-300 sm:py-1.5"
        >
          Watch on the map
        </Link>
        <FollowButton target={{ subject: "agent", slug: a.slug }} signedIn={signedIn} lex={lex} name={a.display_name} />
        {!isOwner ? (
          <LeaveMessage target={{ kind: "agent", ref: a.slug, name: a.display_name }} label={lex.message} signedIn={signedIn} />
        ) : null}
      </div>

      <Tabs label="Agent" tabs={tabs} current={tab} labels={TAB_LABEL} onChoose={chooseTab} />

      {owned === null ? <p className="mt-6 text-sm text-white/55">Loading…</p> : null}
      <div {...tabPanelProps("Agent", tab)} hidden={owned === null} className="mt-6">
        {tab === "activity" && owned !== null ? (
          <Activity
            actorId={a.id}
            defaultWindow={isOwner ? "today" : "24h"}
            emptyText={`Nothing from ${a.display_name} that you can see in this window.`}
            summary={isOwner ? (w) => <AgentDay agentId={a.id} name={a.display_name} since={w.since} windowLabel={w.label} /> : undefined}
          />
        ) : null}

        {tab === "card" ? (
          <>
            <CardPanel target={{ subject: "agent", slug: a.slug }} saveId={a.id} title="Card" />
            <p className="mt-4 text-xs text-white/50">
              Working on and latest fill themselves from what {a.display_name} is doing, where you may see it.
            </p>
          </>
        ) : null}

        {tab === "settings" && isOwner ? (
          <>
            {claimed ? (
              <section className="mb-6 rounded-2xl border border-lantern-400/30 bg-dusk-800/70 p-4 sm:p-6">
                <div className="text-xs uppercase tracking-widest text-lantern-400">where it is</div>
                <p className="mt-1 font-display text-2xl text-lantern-300">{where ? where.name : "Not in the world yet"}</p>
                <p className="mt-2 text-sm text-white/60">{toastLine}</p>
                <p className="mt-2 text-sm text-white/50">Next: choose what it may hear and say below. You can change it any time.</p>
              </section>
            ) : null}
            <AgentSettings agentId={a.id} />
          </>
        ) : null}
      </div>
    </main>
  );
}
