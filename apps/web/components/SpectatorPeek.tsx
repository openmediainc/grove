"use client";

import { gp } from "@/lib/base";

/**
 * What a spectator gets when they click the world.
 *
 * The first thing a logged-out visitor does on the landing page is click
 * something, so a click must answer rather than redirect. Everything rendered
 * here comes from the public minimap payload, which the server has already
 * redacted (a private plot arrives with a null name and owner) — so this panel
 * never has to decide what is safe to show, only how to say it. When a private
 * plot arrives redacted we say so plainly instead of inventing a placeholder
 * name for it.
 *
 * Sign-in is offered as the next step, never as a toll gate: every CTA states
 * what signing in is for and carries where the person was heading, so the
 * magic-link form can say it back to them.
 */

export type OrgBadge = { id: string; name: string; colour: string };

export type Peek =
  | {
      kind: "body";
      /** Display name — a body on the public map is never anonymous. */
      title: string;
      subtitle: string;
      region: string;
      facts: string[];
      org: OrgBadge | null;
      url: string | null;
      /** False for a body that has no Grove presence to answer you — offering
       *  to sign in and speak to it would be a promise we cannot keep. */
      speakable: boolean;
    }
  | {
      kind: "space";
      /** Null when the server redacted it: a held private plot. */
      name: string | null;
      slug: string | null;
      plotIndex: number;
      access: string;
      accessBlurb: string;
      ownerHandle: string | null;
      occupancy: number;
      orgs: OrgBadge[];
    }
  | {
      kind: "region";
      region: string;
      title: string;
      here: Array<{ name: string; detail: string }>;
      recent: Array<{ who: string; body: string }>;
    };

/**
 * A login link that knows why it was followed. `next` is where the person was
 * actually heading; the login page reads it back so the ask never arrives
 * unannounced.
 */
export function loginHref(opts: { next?: string; why?: string; what?: string }): string {
  const q = new URLSearchParams();
  if (opts.next) q.set("next", opts.next);
  if (opts.why) q.set("why", opts.why);
  if (opts.what) q.set("what", opts.what);
  const s = q.toString();
  return gp(`/login${s ? `?${s}` : ""}`);
}

function Chip({ org }: { org: OrgBadge }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-white/60">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: org.colour }} />
      {org.name}
    </span>
  );
}

export function SpectatorPeek({
  peek,
  signedIn,
  onClose,
}: {
  peek: Peek;
  /** null while we are still finding out; the copy stays honest either way. */
  signedIn: boolean | null;
  onClose: () => void;
}) {
  return (
    /* On a phone this is a sheet the thumb can reach, sitting above the map
       controls rather than floating over the middle of the world with a close
       target the size of a full stop. From sm up it is the card it always was. */
    <aside className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 max-h-[72svh] overflow-auto rounded-t-2xl border-t border-lantern-400/25 bg-dusk-950/[0.97] p-4 pb-6 text-sm shadow-2xl sm:inset-x-auto sm:bottom-auto sm:left-6 sm:top-56 sm:z-10 sm:max-h-[55vh] sm:w-[330px] sm:max-w-[calc(100vw-3rem)] sm:rounded-2xl sm:border sm:border-lantern-400/20 sm:pb-4 sm:shadow-xl">
      <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-white/20 sm:hidden" />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.25em] text-lantern-400/70">
          {peek.kind === "body" ? "Watching" : peek.kind === "space" ? "Claimed plot" : "Public room"}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl text-white/50 hover:text-white/80 sm:-mr-1 sm:-mt-1 sm:h-8 sm:w-8 sm:text-base sm:text-white/40"
        >
          ×
        </button>
      </div>

      {peek.kind === "body" ? <BodyPeek peek={peek} signedIn={signedIn} /> : null}
      {peek.kind === "space" ? <SpacePeek peek={peek} signedIn={signedIn} /> : null}
      {peek.kind === "region" ? <RegionPeek peek={peek} signedIn={signedIn} /> : null}
    </aside>
  );
}

function BodyPeek({ peek, signedIn }: { peek: Extract<Peek, { kind: "body" }>; signedIn: boolean | null }) {
  return (
    <>
      <h2 className="font-display mt-1 text-2xl text-lantern-300">{peek.title}</h2>
      <p className="mt-1 text-white/70">{peek.subtitle}</p>
      <p className="mt-1 text-xs text-white/40">in the {peek.region}</p>
      {peek.org ? (
        <p className="mt-2">
          <Chip org={peek.org} /> <span className="text-[11px] text-white/35">— its colours on this map</span>
        </p>
      ) : null}
      {peek.facts.length ? (
        <ul className="mt-3 space-y-1.5 text-xs text-white/55">
          {peek.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {peek.url ? <p className="mt-2 break-all text-xs text-white/35">{peek.url}</p> : null}
      {signedIn ? (
        peek.speakable ? (
          <p className="mt-4 text-xs text-white/45">
            You have a body here — walk into the {peek.region} to speak to them.
          </p>
        ) : null
      ) : (
        <a
          href={loginHref({ next: "/enter", why: peek.speakable ? "speak" : "", what: peek.speakable ? peek.title : "" })}
          className="mt-4 block rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
        >
          {peek.speakable ? `Sign in to speak to ${peek.title}` : "Sign in to get a body of your own"}
        </a>
      )}
      <p className="mt-2 text-center text-[11px] text-white/35">Watching costs nothing — this is all public.</p>
    </>
  );
}

function SpacePeek({ peek, signedIn }: { peek: Extract<Peek, { kind: "space" }>; signedIn: boolean | null }) {
  // The server withheld the name: say that, rather than drawing a fake one.
  const redacted = !peek.slug;
  return (
    <>
      <h2 className="font-display mt-1 text-2xl text-lantern-300">{redacted ? "Held plot" : peek.name}</h2>
      <p className="mt-1 text-white/70">{peek.accessBlurb}</p>
      <p className="mt-2 text-xs text-white/40">
        plot {peek.plotIndex} · {peek.access} ·{" "}
        {peek.occupancy === 1 ? "1 body inside" : `${peek.occupancy} bodies inside`}
      </p>
      {redacted ? (
        <p className="mt-2 text-xs text-white/40">
          Somebody claimed this ground. That much is public; its name, owner and orgs are not.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-white/40">{peek.ownerHandle ? `held by @${peek.ownerHandle}` : "unowned"}</p>
          {peek.orgs.length ? (
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {peek.orgs.map((o) => (
                <Chip key={o.id} org={o} />
              ))}
            </p>
          ) : null}
          <a
            href={gp(`/spaces/${peek.slug}`)}
            className="mt-4 block rounded-full border border-lantern-400/40 px-4 py-3 text-center text-lantern-300 sm:py-2"
          >
            Look at {peek.name}
          </a>
        </>
      )}
      {signedIn ? null : (
        <a
          href={loginHref({
            next: redacted ? "/spaces" : `/spaces/${peek.slug}`,
            why: "space",
            what: redacted ? "" : peek.name ?? "",
          })}
          className="mt-2 block rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
        >
          Sign in to ask to join
        </a>
      )}
    </>
  );
}

function RegionPeek({ peek, signedIn }: { peek: Extract<Peek, { kind: "region" }>; signedIn: boolean | null }) {
  return (
    <>
      <h2 className="font-display mt-1 text-2xl text-lantern-300">{peek.title}</h2>
      <p className="mt-1 text-white/70">
        {peek.here.length === 0
          ? "Nobody is standing here right now."
          : peek.here.length === 1
            ? "One body is here."
            : `${peek.here.length} bodies are here.`}
      </p>
      {peek.here.length ? (
        <ul className="mt-3 space-y-1 text-xs text-white/55">
          {peek.here.slice(0, 8).map((b) => (
            <li key={b.name}>
              <span className="text-white/80">{b.name}</span> · {b.detail}
            </li>
          ))}
          {peek.here.length > 8 ? <li className="text-white/35">and {peek.here.length - 8} more</li> : null}
        </ul>
      ) : null}
      {peek.recent.length ? (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-lantern-400/60">Heard recently</p>
          <ul className="mt-2 space-y-1 text-xs text-white/55">
            {peek.recent.map((l) => (
              <li key={`${l.who}:${l.body}`}>
                <span className="text-white/80">{l.who}:</span> {l.body}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {signedIn === false ? (
        <>
          <a
            href={loginHref({ next: `/w/${peek.region}`, why: "enter-room", what: peek.title })}
            className="mt-4 block rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
          >
            Sign in to enter the {peek.title}
          </a>
          <p className="mt-2 text-center text-[11px] text-white/35">
            You can keep watching without one. Speaking needs a body.
          </p>
        </>
      ) : (
        <a
          href={gp(`/w/${peek.region}`)}
          className="mt-4 block rounded-full bg-lantern-400 px-4 py-3 text-center font-semibold text-dusk-950 sm:py-2"
        >
          Walk into the {peek.title}
        </a>
      )}
    </>
  );
}
