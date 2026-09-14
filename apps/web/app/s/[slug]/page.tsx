"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { GROVE_BASE, gp } from "@/lib/base";
import { describeRoomAccess } from "@grove/ui";
import {
  ACCESS_ORDER,
  ROOM_DOOR_CHOICES,
  accessCopy,
  accessTint,
  isPreset,
  roomDoorWord,
  type SpacePolicyPreset,
} from "@/lib/access";
import {
  EXPLORE_PATH,
  SPACE_TABS,
  SPACE_TAB_LABEL,
  inviteHref,
  readSpaceTab,
  spaceHref,
  waitingAt,
  waitingLine,
  withSpaceTab,
  type SpaceTab,
} from "@/lib/space-page";
import { hasSignedInHint } from "@/lib/unread";
import { CardFields, CardPanel, useCard, useCardLex } from "@/components/Card";
import type { WireBranding } from "@/components/Branding";
import { visitHref } from "@/lib/visit-link";
import { brandingDraft, checkDraft } from "@/lib/branding";
import { FollowButton } from "@/components/Follow";
import { Tabs, tabPanelProps } from "@/components/Tabs";
import { ErrorNotice } from "@/components/ErrorNotice";

/*
 * Code-split (#68, docs/PERFORMANCE.md): the board (lightbox + composer), the
 * Activity tab and every Manage panel (branding, estate, decor editor, default
 * theme, relocate/transfer) load when they are first shown. This page already
 * renders after its own fetch, so nothing here was on the first paint.
 */
const none = () => null;
const Activity = dynamic(() => import("@/components/Activity").then((m) => m.Activity), { loading: none });
const BoardSection = dynamic(() => import("@/components/Board").then((m) => m.BoardSection), { loading: none });
const BrandingPanel = dynamic(() => import("@/components/Branding").then((m) => m.BrandingPanel), { loading: none });
const EstatePanel = dynamic(() => import("@/components/EstateName").then((m) => m.EstatePanel), { loading: none });
const DecorPanel = dynamic(() => import("@/components/Decor").then((m) => m.DecorPanel), { loading: none });
const DefaultThemePanel = dynamic(() => import("@/components/DefaultTheme").then((m) => m.DefaultThemePanel), { loading: none });
const RelocatePanel = dynamic(() => import("@/components/SpaceMoves").then((m) => m.RelocatePanel), { loading: none });
const TransferPanel = dynamic(() => import("@/components/SpaceMoves").then((m) => m.TransferPanel), { loading: none });

/**
 * One space, one page: About · Activity · Manage (`?tab=`).
 *
 * Everyone who may see the space gets About (card, the artifact board, rooms and their doors,
 * members for members) and Activity (the chronicle filtered to this space; the
 * API answers 404 for a private space you are not inside, like the page itself).
 * The owner also gets Manage: access, set here and only here, room doors,
 * invites, admit by handle, orgs, branding and the card. Join requests are decided in the
 * Inbox; Manage only says how many are waiting.
 */

type WireCeiling = { speak_to_agents: boolean; speak_to_humans: boolean; listen_to_agents: boolean; listen_to_humans: boolean };

type Org = { id: string; slug: string; name: string; colour: string };

type Detail = {
  world: {
    id: string;
    slug: string;
    name: string;
    owner_human_id: string | null;
    plot_index: number | null;
    policy_preset: string;
    member_policy: WireCeiling | null;
    org_render_mode: "shared" | "dedicated";
    created_at: string;
  };
  rooms: Array<{
    id: string;
    slug: string;
    name: string;
    kind: string;
    capacity: number;
    occupancy: number;
    room_preset: SpacePolicyPreset | null;
    member_policy: WireCeiling | null;
    admits_non_members: boolean;
  }>;
  members: Array<{ human_id: string; handle: string; display_name: string; is_owner: boolean }>;
  is_member: boolean;
  is_owner: boolean;
  /** The human holding the space (not an operator operating it): may transfer or move it (#35). */
  is_holder?: boolean;
  /** Set when the space was handed to an org (#35). */
  holder_org?: Org | null;
  org_render_mode: "shared" | "dedicated";
  orgs: Org[];
  /** Per-body tint the mode resolves to. The map renderer reads this. */
  org_bodies: Array<{ human_id: string; org_id: string; colour: string }>;
  /** 035: the owner's accent, sign text and emblem. */
  branding?: WireBranding;
  /** #59: the owner's default map theme, or null. Past the same door as the name. */
  default_theme?: string | null;
};

type Invite = {
  code: string;
  expires_at: string;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
  active: boolean;
};

export default function SpacePage() {
  const { slug } = useParams<{ slug: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<SpaceTab>("about");
  const lex = useCardLex();

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/v1/worlds/${encodeURIComponent(slug)}`);
      setD(r);
      setMissing(false);
      // An id resolves too; show the canonical address.
      if (r.world.slug !== slug) {
        window.history.replaceState(
          window.history.state,
          "",
          `${gp(spaceHref(r.world.slug))}${withSpaceTab(window.location.search, readSpaceTab(window.location.search, true))}${window.location.hash}`,
        );
      }
    } catch (e) {
      if ((e as { status?: number }).status === 404) setMissing(true);
      else setErr(e);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSignedIn(hasSignedInHint(document.cookie));
  }, []);

  const isOwner = Boolean(d?.is_owner);
  // The tab waits for the space, so `?tab=manage` is not bounced to About
  // while ownership is still unknown.
  useEffect(() => {
    if (!d) return;
    setTab(readSpaceTab(window.location.search, d.is_owner));
  }, [d]);

  function chooseTab(t: SpaceTab) {
    setTab(t);
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${withSpaceTab(search, t)}${hash}`);
  }

  async function enter(room?: string) {
    setErr(null);
    try {
      await api(`/api/v1/worlds/${d!.world.id}/enter`, {
        method: "POST",
        body: JSON.stringify(room ? { room } : {}),
      });
      window.location.href = gp(visitHref(room ?? "plaza", d!.world.plot_index));
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        window.location.href = gp(`/login?why=space&next=${encodeURIComponent(spaceHref(slug))}`);
      } else setErr(e);
    }
  }

  if (missing) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="font-display text-3xl text-lantern-300">No space here</h1>
        <p className="mt-3 text-white/60">Nothing by that name that you can see.</p>
        <Link href={EXPLORE_PATH} className="mt-6 inline-block text-lantern-300 underline">
          Explore spaces
        </Link>
      </main>
    );
  }
  if (err && !d) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <ErrorNotice error={err} onRetry={() => void load()} />
        <Link href={EXPLORE_PATH} className="mt-4 inline-block text-lantern-300">
          ← Explore
        </Link>
      </main>
    );
  }
  if (!d) return <main className="mx-auto max-w-3xl px-4 py-8 text-white/55 sm:px-6 sm:py-12">Loading…</main>;

  const copy = accessCopy(d.world.policy_preset);
  // A non-member walks in as a visitor through an open door: the plaza when it
  // is open, else the first open room. Joining stays a separate ask.
  const openRooms = d.rooms.filter((r) => r.admits_non_members);
  const visitRoom = openRooms.find((r) => r.slug === "plaza") ?? openRooms[0] ?? null;
  const tabs = SPACE_TABS.filter((t) => t !== "manage" || isOwner);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link href={EXPLORE_PATH} className="inline-block py-2 text-sm text-white/55">
        ← Explore
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words font-display text-3xl text-lantern-300 sm:text-4xl">{d.world.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-white/60">
            <span className={`rounded-full border px-2 py-0.5 text-xs ${accessTint(d.world.policy_preset)}`}>{copy.word}</span>
            {d.world.plot_index != null ? (
              <span className="text-sm text-white/55">plot {d.world.plot_index}</span>
            ) : (
              <span className="text-sm text-white/55">the civic core</span>
            )}
            {d.holder_org ? <span className="text-sm text-white/50">held for {d.holder_org.name}</span> : null}
            {isOwner ? <span className="text-sm text-lantern-300/80">yours</span> : d.is_member ? <span className="text-sm text-white/50">member</span> : null}
          </p>
          <p className="mt-1 text-sm text-white/55">{copy.line}</p>
          <OrgChips orgs={d.orgs} mode={d.org_render_mode} />
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          {d.is_member ? (
            <button
              type="button"
              onClick={() => void enter()}
              className="rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 sm:py-2"
            >
              Visit
            </button>
          ) : visitRoom ? (
            <button
              type="button"
              onClick={() => void enter(visitRoom.slug)}
              className="rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 sm:py-2"
            >
              {accessWordFor(visitRoom.room_preset ?? d.world.policy_preset) === "Watch only" ? "Visit and watch" : "Visit"}
            </button>
          ) : null}
          {!d.is_member ? (
            signedIn ? (
              <AskToJoin worldId={d.world.id} />
            ) : (
              <Link
                href={`/login?why=space&what=${encodeURIComponent(d.world.name)}&next=${encodeURIComponent(spaceHref(d.world.slug))}`}
                className="rounded-full border border-lantern-400/40 px-4 py-2.5 text-center text-sm text-lantern-300 sm:py-2"
              >
                Sign in to ask to join
              </Link>
            )
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-start gap-2">
        <FollowButton target={{ subject: "space", ref: d.world.slug }} signedIn={signedIn} lex={lex} name={d.world.name} />
      </div>

      <Tabs label="Space" tabs={tabs} current={tab} labels={SPACE_TAB_LABEL} onChoose={chooseTab} />

      <div {...tabPanelProps("Space", tab)} className="mt-6">
        {tab === "about" ? <About detail={d} signedIn={signedIn} /> : null}
        {tab === "activity" ? (
          <Activity worldId={d.world.id} emptyText={`Nothing in ${d.world.name} that you can see in this window.`} />
        ) : null}
        {tab === "manage" && isOwner ? <Manage detail={d} reload={load} /> : null}
      </div>

      <ErrorNotice error={err} className="mt-6" />
    </main>
  );
}

function accessWordFor(preset: string) {
  return accessCopy(preset).word;
}

/** What anyone who may see the space reads: the card, the rooms and their doors, and (for members) who is in it. */
function About({ detail: d, signedIn }: { detail: Detail; signedIn: boolean | null }) {
  const lex = useCardLex();
  const { card, loaded } = useCard({ subject: "space", ref: d.world.id });
  const spacePreset = d.world.policy_preset;
  const hasCard = Boolean(
    card && (card.card.working_on || card.card.looking_for || card.card.latest || (card.card.links ?? []).length),
  );
  return (
    <>
      {loaded && card && (hasCard || card.editable.length === 0) ? (
        <section>
          <h2 className="font-display text-2xl text-lantern-300">Card</h2>
          <div className="mt-3 rounded-xl border border-white/10 bg-dusk-800/60 px-4 py-3">
            <CardFields card={card} lex={lex} />
          </div>
        </section>
      ) : null}
      {loaded && card && !hasCard && card.editable.length > 0 ? (
        <p className="text-sm text-white/55">
          No card yet. Say what this space is working on under <em>Manage</em>.
        </p>
      ) : null}

      {d.world.plot_index != null ? <BoardSection worldId={d.world.id} signedIn={signedIn} /> : null}

      <section className="mt-10">
        <h2 className="font-display text-2xl text-lantern-300">Rooms</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {d.rooms.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-dusk-800/60 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{r.name}</div>
                <div className="text-xs text-white/55">
                  {r.kind} ·{" "}
                  <span className={accessTint(r.room_preset ?? spacePreset).split(" ").pop()}>
                    {roomDoorWord(r.room_preset, spacePreset)}
                  </span>
                </div>
              </div>
              <div className="shrink-0 text-xs text-white/50">
                {r.occupancy}/{r.capacity}
              </div>
            </li>
          ))}
        </ul>
        {d.rooms.length === 0 ? <p className="mt-3 text-white/55">No rooms here yet.</p> : null}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl text-lantern-300">Members</h2>
        {d.is_member ? (
          <ul className="mt-3 space-y-2">
            {d.members.map((m) => {
              const tint = d.org_bodies.find((b) => b.human_id === m.human_id);
              return (
                <li key={m.human_id} className="flex items-center justify-between rounded-xl border border-white/10 bg-dusk-800/60 px-4 py-3">
                  <Link href={`/u/${encodeURIComponent(m.handle)}`} className="flex min-w-0 flex-wrap items-center gap-x-2">
                    {tint ? <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tint.colour }} /> : null}
                    <span className="truncate font-semibold">{m.display_name}</span>
                    <span className="truncate text-xs text-white/55">@{m.handle}</span>
                  </Link>
                  {m.is_owner ? (
                    <span className="rounded-full bg-lantern-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-lantern-300">
                      owner
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-white/55">Who is inside is for members. The access above is public; the roster is not.</p>
        )}
      </section>
    </>
  );
}

/**
 * The owner's tab. Access is set here and nowhere else on the page; join
 * requests are decided in the Inbox, so this only counts them.
 */
function Manage({ detail, reload }: { detail: Detail; reload: () => Promise<void> }) {
  const [waiting, setWaiting] = useState<number | null>(null);

  useEffect(() => {
    void api<{ space_requests?: Array<{ world_id: string }> }>("/api/v1/inbox")
      .then((r) => setWaiting(waitingAt(r.space_requests, detail.world.id)))
      .catch(() => setWaiting(null));
  }, [detail.world.id]);

  return (
    <div className="space-y-10">
      {waiting ? (
        <Link
          href="/inbox"
          className="flex items-center justify-between gap-3 rounded-2xl border border-lantern-400/40 bg-lantern-400/10 px-4 py-3 text-sm text-lantern-200"
        >
          <span>{waitingLine(waiting)}</span>
          <span aria-hidden>→</span>
        </Link>
      ) : (
        <p className="text-sm text-white/55">
          Nobody is waiting to join. Asks land in your{" "}
          <Link href="/inbox" className="text-lantern-300 underline">
            Inbox
          </Link>
          .
        </p>
      )}

      <AccessPicker detail={detail} reload={reload} />
      <RoomAccess detail={detail} reload={reload} />
      <InviteLinks detail={detail} />
      <AdmitByHandle detail={detail} reload={reload} />
      <OrgBindings detail={detail} reload={reload} />
      <BrandingPanel worldId={detail.world.id} space={detail.world} orgs={detail.orgs} branding={detail.branding ?? null} reload={reload} />
      {detail.world.plot_index != null ? (
        <DefaultThemePanel
          worldId={detail.world.id}
          space={detail.world}
          orgs={detail.orgs}
          branding={checkDraft(brandingDraft(detail.branding)).valid}
          defaultTheme={detail.default_theme ?? null}
          reload={reload}
        />
      ) : null}
      <EstatePanel orgs={detail.orgs} />
      {detail.world.plot_index != null ? <DecorPanel worldId={detail.world.id} ownerDefault={detail.default_theme ?? null} /> : null}
      <CardPanel target={{ subject: "space", ref: detail.world.id }} saveId={detail.world.id} title="Card" />
      {detail.is_holder && detail.world.plot_index != null ? (
        <>
          <RelocatePanel space={detail.world} reload={reload} />
          <TransferPanel space={detail.world} reload={reload} />
        </>
      ) : null}
    </div>
  );
}

function AccessPicker({ detail, reload }: { detail: Detail; reload: () => Promise<void> }) {
  const [err, setErr] = useState<unknown>(null);
  const [saving, setSaving] = useState<string | null>(null);
  async function choose(p: SpacePolicyPreset) {
    if (p === detail.world.policy_preset) return;
    setErr(null);
    setSaving(p);
    try {
      await api(`/api/v1/worlds/${detail.world.id}`, { method: "PATCH", body: JSON.stringify({ policy_preset: p }) });
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setSaving(null);
    }
  }

  return (
    <section>
      <h3 className="font-display text-xl text-lantern-300">Access</h3>
      <p className="mt-1 text-xs text-white/55">
        Who may come in, listen and speak across the whole space. A room door below can differ.
      </p>
      <div className="mt-3 space-y-2">
        {ACCESS_ORDER.map((p) => {
          const c = accessCopy(p);
          const current = p === detail.world.policy_preset;
          return (
            <button
              key={p}
              type="button"
              onClick={() => void choose(p)}
              disabled={saving !== null}
              aria-pressed={current}
              className={`block w-full rounded-lg border p-3 text-left ${
                current ? "border-lantern-400/50 bg-lantern-400/5" : "border-white/10"
              } disabled:opacity-50`}
            >
              <strong>{c.word}</strong>
              {current ? <span className="ml-2 text-xs text-lantern-300">current</span> : null}
              {saving === p ? <span className="ml-2 text-xs text-white/55">saving…</span> : null}
              <span className="block text-sm text-white/50">{c.line}</span>
            </button>
          );
        })}
      </div>
      <ErrorNotice error={err} className="mt-2" />
    </section>
  );
}

function AdmitByHandle({ detail, reload }: { detail: Detail; reload: () => Promise<void> }) {
  const [handle, setHandle] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [admitted, setAdmitted] = useState<string | null>(null);

  async function admit() {
    setErr(null);
    setAdmitted(null);
    try {
      const r = await api<{ member: { handle: string } }>(`/api/v1/worlds/${detail.world.id}/members`, {
        method: "POST",
        body: JSON.stringify({ handle }),
      });
      setAdmitted(r.member.handle);
      setHandle("");
      await reload();
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <section>
      <h3 className="font-display text-xl text-lantern-300">Admit by handle</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="@handle"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 outline-none focus:border-lantern-400"
        />
        <button
          type="button"
          onClick={() => void admit()}
          disabled={!handle.trim()}
          className="shrink-0 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
        >
          Admit
        </button>
      </div>
      {admitted ? <p className="mt-2 text-sm text-lantern-300">@{admitted} is now a member.</p> : null}
      <ErrorNotice error={err} className="mt-2" />
    </section>
  );
}

function OrgChips({ orgs, mode }: { orgs: Org[]; mode: "shared" | "dedicated" }) {
  if (!orgs.length) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/55">
      {mode === "dedicated" ? "home of" : "shared by"}
      {orgs.map((o) => (
        <span
          key={o.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-white/70"
        >
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: o.colour }} />
          {o.name}
        </span>
      ))}
    </p>
  );
}

/**
 * The other direction from "admit by handle": the outsider asks. The reply is
 * deliberately bare — a pending request tells you nothing about what is inside.
 */
function AskToJoin({ worldId }: { worldId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/worlds/${worldId}/join-requests`, {
        method: "POST",
        body: JSON.stringify({ note }),
      });
      setSent(true);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="shrink-0 text-sm text-lantern-300">
        Asked. The owner decides; you will appear as a member if they say yes.
      </p>
    );
  }

  return (
    <div className="w-full sm:w-auto sm:shrink-0">
      {open ? (
        <div className="w-full space-y-2 rounded-xl border border-white/10 bg-dusk-800/70 p-3 sm:w-72">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={280}
            placeholder="Optional: say who you are."
            className="w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm outline-none focus:border-lantern-400"
          />
          <button
            onClick={() => void ask()}
            disabled={busy}
            className="w-full rounded-full bg-lantern-400 py-3 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
          >
            {busy ? "Asking…" : "Send the request"}
          </button>
          <ErrorNotice error={err} size="xs" />
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="rounded-full border border-lantern-400/40 px-4 py-2.5 text-sm text-lantern-300 sm:py-2"
        >
          Ask to join
        </button>
      )}
    </div>
  );
}

/**
 * SPC-07 / SPC-10 on the existing owner surface. Member ceiling for the whole
 * space, then one row per room: who may come in and what each audience can do,
 * stated as the consequence the kernel will actually enforce (describeRoomAccess
 * calls the kernel's own resolveCeiling).
 */
const MEMBER_CHOICES: Array<{ key: string; label: string; value: WireCeiling | null }> = [
  { key: "inherit", label: "follow the space", value: null },
  {
    key: "full",
    label: "members speak and listen",
    value: { speak_to_agents: true, speak_to_humans: true, listen_to_agents: true, listen_to_humans: true },
  },
  {
    key: "listen",
    label: "members listen only",
    value: { speak_to_agents: false, speak_to_humans: false, listen_to_agents: true, listen_to_humans: true },
  },
];

function choiceKey(v: WireCeiling | null): string {
  if (!v) return "inherit";
  const hit = MEMBER_CHOICES.find((c) => c.value && JSON.stringify(c.value) === JSON.stringify(v));
  return hit?.key ?? "custom";
}

function toCeiling(v: WireCeiling | null) {
  return v
    ? { speakToAgents: v.speak_to_agents, speakToHumans: v.speak_to_humans, listenToAgents: v.listen_to_agents, listenToHumans: v.listen_to_humans }
    : null;
}

function RoomAccess({ detail, reload }: { detail: Detail; reload: () => Promise<void> }) {
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isCore = detail.world.plot_index == null;
  const spacePreset: SpacePolicyPreset = isPreset(detail.world.policy_preset) ? detail.world.policy_preset : "private";

  async function patch(url: string, payload: Record<string, unknown>, key: string) {
    setErr(null);
    setBusy(key);
    try {
      await api(url, { method: "PATCH", body: JSON.stringify(payload) });
      await reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }

  if (isCore) return null;
  const spaceMemberKey = choiceKey(detail.world.member_policy);

  return (
    <div>
      <h3 className="font-display text-xl text-lantern-300">Room doors</h3>
      <p className="mt-1 text-xs text-white/55">
        A room can differ from the space. Open one as a lobby and only that room is listed publicly; the rest of the
        space stays behind the door. Members are never held below visitors in the same room.
      </p>

      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-white/60">Across the space,</span>
        <select
          value={spaceMemberKey === "inherit" ? "full" : spaceMemberKey}
          disabled={busy !== null}
          onChange={(e) => {
            const c = MEMBER_CHOICES.find((x) => x.key === e.target.value);
            void patch(`/api/v1/worlds/${detail.world.id}`, { member_policy: c?.key === "full" ? null : c?.value ?? null }, "space");
          }}
          className="rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1.5"
        >
          <option value="full">members speak and listen</option>
          <option value="listen">members listen only</option>
          {spaceMemberKey === "custom" ? <option value="custom">custom</option> : null}
        </select>
      </label>

      <ul className="mt-4 space-y-3">
        {detail.rooms.map((r) => {
          const view = describeRoomAccess({
            spacePreset,
            spaceMemberPolicy: toCeiling(detail.world.member_policy),
            roomPreset: r.room_preset,
            roomMemberPolicy: toCeiling(r.member_policy),
          });
          const memberKey = choiceKey(r.member_policy);
          return (
            <li key={r.id} className="rounded-lg border border-white/10 bg-dusk-950/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{r.name}</strong>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${accessTint(r.room_preset ?? spacePreset)}`}>
                    {roomDoorWord(r.room_preset, spacePreset)}
                  </span>
                  {view.isLobby ? <span className="text-[11px] text-lantern-300/80">lobby</span> : null}
                  {!r.room_preset && !r.member_policy ? <span className="text-[11px] text-white/50">same as the space</span> : null}
                </span>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-white/50">
                  Door for non-members
                  <select
                    value={r.room_preset ?? "inherit"}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const c = ROOM_DOOR_CHOICES.find((x) => x.key === e.target.value);
                      void patch(`/api/v1/worlds/${detail.world.id}/rooms/${encodeURIComponent(r.slug)}`, { room_preset: c?.value ?? null }, r.id);
                    }}
                    className="mt-1 block w-full rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1.5 text-sm text-white"
                  >
                    {ROOM_DOOR_CHOICES.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-white/50">
                  Members
                  <select
                    value={memberKey}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const c = MEMBER_CHOICES.find((x) => x.key === e.target.value);
                      void patch(`/api/v1/worlds/${detail.world.id}/rooms/${encodeURIComponent(r.slug)}`, { member_policy: c?.value ?? null }, r.id);
                    }}
                    className="mt-1 block w-full rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1.5 text-sm text-white"
                  >
                    {MEMBER_CHOICES.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                    {memberKey === "custom" ? <option value="custom">custom</option> : null}
                  </select>
                </label>
              </div>
              {/* The preview: what each audience gets, in the kernel's own terms. */}
              <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                <p className="text-white/70">
                  <span className="text-white/55">A member sees: </span>
                  {view.member.line}
                  {view.member.decidedBy === "room" ? <span className="text-white/50"> (this room)</span> : null}
                </p>
                <p className="text-white/70">
                  <span className="text-white/55">A non-member sees: </span>
                  {view.visitor.line}
                  {view.isLobby && spacePreset === "private" ? (
                    <span className="block text-white/50">On the map: this room only, never the space's name or other rooms.</span>
                  ) : null}
                </p>
              </div>
              {busy === r.id ? <p className="mt-1 text-xs text-white/55">saving…</p> : null}
            </li>
          );
        })}
      </ul>
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}

function InviteLinks({ detail }: { detail: Detail }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [singleUse, setSingleUse] = useState(true);
  const [hours, setHours] = useState(168);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ invites: Invite[] }>(`/api/v1/worlds/${detail.world.id}/invites`);
    setInvites(r.invites ?? []);
  }, [detail.world.id]);

  useEffect(() => {
    void load().catch((e) => setErr(e));
  }, [load]);

  const linkFor = (code: string) =>
    typeof window === "undefined"
      ? `${GROVE_BASE}${inviteHref(code)}`
      : `${window.location.origin}${GROVE_BASE}${inviteHref(code)}`;

  async function mint() {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/v1/worlds/${detail.world.id}/invites`, {
        method: "POST",
        body: JSON.stringify({ single_use: singleUse, expires_in_hours: hours }),
      });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    setErr(null);
    try {
      await api(`/api/v1/worlds/${detail.world.id}/invites/${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <div>
      <h3 className="font-display text-xl text-lantern-300">Invite links</h3>
      <p className="mt-1 text-xs text-white/55">
        A link admits whoever holds it. Every link expires; revoking one stops it immediately.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 py-1 text-sm text-white/60">
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-lantern-400" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} />
          single use
        </label>
        <label className="flex items-center gap-2 py-1 text-sm text-white/60">
          expires in
          <input
            type="number"
            min={1}
            max={720}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="w-20 rounded-lg border border-white/10 bg-dusk-950/60 px-2 py-1 text-sm outline-none focus:border-lantern-400"
          />
          hours
        </label>
        <button
          onClick={() => void mint()}
          disabled={busy}
          className="rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-1.5"
        >
          {busy ? "Minting…" : "Mint a link"}
        </button>
      </div>

      {invites.length ? (
        <ul className="mt-3 space-y-2">
          {invites.map((i) => (
            <li
              key={i.code}
              className="flex flex-col gap-3 rounded-lg border border-white/10 bg-dusk-950/40 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-white/60">{linkFor(i.code)}</div>
                <div className="text-xs text-white/50">
                  {i.revoked_at
                    ? "revoked"
                    : !i.active
                      ? "spent or expired"
                      : `${i.max_uses == null ? "unlimited" : `${i.uses}/${i.max_uses} used`} · expires ${new Date(
                          i.expires_at,
                        ).toLocaleString()}`}
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(linkFor(i.code));
                    setCopied(i.code);
                  }}
                  className="flex-1 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60 sm:flex-none sm:px-3 sm:py-1"
                >
                  {copied === i.code ? "Copied" : "Copy"}
                </button>
                {i.revoked_at ? null : (
                  <button
                    onClick={() => void revoke(i.code)}
                    className="flex-1 rounded-full border border-red-400/30 px-4 py-2.5 text-xs text-red-300 sm:flex-none sm:px-3 sm:py-1"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}

/**
 * SPC-03 in the UI. The two shapes the owner's brief asked for are one control:
 * bind as many orgs as you like and leave the mode on "shared", or bind one and
 * flip it to "dedicated". Nothing is rebuilt between them.
 */
function OrgBindings({ detail, reload }: { detail: Detail; reload: () => Promise<void> }) {
  const [mine, setMine] = useState<Org[]>([]);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColour, setNewColour] = useState("#7c5cff");

  const loadMine = useCallback(async () => {
    const r = await api<{ orgs: Org[] }>("/api/v1/orgs");
    setMine(r.orgs ?? []);
  }, []);

  useEffect(() => {
    void loadMine().catch(() => setMine([]));
  }, [loadMine]);

  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await Promise.all([loadMine(), reload()]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const bound = new Set(detail.orgs.map((o) => o.id));
  const bindable = mine.filter((o) => !bound.has(o.id));

  return (
    <div>
      <h3 className="font-display text-xl text-lantern-300">Orgs</h3>
      <p className="mt-1 text-xs text-white/55">
        Bring several projects into one space, or keep a space per org. Same control either way — the mode
        below decides how bodies are tinted.
      </p>

      {detail.orgs.length ? (
        <ul className="mt-2 space-y-2">
          {detail.orgs.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-dusk-950/40 px-3 py-2"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: o.colour }} />
                <span className="truncate font-semibold">{o.name}</span>
                <span className="truncate text-xs text-white/50">@{o.slug}</span>
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`/api/v1/worlds/${detail.world.id}/orgs/${encodeURIComponent(o.id)}`, {
                      method: "DELETE",
                    }),
                  )
                }
                className="shrink-0 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60 disabled:opacity-40 sm:px-3 sm:py-1"
              >
                Unbind
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-white/55">No org is bound here.</p>
      )}

      {bindable.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm outline-none focus:border-lantern-400"
          >
            <option value="">Bind one of your orgs…</option>
            {bindable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            disabled={!pick || busy}
            onClick={() =>
              void run(() =>
                api(`/api/v1/worlds/${detail.world.id}/orgs`, {
                  method: "POST",
                  body: JSON.stringify({ org_id: pick }),
                }),
              )
            }
            className="shrink-0 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
          >
            Bind
          </button>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New org name"
          className="min-w-0 flex-1 basis-40 rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 text-sm outline-none focus:border-lantern-400"
        />
        <input
          type="color"
          value={newColour}
          onChange={(e) => setNewColour(e.target.value)}
          className="h-11 w-12 shrink-0 rounded-lg border border-white/10 bg-dusk-950/60"
        />
        <button
          disabled={!newName.trim() || busy}
          onClick={() =>
            void run(async () => {
              await api("/api/v1/orgs", {
                method: "POST",
                body: JSON.stringify({ name: newName, colour: newColour }),
              });
              setNewName("");
            })
          }
          className="shrink-0 rounded-full border border-lantern-400/40 px-4 py-2.5 text-sm text-lantern-300 disabled:opacity-40 sm:py-2"
        >
          Create org
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {(
          [
            ["shared", "Several orgs, side by side", "Every bound org shows. A body takes its own org's colour."],
            ["dedicated", "This space is one org's home", "One org only. Every body in it reads as that org."],
          ] as const
        ).map(([mode, label, blurb]) => {
          const current = detail.org_render_mode === mode;
          return (
            <button
              key={mode}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`/api/v1/worlds/${detail.world.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ org_render_mode: mode }),
                  }),
                )
              }
              className={`block w-full rounded-lg border p-3 text-left ${
                current ? "border-lantern-400/50 bg-lantern-400/5" : "border-white/10"
              } disabled:opacity-50`}
            >
              <strong>{label}</strong>
              {current ? <span className="ml-2 text-xs text-lantern-300">current</span> : null}
              <span className="block text-sm text-white/50">{blurb}</span>
            </button>
          );
        })}
      </div>

      <ErrorNotice error={err} className="mt-2" />
    </div>
  );
}
