"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { accessCopy, accessTint } from "@/lib/access";
import { groupResults, jumpHref, resultPath, searchApiPath, type WireSearch } from "@/lib/search";
import { exploreOrder, spaceHref, type DirectorySpace } from "@/lib/space-page";
import { hasSignedInHint } from "@/lib/unread";
import { GeoAvatar } from "@/components/Avatar";
import { DiscoveryShelves } from "@/components/Discovery";
import { roomHref } from "@/lib/world-url";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CARD_CLASS, EMPTY_CLASS, PAGE_TITLE_CLASS, PILL_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/* The create-space flow and its preview canvas load when Create is pressed (#68). */
const CreateSpaceFlow = dynamic(() => import("@/components/CreateSpaceFlow").then((m) => m.CreateSpaceFlow), {
  loading: () => null,
});

/**
 * Explore: the discovery shelves (Busiest plots, Most-watched agents, Just
 * arrived; queue #40), every space on the world, who is online right now, and
 * Create space (two steps: details, then a preview of the plot on the map; #48).
 *
 * The directory is public and redacted by the server (listDirectory): a private
 * plot you are not inside comes back with no slug, name, owner or orgs, and is
 * drawn as a held plot. Online now is the search API's commons-only list, so it
 * never places anyone inside a private space.
 */
export default function ExplorePage() {
  const [spaces, setSpaces] = useState<DirectorySpace[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [online, setOnline] = useState<WireSearch | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ spaces: DirectorySpace[] }>("/api/v1/worlds/directory");
    setSpaces(exploreOrder(r.spaces ?? []));
  }, []);

  useEffect(() => {
    void load().catch((e) => setErr(e));
    void api<WireSearch>(searchApiPath(""))
      .then(setOnline)
      .catch(() => setOnline(null));
    if (!hasSignedInHint(document.cookie)) {
      setSignedIn(false);
      return;
    }
    void api("/api/v1/humans/me")
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, [load]);

  useEffect(() => {
    if (window.location.hash === "#create") setCreating(true);
  }, []);

  const people = groupResults(online)[0]?.items ?? [];
  const mapUrl = () => new URL(gp("/"), window.location.origin).toString();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className={PAGE_TITLE_CLASS}>Explore</h1>
          <p className="mt-2 text-muted">
            Every space on the world, and who is around right now. Each space is a plot somebody claimed, with its
            own access: Open, Watch only or Private.
          </p>
        </div>
        {signedIn ? (
          <button
            type="button"
            onClick={() => setCreating((o) => !o)}
            aria-expanded={creating}
            className={buttonClass("primary", "md", "shrink-0")}
          >
            {creating ? "Close" : "Create space"}
          </button>
        ) : signedIn === false ? (
          <Link
            href={`/login?next=${encodeURIComponent("/explore#create")}`}
            className={buttonClass("secondary", "md", "shrink-0")}
          >
            Sign in to create a space
          </Link>
        ) : null}
      </div>

      {creating && signedIn ? <CreateSpaceFlow onClose={() => setCreating(false)} /> : null}

      <DiscoveryShelves online={online} signedIn={signedIn} />

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>Online now</h2>
        {online === null ? <p className="mt-3 text-sm text-muted">Looking around…</p> : null}
        {online && people.length === 0 ? (
          <p className={`mt-3 ${EMPTY_CLASS}`}>Nobody on the open map right now.</p>
        ) : null}
        {people.length ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {people.map((p) => {
              const jump = jumpHref(p, mapUrl());
              return (
                <li key={p.key} className="flex items-center gap-3 rounded-gh-lg border border-line bg-surface-raised px-3 py-2.5 shadow-gh-1">
                  <GeoAvatar kind={p.type === "agent" ? "agent" : "human"} seed={p.slug} size={28} label={false} />
                  <Link href={resultPath(p)} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center sm:block sm:min-h-0">
                    <span className="block truncate font-semibold text-ink">{p.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {p.type === "agent" ? "agent" : "person"}
                      {p.detail ? ` · ${p.detail}` : ""}
                    </span>
                  </Link>
                  {jump ? (
                    <a
                      href={jump}
                      className={buttonClass("ghost", "sm", "min-h-11 shrink-0 border-line-strong sm:min-h-8")}
                    >
                      Watch
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className={SECTION_TITLE_CLASS}>Spaces</h2>
        <ul className="mt-3 space-y-3">
          {(spaces ?? []).map((s) => (
            <li key={s.id}>
              <SpaceRow space={s} />
            </li>
          ))}
        </ul>
        {spaces === null && !err ? <p className="mt-3 text-sm text-muted">Loading…</p> : null}
        {spaces && spaces.length === 0 ? (
          <p className={`mt-3 ${EMPTY_CLASS}`}>No plot claimed yet. The world is bare ground.</p>
        ) : null}
        <ErrorNotice error={err} className="mt-4" />
      </section>
    </main>
  );
}

function AccessChip({ preset }: { preset: string }) {
  return (
    <span className={`${PILL_CLASS} ${accessTint(preset)}`}>{accessCopy(preset).word}</span>
  );
}

function SpaceRow({ space }: { space: DirectorySpace }) {
  const occupancy = `${space.occupancy} here`;

  // A private space the viewer is not in: the plot is held, and that is all the
  // server will say. No name, no owner, no headcount beyond the directory's.
  if (!space.slug) {
    return (
      <div className={`flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${CARD_CLASS}`}>
        <div className="min-w-0">
          <div className="font-semibold text-muted">Held plot</div>
          <div className="text-xs text-muted">This plot is claimed. Its name is not public.</div>
          <LobbyDoors space={space} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
          <AccessChip preset={space.policy_preset} />
          <div className="font-brand-mono text-xs tabular-nums text-muted sm:mt-1">plot {space.plot_index}</div>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={spaceHref(space.slug)}
      className={`flex flex-col gap-2 transition-colors duration-gh-fast hover:bg-tint sm:flex-row sm:items-center sm:justify-between sm:gap-4 ${CARD_CLASS}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-semibold text-ink">{space.name}</span>
          {space.is_owner ? (
            <span className="gh-label rounded-gh-pill bg-tint px-2 py-0.5 text-ink">
              yours
            </span>
          ) : space.is_member ? (
            <span className="gh-label rounded-gh-pill bg-tint px-2 py-0.5 text-muted">
              member
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted">
          {space.owner_handle ? `@${space.owner_handle}` : "unowned"} · {occupancy}
        </div>
        {space.orgs?.length ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {space.orgs.map((o) => (
              <span key={o.id} className="inline-flex items-center gap-1 text-[10px] text-muted">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: o.colour }} />
                {o.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
        <AccessChip preset={space.policy_preset} />
        <div className="font-brand-mono text-xs tabular-nums text-muted sm:mt-1">plot {space.plot_index}</div>
      </div>
    </Link>
  );
}

/** A non-member's way into a held plot: only the rooms the owner opened, entered as a visitor. */
function LobbyDoors({ space }: { space: DirectorySpace }) {
  const [err, setErr] = useState<unknown>(null);
  if (space.is_member || !space.open_rooms?.length) return null;
  async function visit(slug: string) {
    setErr(null);
    try {
      await api(`/api/v1/worlds/${space.id}/enter`, { method: "POST", body: JSON.stringify({ room: slug }) });
      window.location.href = gp(roomHref(slug));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) window.location.href = gp(`/login?next=${encodeURIComponent("/explore")}`);
      else setErr(e);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {space.open_rooms.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => void visit(r.slug)}
          className={buttonClass("secondary", "sm", "min-h-11 sm:min-h-8")}
        >
          Visit the {r.name} · {accessCopy(r.room_preset).word}
        </button>
      ))}
      <ErrorNotice error={err} inline />
    </div>
  );
}
