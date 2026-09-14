"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { ACCESS_ORDER, accessCopy, accessTint, type SpacePolicyPreset } from "@/lib/access";
import { groupResults, jumpHref, resultPath, searchApiPath, type WireSearch } from "@/lib/search";
import { exploreOrder, spaceHref, suggestSlug, type DirectorySpace } from "@/lib/space-page";
import { hasSignedInHint } from "@/lib/unread";
import { GeoAvatar } from "@/components/Avatar";
import { DiscoveryShelves } from "@/components/Discovery";
import { roomHref } from "@/lib/world-url";

/**
 * Explore: the discovery shelves (Busiest plots, Most-watched agents, Just
 * arrived; queue #40), every space on the world, who is online right now, and
 * Create space.
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
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ spaces: DirectorySpace[] }>("/api/v1/worlds/directory");
    setSpaces(exploreOrder(r.spaces ?? []));
  }, []);

  useEffect(() => {
    void load().catch((e) => setErr((e as Error).message));
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
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Explore</h1>
          <p className="mt-2 text-white/60">
            Every space on the world, and who is around right now. Each space is a plot somebody claimed, with its
            own access: Open, Watch only or Private.
          </p>
        </div>
        {signedIn ? (
          <button
            type="button"
            onClick={() => setCreating((o) => !o)}
            aria-expanded={creating}
            className="shrink-0 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 sm:py-2"
          >
            {creating ? "Close" : "Create space"}
          </button>
        ) : signedIn === false ? (
          <Link
            href={`/login?next=${encodeURIComponent("/explore#create")}`}
            className="shrink-0 rounded-full border border-lantern-400/40 px-4 py-2.5 text-sm text-lantern-300 sm:py-2"
          >
            Sign in to create a space
          </Link>
        ) : null}
      </div>

      {creating && signedIn ? <CreateSpace onClose={() => setCreating(false)} /> : null}

      <DiscoveryShelves online={online} signedIn={signedIn} />

      <section className="mt-10">
        <h2 className="font-display text-2xl text-lantern-300">Online now</h2>
        {online === null ? <p className="mt-3 text-sm text-white/40">Looking around…</p> : null}
        {online && people.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">Nobody is on the open map right now.</p>
        ) : null}
        {people.length ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {people.map((p) => {
              const jump = jumpHref(p, mapUrl());
              return (
                <li key={p.key} className="flex items-center gap-3 rounded-xl border border-white/10 bg-dusk-800/60 px-3 py-2.5">
                  <GeoAvatar kind={p.type === "agent" ? "agent" : "human"} seed={p.slug} size={28} label={false} />
                  <Link href={resultPath(p)} className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block truncate text-xs text-white/45">
                      {p.type === "agent" ? "agent" : "person"}
                      {p.detail ? ` · ${p.detail}` : ""}
                    </span>
                  </Link>
                  {jump ? (
                    <a
                      href={jump}
                      className="shrink-0 rounded-full border border-white/15 px-3 py-2 text-xs text-white/65 hover:text-lantern-300 sm:py-1"
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
        <h2 className="font-display text-2xl text-lantern-300">Spaces</h2>
        <ul className="mt-3 space-y-3">
          {(spaces ?? []).map((s) => (
            <li key={s.id}>
              <SpaceRow space={s} />
            </li>
          ))}
        </ul>
        {spaces === null && !err ? <p className="mt-3 text-sm text-white/40">Loading…</p> : null}
        {spaces && spaces.length === 0 ? (
          <p className="mt-3 text-white/40">No plot has been claimed yet. The world is bare ground.</p>
        ) : null}
        {err ? <p className="mt-4 text-red-300">{err}</p> : null}
      </section>
    </main>
  );
}

function AccessChip({ preset }: { preset: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${accessTint(preset)}`}>{accessCopy(preset).word}</span>
  );
}

function SpaceRow({ space }: { space: DirectorySpace }) {
  const occupancy = `${space.occupancy} here`;

  // A private space the viewer is not in: the plot is held, and that is all the
  // server will say. No name, no owner, no headcount beyond the directory's.
  if (!space.slug) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-dusk-800/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="font-semibold text-white/45">Held plot</div>
          <div className="text-xs text-white/35">This plot is claimed. Its name is not public.</div>
          <LobbyDoors space={space} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
          <AccessChip preset={space.policy_preset} />
          <div className="text-xs text-white/35 sm:mt-1">plot {space.plot_index}</div>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={spaceHref(space.slug)}
      className="flex flex-col gap-2 rounded-xl border border-white/10 bg-dusk-800/60 p-4 hover:border-lantern-400/30 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-semibold">{space.name}</span>
          {space.is_owner ? (
            <span className="rounded-full bg-lantern-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-lantern-300">
              yours
            </span>
          ) : space.is_member ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
              member
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-white/50">
          {space.owner_handle ? `@${space.owner_handle}` : "unowned"} · {occupancy}
        </div>
        {space.orgs?.length ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {space.orgs.map((o) => (
              <span key={o.id} className="inline-flex items-center gap-1 text-[10px] text-white/45">
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: o.colour }} />
                {o.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
        <AccessChip preset={space.policy_preset} />
        <div className="text-xs text-white/35 sm:mt-1">plot {space.plot_index}</div>
      </div>
    </Link>
  );
}

/** A non-member's way into a held plot: only the rooms the owner opened, entered as a visitor. */
function LobbyDoors({ space }: { space: DirectorySpace }) {
  const [err, setErr] = useState<string | null>(null);
  if (space.is_member || !space.open_rooms?.length) return null;
  async function visit(slug: string) {
    setErr(null);
    try {
      await api(`/api/v1/worlds/${space.id}/enter`, { method: "POST", body: JSON.stringify({ room: slug }) });
      window.location.href = gp(roomHref(slug));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) window.location.href = gp(`/login?next=${encodeURIComponent("/explore")}`);
      else setErr((e as Error).message);
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {space.open_rooms.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => void visit(r.slug)}
          className="rounded-full border border-lantern-400/40 px-3 py-1.5 text-xs text-lantern-300"
        >
          Visit the {r.name} · {accessCopy(r.room_preset).word}
        </button>
      ))}
      {err ? <span className="text-xs text-red-300">{err}</span> : null}
    </div>
  );
}

function CreateSpace({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [preset, setPreset] = useState<SpacePolicyPreset>("public_write");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const created = await api<{ world: { slug: string } }>("/api/v1/worlds", {
        method: "POST",
        body: JSON.stringify({ name, slug: slug || suggestSlug(name), policy_preset: preset }),
      });
      window.location.href = gp(spaceHref(created.world.slug));
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(code === "SLUG_TAKEN" ? `${(e as Error).message} Try another slug.` : (e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section id="create" className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl text-lantern-300">Create a space</h2>
          <p className="mt-1 text-sm text-white/50">
            You get the next free plot on the shared world, and it stays yours. Six rooms come with it.
          </p>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-xs text-white/40 hover:text-white/70">
          Close
        </button>
      </div>

      <label className="block">
        <span className="text-sm text-white/70">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(suggestSlug(e.target.value));
          }}
          placeholder="Harbour workshop"
          className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 outline-none focus:border-lantern-400/50"
        />
      </label>

      <label className="block">
        <span className="text-sm text-white/70">Slug</span>
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          onBlur={() => setSlug(suggestSlug(slug))}
          placeholder="harbour-workshop"
          className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 font-mono text-sm outline-none focus:border-lantern-400/50"
        />
        <span className="mt-1 block text-xs text-white/40">
          Lowercase and dashes. Its page will be <code>/s/{slug || suggestSlug(name) || "your-slug"}</code>.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm text-white/70">Access</legend>
        {ACCESS_ORDER.map((p) => {
          const copy = accessCopy(p);
          return (
            <label
              key={p}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                preset === p ? "border-lantern-400/50 bg-lantern-400/5" : "border-white/10"
              }`}
            >
              <input
                type="radio"
                name="access"
                className="mt-1 h-4 w-4 shrink-0 accent-lantern-400"
                checked={preset === p}
                onChange={() => setPreset(p)}
              />
              <span>
                <strong>{copy.word}</strong>
                <span className="block text-sm text-white/50">{copy.line}</span>
              </span>
            </label>
          );
        })}
        <p className="text-xs text-white/35">You can change it later under Manage on the space&apos;s page.</p>
      </fieldset>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || !name.trim()}
        className="w-full rounded-full bg-lantern-400 py-3 font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
      >
        {busy ? "Creating…" : "Create space"}
      </button>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}
    </section>
  );
}
