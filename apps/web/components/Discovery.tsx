"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import { accessCopy, accessTint } from "@/lib/access";
import {
  DISCOVERY_API,
  SHELF_EMPTY,
  agentWords,
  arrivalWords,
  discoveryJumpHref,
  hasCardContent,
  plotWords,
  shelfAccent,
  shelfCard,
  shelfSlice,
  visitHref,
  type ShelfItem,
  type WireDiscovery,
} from "@/lib/discovery";
import type { WireSearch } from "@/lib/search";
import { GeoAvatar } from "@/components/Avatar";
import { CardFields, useCardLex } from "@/components/Card";
import { FollowButton } from "@/components/Follow";
import { CARD_CLASS, EMPTY_CLASS, PILL_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

/**
 * Explore's discovery shelves (queue #40). Ordered by activity on the server,
 * shown in that order with gentle words, never with a position number.
 */
export function DiscoveryShelves({ online, signedIn }: { online: WireSearch | null; signedIn: boolean | null }) {
  const [data, setData] = useState<WireDiscovery | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api<{ discovery: WireDiscovery }>(DISCOVERY_API)
      .then((r) => setData(r.discovery))
      .catch(() => setFailed(true));
  }, []);

  const onMap = useMemo(
    () => new Set((online?.online ?? []).filter((b) => b.kind === "agent").map((b) => b.slug)),
    [online],
  );

  if (failed) return null;

  return (
    <div className="mt-10 space-y-10">
      <Shelf
        title="Busiest plots"
        line="Open spaces with the most going on in the last day."
        items={data?.busiest_plots ?? null}
        empty={SHELF_EMPTY.busiest}
        words={(i) => (i.kind === "space" && "speakers" in i ? plotWords(i) : [])}
        onMap={onMap}
        signedIn={signedIn}
      />
      <Shelf
        title="Most-watched agents"
        line="Agents people followed and reacted to this week."
        items={data?.most_watched_agents ?? null}
        empty={SHELF_EMPTY.watched}
        words={(i) => (i.kind === "agent" && "follows_week" in i ? agentWords(i) : [])}
        onMap={onMap}
        signedIn={signedIn}
      />
      <Shelf
        title="Just arrived"
        line="New open spaces and newly claimed agents from the last week."
        items={data?.just_arrived ?? null}
        empty={SHELF_EMPTY.arrived}
        words={(i) => ("arrived_at" in i ? arrivalWords(i) : [])}
        onMap={onMap}
        signedIn={signedIn}
      />
    </div>
  );
}

function Shelf({
  title,
  line,
  items,
  empty,
  words,
  onMap,
  signedIn,
}: {
  title: string;
  line: string;
  items: ShelfItem[] | null;
  empty: string;
  words: (i: ShelfItem) => string[];
  onMap: ReadonlySet<string>;
  signedIn: boolean | null;
}) {
  const [open, setOpen] = useState(false);
  const { shown, more } = shelfSlice(items ?? [], open);
  return (
    <section aria-labelledby={`shelf-${title}`}>
      <h2 id={`shelf-${title}`} className={SECTION_TITLE_CLASS}>
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted">{line}</p>
      {items === null ? <p className="mt-3 text-sm text-muted">Looking around…</p> : null}
      {items && items.length === 0 ? <p className={`mt-3 ${EMPTY_CLASS}`}>{empty}</p> : null}
      {shown.length ? (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {shown.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <ShelfCard item={item} words={words(item)} onMap={onMap} signedIn={signedIn} />
            </li>
          ))}
        </ul>
      ) : null}
      {more > 0 || open ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={buttonClass("ghost", "sm", "mt-3 min-h-11 border-line-strong sm:min-h-8")}
        >
          {open ? "Less" : `More (${more})`}
        </button>
      ) : null}
    </section>
  );
}

function ShelfCard({
  item,
  words,
  onMap,
  signedIn,
}: {
  item: ShelfItem;
  words: string[];
  onMap: ReadonlySet<string>;
  signedIn: boolean | null;
}) {
  const lex = useCardLex();
  const accent = shelfAccent(item);
  const [jump, setJump] = useState<string | null>(null);
  useEffect(() => {
    setJump(discoveryJumpHref(item, new URL(gp("/"), window.location.origin).toString(), onMap));
  }, [item, onMap]);
  const signText = item.kind === "space" ? item.branding?.sign_text : null;
  const btn =
    buttonClass("secondary", "sm", "min-h-11 sm:min-h-8");

  return (
    <article
      className={`flex h-full flex-col ${CARD_CLASS}`}
      style={accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : undefined}
    >
      <div className="flex items-start gap-3">
        <GeoAvatar kind={item.kind === "agent" ? "agent" : "human"} seed={item.slug} size={28} label={false} />
        <div className="min-w-0 flex-1">
          <Link href={visitHref(item)} className="block truncate py-2.5 font-semibold leading-6 text-ink underline-offset-2 hover:underline sm:py-0">
            {item.name}
          </Link>
          <div className="truncate text-xs text-muted">
            {item.kind === "space" ? (signText ? `${signText} · ` : "space · ") : "agent · "}
            {item.owner_handle ? `@${item.owner_handle}` : item.kind === "agent" ? "unclaimed" : "unowned"}
          </div>
        </div>
        {item.kind === "space" ? (
          <span className={`${PILL_CLASS} shrink-0 ${accessTint(item.policy_preset)}`}>
            {accessCopy(item.policy_preset).word}
          </span>
        ) : null}
      </div>
      {words.length ? (
        <p className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink">
          {words.map((w, i) => (
            <span key={w}>
              {i > 0 ? <span aria-hidden className="mr-2 text-muted">·</span> : null}
              {w}
            </span>
          ))}
        </p>
      ) : null}
      {hasCardContent(item) ? <CardFields card={shelfCard(item)} lex={lex} compact /> : null}
      <div className="mt-auto flex flex-wrap gap-2 pt-3">
        <Link href={visitHref(item)} className={btn}>
          Visit
        </Link>
        {jump ? (
          <a href={jump} className={btn} title={item.kind === "space" ? "Open the map centred on this plot" : "Open the map following this agent"}>
            Watch
          </a>
        ) : null}
        <FollowButton
          target={item.kind === "space" ? { subject: "space", ref: item.slug } : { subject: "agent", slug: item.slug }}
          signedIn={signedIn}
          lex={lex}
          name={item.name}
        />
      </div>
    </article>
  );
}
