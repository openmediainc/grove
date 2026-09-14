"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogFocus } from "./a11y";
import { gp } from "@/lib/base";
import { loginHref } from "@/lib/login-href";
import { buildDeepLink } from "@/lib/deep-link";
import { spaceHref } from "@/lib/space-page";
import { walkOverTarget, type CardTarget } from "@/lib/card";
import type { ThemeLexicon } from "@/lib/themes/types";
import { followTargetFromCard, type FollowTarget } from "@/lib/follow";
import { CardFields, useCard } from "./Card";
import { FollowButton } from "./Follow";
import { LeaveMessage } from "./LeaveMessage";
import { messageTargetFromCard } from "@/lib/message";
import { roomHref } from "@/lib/world-url";
import { buttonClass } from "@/lib/brand-ui";
import type { IdentityKind } from "@/lib/identity";
import { IdentityChip, IdentityName } from "./Identity";

const PRIMARY = buttonClass("primary", "md", "mt-4 w-full font-semibold");

type CardLex = ThemeLexicon["card"];

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

/** What a Copy link on the card points at: a body to follow, or a tile to centre. */
export type ShareTarget = { follow: string } | { at: { tx: number; ty: number } };

export type Peek =
  | {
      kind: "body";
      /** Display name — a body on the public map is never anonymous. */
      title: string;
      subtitle: string;
      region: string;
      facts: string[];
      org: OrgBadge | null;
      /** Person or agent (a Paperclip body is an agent): the amber/cyan identity chip. */
      identity: IdentityKind;
      url: string | null;
      /** False for a body that has no Grove presence to answer you — offering
       *  to sign in and speak to it would be a promise we cannot keep. */
      speakable: boolean;
      share: ShareTarget;
      /** The room slug it stands in: where Walk over goes. */
      room: string;
      /** Whose card to show. Null for a body with no Grove card (Paperclip). */
      card: CardTarget | null;
    }
  | {
      kind: "space";
      /** Null when the server redacted it: a held private plot. */
      name: string | null;
      slug: string | null;
      plotIndex: number;
      /** "in Hearth Ring": the plot's district (#38) in the theme's words. Where land is, never who holds it. */
      district: string;
      access: string;
      accessBlurb: string;
      ownerHandle: string | null;
      occupancy: number;
      orgs: OrgBadge[];
      /** Achievement marks held, already in the theme's words. Empty when redacted. */
      marks: string[];
      marksHeading: string;
      share: ShareTarget;
    }
  | {
      kind: "region";
      region: string;
      title: string;
      here: Array<{ name: string; detail: string; kind?: IdentityKind }>;
      recent: Array<{ who: string; body: string }>;
      share: ShareTarget;
    };

// Lives in lib so the map can build login links without loading this card (#68).
export { loginHref };

/**
 * Copy a deep link to what the card is showing. The link is built from the
 * address the viewer is on at the moment of the click, so it carries the right
 * base path and theme pin, and never the viewer's kiosk or TV mode.
 */
function CopyLink({ share, className }: { share: ShareTarget; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const key = "follow" in share ? `f:${share.follow}` : `a:${share.at.tx},${share.at.ty}`;
  useEffect(() => setState("idle"), [key]);
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildDeepLink(window.location.href, share));
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={"follow" in share ? "Copy a link that opens the map following this body" : "Copy a link that opens the map centred here"}
      className={
        className ??
        buttonClass("secondary", "md", "mt-2 w-full text-gh-xs")
      }
    >
      <span aria-live="polite">{state === "copied" ? "Link copied" : state === "failed" ? "Could not copy" : "Copy link"}</span>
    </button>
  );
}

function Chip({ org }: { org: OrgBadge }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-gh-xs text-muted">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: org.colour }} />
      {org.name}
    </span>
  );
}

export function SpectatorPeek({
  peek,
  signedIn,
  lex,
  onClose,
  onOpenRoom,
}: {
  peek: Peek;
  /** The theme's card words: working on, walk over, follow… */
  lex: CardLex;
  /** null while we are still finding out; the copy stays honest either way. */
  signedIn: boolean | null;
  onClose: () => void;
  /** Open a room's drawer on this map rather than loading the map again. */
  onOpenRoom?: (slug: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, { onEscape: onClose });
  return (
    /* On a phone this is a sheet the thumb can reach, sitting above the map
       controls rather than floating over the middle of the world with a close
       target the size of a full stop. From sm up it is the card it always was. */
    <div
      ref={ref}
      data-a11y-dialog
      role="dialog"
      aria-modal="false"
      aria-labelledby="grove-peek-title"
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-30 max-h-[72svh] overflow-auto rounded-t-gh-xl border-t border-line bg-surface-raised p-4 pb-6 text-gh-sm text-ink shadow-gh-3 sm:inset-x-auto sm:bottom-auto sm:left-6 sm:top-56 sm:z-10 sm:max-h-[55vh] sm:w-[330px] sm:max-w-[calc(100vw-3rem)] sm:rounded-gh-lg sm:border sm:pb-4 sm:shadow-gh-2">
      <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
      <div className="flex items-start justify-between gap-3">
        <p className="flex flex-wrap items-center gap-2 gh-label text-muted">
          {peek.kind === "body" ? "Watching" : peek.kind === "space" ? "Claimed plot" : "Open room"}
          {peek.kind === "body" ? <IdentityChip kind={peek.identity} /> : null}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-2 -mt-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-gh-pill text-xl text-muted hover:bg-tint hover:text-ink sm:-mr-1 sm:-mt-1 sm:h-8 sm:w-8 sm:text-base"
        >
          ×
        </button>
      </div>

      {peek.kind === "body" ? <BodyPeek peek={peek} signedIn={signedIn} lex={lex} onOpenRoom={onOpenRoom} /> : null}
      {peek.kind === "space" ? <SpacePeek peek={peek} signedIn={signedIn} lex={lex} /> : null}
      {peek.kind === "region" ? (
        <>
          <RegionPeek peek={peek} signedIn={signedIn} onOpenRoom={onOpenRoom} />
          <CopyLink share={peek.share} />
        </>
      ) : null}
    </div>
  );
}

const ACTION =
  "flex min-h-11 items-center justify-center rounded-gh-pill border border-line-strong bg-surface-raised px-2 py-2 text-center text-gh-xs font-medium text-ink transition-colors duration-gh-fast hover:bg-tint sm:min-h-9";

/**
 * Walk over, Follow and Copy link, in that order, on every card. Follow is the
 * heart (a space or an agent only): it hides itself for a person, or for
 * anything the server answers 404 about, and each keeps its own grid cell.
 */
function CardActions({
  walk,
  follow,
  share,
  signedIn,
  lex,
  onOpenRoom,
}: {
  walk: { kind: "body"; room: string; what: string } | { kind: "space"; slug: string; what: string } | null;
  follow: FollowTarget | null;
  share: ShareTarget;
  signedIn: boolean | null;
  lex: CardLex;
  onOpenRoom?: (slug: string) => void;
}) {
  const target = walk ? walkOverTarget(walk, signedIn) : null;
  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      {target && walk ? (
        <a
          href={target.needsLogin ? loginHref({ next: target.path, why: "enter-room", what: walk.what }) : gp(target.path)}
          onClick={(e) => {
            // A body's room opens as a drawer right here; the map keeps running.
            if (walk.kind === "body" && !target.needsLogin && onOpenRoom) {
              e.preventDefault();
              onOpenRoom(walk.room);
            }
          }}
          className={ACTION}
        >
          {lex.walkOver}
        </a>
      ) : (
        <span aria-hidden />
      )}
      <div className="min-w-0">
        <FollowButton target={follow} signedIn={signedIn} lex={lex} className={`${ACTION} w-full gap-1`} />
      </div>
      <CopyLink share={share} className={ACTION} />
    </div>
  );
}

function BodyPeek({
  peek,
  signedIn,
  lex,
  onOpenRoom,
}: {
  peek: Extract<Peek, { kind: "body" }>;
  signedIn: boolean | null;
  lex: CardLex;
  onOpenRoom?: (slug: string) => void;
}) {
  const { card } = useCard(peek.card);
  return (
    <>
      <h2 id="grove-peek-title" className="mt-1 font-brand text-gh-2xl font-extrabold tracking-tight text-ink">
        <IdentityName kind={peek.identity}>{peek.title}</IdentityName>
      </h2>
      <p className="mt-1 text-muted">{peek.subtitle}</p>
      <p className="mt-1 text-xs text-muted">in the {peek.region}</p>
      {peek.org ? (
        <p className="mt-2">
          <Chip org={peek.org} /> <span className="text-gh-xs text-muted">— its colours on this map</span>
        </p>
      ) : null}
      {peek.facts.length ? (
        <ul className="mt-3 space-y-1.5 text-xs text-muted">
          {peek.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {peek.url ? <p className="mt-2 break-all text-xs text-muted">{peek.url}</p> : null}
      {peek.card ? <CardFields card={card} lex={lex} compact /> : null}
      <CardActions
        walk={peek.speakable ? { kind: "body", room: peek.room, what: peek.region } : null}
        follow={followTargetFromCard(peek.card)}
        share={peek.share}
        signedIn={signedIn}
        lex={lex}
        onOpenRoom={onOpenRoom}
      />
      {/* Leave a message: a Grove person or agent only (a Paperclip body has
          no door to leave one at). Opens a compose box right here. */}
      {peek.speakable ? (
        <LeaveMessage
          target={messageTargetFromCard(peek.card, peek.title)}
          label={lex.message}
          signedIn={signedIn}
          className={`${ACTION} mt-2 w-full gap-1.5`}
        />
      ) : null}
      {signedIn ? null : (
        <a
          href={loginHref({ next: "/", why: peek.speakable ? "speak" : "", what: peek.speakable ? peek.title : "" })}
          className={PRIMARY}
        >
          {peek.speakable ? `Sign in to speak to ${peek.title}` : "Sign in to get a body of your own"}
        </a>
      )}
      <p className="mt-2 text-center text-gh-xs text-muted">Watching costs nothing — this is all public.</p>
    </>
  );
}

function SpacePeek({
  peek,
  signedIn,
  lex,
}: {
  peek: Extract<Peek, { kind: "space" }>;
  signedIn: boolean | null;
  lex: CardLex;
}) {
  // The server withheld the name: say that, rather than drawing a fake one.
  const redacted = !peek.slug;
  // A redacted plot is never asked for its card: the map has no slug to ask
  // with, and the server would answer 404 to a non-member anyway.
  const { card } = useCard(peek.slug ? { subject: "space", ref: peek.slug } : null);
  return (
    <>
      <h2 id="grove-peek-title" className="mt-1 font-brand text-gh-2xl font-extrabold tracking-tight text-ink">{redacted ? "Held plot" : peek.name}</h2>
      <p className="mt-1 text-muted">{peek.accessBlurb}</p>
      <p className="mt-2 text-xs text-muted">
        plot {peek.plotIndex} · {peek.district} · {peek.access} ·{" "}
        {peek.occupancy === 1 ? "1 body inside" : `${peek.occupancy} bodies inside`}
      </p>
      {redacted ? (
        <>
          <p className="mt-2 text-xs text-muted">
            Somebody claimed this ground. That much is public; its name, owner, orgs and card are not.
          </p>
          <CopyLink share={peek.share} />
        </>
      ) : (
        <>
          <p className="mt-2 text-xs text-muted">{peek.ownerHandle ? `held by @${peek.ownerHandle}` : "unowned"}</p>
          {peek.orgs.length ? (
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {peek.orgs.map((o) => (
                <Chip key={o.id} org={o} />
              ))}
            </p>
          ) : null}
          {peek.marks.length ? (
            <div className="mt-2">
              <p className="gh-label text-muted">{peek.marksHeading}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {peek.marks.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <CardFields card={card} lex={lex} compact />
          <CardActions
            walk={{ kind: "space", slug: peek.slug!, what: peek.name ?? "" }}
            follow={{ subject: "space", ref: peek.slug! }}
            share={peek.share}
            signedIn={signedIn}
            lex={lex}
          />
        </>
      )}
      {signedIn ? null : (
        <a
          href={loginHref({
            next: redacted ? "/explore" : spaceHref(peek.slug ?? ""),
            why: "space",
            what: redacted ? "" : peek.name ?? "",
          })}
          className={buttonClass("primary", "md", "mt-2 w-full font-semibold")}
        >
          Sign in to ask to join
        </a>
      )}
    </>
  );
}

function RegionPeek({
  peek,
  signedIn,
  onOpenRoom,
}: {
  peek: Extract<Peek, { kind: "region" }>;
  signedIn: boolean | null;
  onOpenRoom?: (slug: string) => void;
}) {
  return (
    <>
      <h2 id="grove-peek-title" className="mt-1 font-brand text-gh-2xl font-extrabold tracking-tight text-ink">{peek.title}</h2>
      <p className="mt-1 text-muted">
        {peek.here.length === 0
          ? "Nobody is standing here right now."
          : peek.here.length === 1
            ? "One body is here."
            : `${peek.here.length} bodies are here.`}
      </p>
      {peek.here.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {peek.here.slice(0, 8).map((b) => (
            <li key={b.name}>
              {b.kind ? <IdentityName kind={b.kind} className="max-w-full align-middle text-ink">{b.name}</IdentityName> : <span className="text-ink">{b.name}</span>} · {b.detail}
            </li>
          ))}
          {peek.here.length > 8 ? <li className="text-muted">and {peek.here.length - 8} more</li> : null}
        </ul>
      ) : null}
      {peek.recent.length ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="gh-label text-muted">Heard recently</p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {peek.recent.map((l) => (
              <li key={`${l.who}:${l.body}`}>
                <span className="text-ink">{l.who}:</span> {l.body}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {signedIn === false ? (
        <>
          <a
            href={loginHref({ next: roomHref(peek.region), why: "enter-room", what: peek.title })}
            className={PRIMARY}
          >
            Sign in to enter the {peek.title}
          </a>
          <p className="mt-2 text-center text-gh-xs text-muted">
            You can keep watching without one. Speaking needs a body.
          </p>
        </>
      ) : (
        <a
          href={gp(roomHref(peek.region))}
          onClick={(e) => {
            if (!onOpenRoom) return;
            e.preventDefault();
            onOpenRoom(peek.region);
          }}
          className={PRIMARY}
        >
          Walk into the {peek.title}
        </a>
      )}
    </>
  );
}
