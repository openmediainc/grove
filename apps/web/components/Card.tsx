"use client";

import { useEffect, useState } from "react";
import { CARD_LINKS_MAX, CARD_LINK_LABEL_MAX, CARD_TEXT_MAX, type CardSubject } from "@grove/protocol";
import { api } from "@/lib/api";
import {
  cardApiPath,
  cardRows,
  cardSavePath,
  draftFrom,
  draftToBody,
  type CardDraft,
  type CardTarget,
  type WireCard,
} from "@/lib/card";
import { getTheme, loadTheme, readThemeChoice } from "@/lib/themes";
import type { ThemeLexicon } from "@/lib/themes/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CARD_CLASS, INPUT_CLASS, SECTION_TITLE_CLASS, buttonClass } from "@/lib/brand-ui";

type CardLex = ThemeLexicon["card"];

function targetKey(t: CardTarget): string {
  return t.subject === "space" ? `space:${t.ref}` : `${t.subject}:${t.slug}`;
}

/**
 * Fetch one card. A 404 (a private space, a pending agent, nobody by that name)
 * reads as "no card", never as an error on screen: the reader must not learn
 * from the card what the map already withheld.
 */
export function useCard(target: CardTarget | null): { card: WireCard | null; loaded: boolean; reload: () => void } {
  const [card, setCard] = useState<WireCard | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const key = target ? targetKey(target) : "";
  useEffect(() => {
    if (!target) return;
    let live = true;
    setLoaded(false);
    api<{ card: WireCard }>(cardApiPath(target))
      .then((r) => live && setCard(r.card))
      .catch(() => live && setCard(null))
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
    // Keyed on the target's identity, not the object, so a re-render does not refetch.
  }, [key, tick]);
  return { card, loaded, reload: () => setTick((n) => n + 1) };
}

/** The rows and links of a card. Pure display; the caller fetched it. */
export function CardFields({ card, lex, compact = false }: { card: WireCard | null; lex: CardLex; compact?: boolean }) {
  if (!card) return null;
  const rows = cardRows(card, lex);
  const links = card.card.links;
  if (!rows.length && !links.length) {
    return <p className={`${compact ? "mt-3" : "mt-2"} text-gh-xs text-muted`}>{lex.empty}</p>;
  }
  return (
    <dl className={`${compact ? "mt-3 border-t border-line pt-3" : "mt-2"} space-y-2 text-gh-xs`}>
      {rows.map((r) => (
        <div key={r.field}>
          <dt className="gh-label text-muted">
            {r.label}
            {r.hint ? <span className="ml-1 font-brand normal-case tracking-normal">· {r.hint}</span> : null}
          </dt>
          <dd className="mt-0.5 break-words text-ink">{r.value}</dd>
        </div>
      ))}
      {links.length ? (
        <div>
          <dt className="gh-label text-muted">{lex.links}</dt>
          <dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {links.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="break-all text-pane underline decoration-pane/40 underline-offset-2"
              >
                {l.label}
              </a>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/** The viewer's theme words, on pages outside the map. Starts on the default. */
export function useCardLex(): CardLex {
  const [lex, setLex] = useState<CardLex>(() => getTheme(null).lexicon.card);
  useEffect(() => {
    let live = true;
    try {
      void loadTheme(readThemeChoice())
        .then((t) => {
          if (live) setLex(t.lexicon.card);
        })
        .catch(() => {
          // Offline: the default words are fine.
        });
    } catch {
      // Storage blocked: the default words are fine.
    }
    return () => {
      live = false;
    };
  }, []);
  return lex;
}

/**
 * A card on a profile or space page: shown to whoever may see it, and editable
 * in place by whoever the server says may edit it (`editable`). `saveId` is the
 * space or agent id the save addresses; a person saves as themself.
 */
export function CardPanel({ target, saveId, title }: { target: CardTarget; saveId: string; title?: string }) {
  const lex = useCardLex();
  const { card, loaded, reload } = useCard(target);
  const [editing, setEditing] = useState(false);
  if (!loaded || !card) return null;
  const canEdit = card.editable.length > 0;
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className={SECTION_TITLE_CLASS}>{title ?? "Card"}</h2>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={buttonClass("secondary", "sm")}
          >
            Edit card
          </button>
        ) : null}
      </div>
      {editing ? (
        <CardEditor
          subject={card.subject}
          saveId={saveId}
          card={card}
          lex={lex}
          onDone={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : (
        <div className={`mt-3 ${CARD_CLASS}`}>
          <CardFields card={card} lex={lex} />
        </div>
      )}
    </section>
  );
}

function CardEditor({
  subject,
  saveId,
  card,
  lex,
  onDone,
}: {
  subject: CardSubject;
  saveId: string;
  card: WireCard;
  lex: CardLex;
  onDone: () => void;
}) {
  const [d, setD] = useState<CardDraft>(() => draftFrom(card));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const can = (f: string) => (card.editable as string[]).includes(f);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(cardSavePath(subject, saveId), { method: "PUT", body: JSON.stringify(draftToBody(subject, d)) });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  const input = `mt-1 ${INPUT_CLASS} text-gh-sm`;
  const text = (field: "workingOn" | "lookingFor" | "latest", label: string) =>
    can(field) ? (
      <label className="block text-xs text-muted">
        {label}
        <input
          className={input}
          maxLength={CARD_TEXT_MAX}
          value={d[field]}
          onChange={(e) => setD({ ...d, [field]: e.target.value })}
        />
      </label>
    ) : null;

  return (
    <div className={`mt-3 space-y-3 ${CARD_CLASS}`}>
      {subject === "agent" ? (
        <p className="text-xs text-muted">
          {lex.workingOn} and {lex.latest.toLowerCase()} fill themselves from this agent&apos;s pulses and tool calls.
        </p>
      ) : null}
      {text("workingOn", lex.workingOn)}
      {text("lookingFor", lex.lookingFor)}
      {text("latest", lex.latest)}
      {can("links") ? (
        <fieldset className="text-xs text-muted">
          <legend>{lex.links}</legend>
          {d.links.map((l, i) => (
            <div key={i} className="mt-1 flex flex-col gap-1 sm:flex-row">
              <input
                className={`${input} sm:w-1/3`}
                placeholder="label"
                maxLength={CARD_LINK_LABEL_MAX}
                value={l.label}
                onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
              />
              <input
                className={input}
                placeholder="https://"
                inputMode="url"
                value={l.url}
                onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })}
              />
              <button
                type="button"
                onClick={() => setD({ ...d, links: d.links.filter((_, j) => j !== i) })}
                className={buttonClass("ghost", "sm", "text-muted")}
                aria-label="Remove link"
              >
                ×
              </button>
            </div>
          ))}
          {d.links.length < CARD_LINKS_MAX ? (
            <button
              type="button"
              onClick={() => setD({ ...d, links: [...d.links, { label: "", url: "" }] })}
              className={buttonClass("ghost", "sm", "mt-2")}
            >
              + add a link
            </button>
          ) : null}
        </fieldset>
      ) : null}
      <ErrorNotice error={err} size="xs" />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className={buttonClass("primary", "sm")}
        >
          Save card
        </button>
        <button type="button" onClick={onDone} className={buttonClass("ghost", "sm", "text-muted")}>
          Cancel
        </button>
      </div>
    </div>
  );
}
