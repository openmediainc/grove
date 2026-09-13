"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PRESET_ORDER, presetCopy, presetTint, type SpacePolicyPreset } from "./presets";

type Space = {
  id: string;
  plot_index: number;
  policy_preset: string;
  occupancy: number;
  slug: string | null;
  name: string | null;
  owner_handle: string | null;
  is_member: boolean;
  is_owner: boolean;
  org_render_mode: "shared" | "dedicated";
  /** Bound orgs. Empty for a redacted row, exactly like name and owner. */
  orgs: Array<{ id: string; slug: string; name: string; colour: string }>;
};

export default function SpacesPage() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [me, setMe] = useState<{ id: string; handle: string } | null>(null);
  // Pending asks per space, for the plots this viewer owns. The inbox is the
  // one place that already knows this across every door a human holds, so the
  // directory reads it from there rather than teaching listDirectory() to leak
  // a count on rows that are not yours.
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ spaces: Space[] }>("/api/v1/worlds/directory");
    setSpaces(r.spaces ?? []);
  }, []);

  useEffect(() => {
    void load().catch((e) => setErr((e as Error).message));
    void (async () => {
      try {
        const h = await api<{ human: { id: string; handle: string } }>("/api/v1/humans/me");
        setMe(h.human);
        const inbox = await api<{ space_requests?: Array<{ world_id: string }> }>("/api/v1/inbox");
        const counts: Record<string, number> = {};
        for (const r of inbox.space_requests ?? []) counts[r.world_id] = (counts[r.world_id] ?? 0) + 1;
        setWaiting(counts);
      } catch {
        // Signed out, or the inbox is unreachable. The directory is public and
        // must still render; it just carries no badges.
      }
    })();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl text-lantern-300 sm:text-4xl">Spaces</h1>
          <p className="mt-2 text-white/60">
            Grove is one world. Every space below is a plot somebody claimed on it, held for life.
          </p>
        </div>
        {me ? (
          <button
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded-full bg-lantern-400 px-4 py-2.5 text-sm font-semibold text-dusk-950 sm:py-2"
          >
            {open ? "Close" : "Claim a space"}
          </button>
        ) : (
          <Link
            href="/login"
            className="shrink-0 rounded-full border border-lantern-400/40 px-4 py-2.5 text-sm text-lantern-300 sm:py-2"
          >
            Sign in to claim
          </Link>
        )}
      </div>

      {open && me ? (
        <CreateSpace
          onCreated={async () => {
            setOpen(false);
            await load();
          }}
        />
      ) : null}

      <ul className="mt-8 space-y-3">
        {spaces.map((s) => (
          <li key={s.id}>
            <SpaceRow space={s} waiting={waiting[s.id] ?? 0} />
          </li>
        ))}
      </ul>

      {spaces.length === 0 && !err ? (
        <p className="mt-8 text-white/40">No plot has been claimed yet. The world is bare ground.</p>
      ) : null}
      {err ? <p className="mt-4 text-red-300">{err}</p> : null}
    </main>
  );
}

function SpaceRow({ space, waiting }: { space: Space; waiting: number }) {
  const copy = presetCopy(space.policy_preset);
  const tint = presetTint(space.policy_preset);
  const occupancy = `${space.occupancy} ${space.occupancy === 1 ? "body" : "bodies"}`;

  // A private space the viewer is not in: the plot is held, and that is all the
  // server will say. No name, no owner. Rendering a placeholder rather than
  // hiding the row keeps the plot numbering honest.
  if (!space.slug) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-dusk-800/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="font-semibold text-white/45">Held plot</div>
          <div className="text-xs text-white/35">This plot is claimed. Its name is not public.</div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
          <span className={`rounded-full border px-2 py-0.5 text-xs ${tint}`}>{copy.label}</span>
          <div className="text-xs text-white/35 sm:mt-1">plot {space.plot_index}</div>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={`/spaces/${space.slug}`}
      className="flex flex-col gap-2 rounded-xl border border-white/10 bg-dusk-800/60 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{space.name}</span>
          {space.is_owner ? (
            <span className="rounded-full bg-lantern-400/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-lantern-300">
              yours
            </span>
          ) : space.is_member ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
              member
            </span>
          ) : null}
          {waiting ? (
            <span className="rounded-full bg-lantern-400 px-2 py-0.5 text-[10px] font-semibold text-dusk-950">
              {waiting} asking
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
        <span className={`rounded-full border px-2 py-0.5 text-xs ${tint}`}>{copy.label}</span>
        <div className="text-xs text-white/35 sm:mt-1">plot {space.plot_index}</div>
      </div>
    </Link>
  );
}

function CreateSpace({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [preset, setPreset] = useState<SpacePolicyPreset>("public_write");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The server lowercases and dashes the slug anyway; suggesting it here means
  // nobody is surprised by what they end up with.
  const suggest = (v: string) =>
    v.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const created = await api<{ world: { slug: string } }>("/api/v1/worlds", {
        method: "POST",
        body: JSON.stringify({ name, slug: slug || suggest(name), policy_preset: preset }),
      });
      await onCreated();
      window.location.href = `/grove/spaces/${created.world.slug}`;
    } catch (e) {
      const code = (e as { code?: string }).code;
      setErr(code === "SLUG_TAKEN" ? `${(e as Error).message} Try another slug.` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-4 rounded-2xl border border-white/10 bg-dusk-800/70 p-4 sm:p-6">
      <div>
        <h2 className="font-display text-2xl text-lantern-300">Claim a space</h2>
        <p className="mt-1 text-sm text-white/50">
          You get the next free plot on the shared world, and it stays yours. Six rooms come with it.
        </p>
      </div>

      <label className="block">
        <span className="text-sm text-white/70">Name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(suggest(e.target.value));
          }}
          placeholder="Openmedia HQ"
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
          onBlur={() => setSlug(suggest(slug))}
          placeholder="openmedia-hq"
          className="mt-1 w-full rounded-lg border border-white/10 bg-dusk-950/60 px-3 py-2 font-mono text-sm outline-none focus:border-lantern-400/50"
        />
        <span className="mt-1 block text-xs text-white/40">
          Lowercase and dashes. <code>grove</code> and <code>aetheria-prime</code> are the commons and cannot be taken.
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm text-white/70">Who may speak here</legend>
        {PRESET_ORDER.map((p) => {
          const copy = presetCopy(p);
          return (
            <label
              key={p}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                preset === p ? "border-lantern-400/50 bg-lantern-400/5" : "border-white/10"
              }`}
            >
              <input
                type="radio"
                name="preset"
                className="mt-1 h-4 w-4 shrink-0 accent-lantern-400"
                checked={preset === p}
                onChange={() => setPreset(p)}
              />
              <span>
                <strong className="capitalize">{copy.label}</strong>
                <span className="block text-sm text-white/50">{copy.blurb}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <button
        onClick={submit}
        disabled={busy || !name.trim()}
        className="w-full rounded-full bg-lantern-400 py-3 font-semibold text-dusk-950 disabled:opacity-40 sm:py-2"
      >
        {busy ? "Claiming…" : "Claim the plot"}
      </button>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}
    </div>
  );
}
