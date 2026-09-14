"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { gp } from "@/lib/base";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_EVENT,
  cardTargetFor,
  flatItems,
  groupResults,
  jumpHref,
  opensSearch,
  resultPath,
  searchApiPath,
  stepSelection,
  type SearchItem,
  type WireSearch,
} from "@/lib/search";
import { CardFields, useCard, useCardLex } from "./Card";
import { FollowButton } from "./Follow";
import { followTargetFromCard } from "@/lib/follow";
import { hasSignedInHint } from "@/lib/unread";
import { useDialogFocus } from "./a11y";

/**
 * `/` search, on every page. Agents, people, spaces and rooms by name; with no
 * query, who is online now on the commons map. Arrow keys walk the results,
 * Enter opens one, and a body on the map has a Jump button that opens the map
 * already following it (`?follow=`). The key never fires while typing: `/` in
 * a field is a character.
 *
 * Accessibility (#67): a modal dialog holding a combobox (the input) that owns
 * a listbox; the active option is `aria-activedescendant`, so focus never
 * leaves the input while arrowing. Options hold no controls: Jump is also
 * Shift+Enter, and a result's card (Follow, Open) renders below the list,
 * reachable with Tab inside the dialog's focus trap.
 *
 * Nothing private is filtered here because nothing private arrives: the API
 * omits private spaces, their rooms and where their members stand.
 */
export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<WireSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState(-1);
  const [detail, setDetail] = useState<SearchItem | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || !opensSearch(ev)) return;
      ev.preventDefault();
      returnFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    const onOpen = () => {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SEARCH_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    return () => {
      returnFocus.current?.focus?.();
    };
  }, [open]);

  // Debounced fetch. An empty query still asks: it is how "online now" arrives.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        api<WireSearch>(searchApiPath(query))
          .then((r) => {
            if (!live) return;
            setData(r);
            setFailed(false);
            setSel(-1);
          })
          .catch(() => live && setFailed(true))
          .finally(() => live && setLoading(false));
      },
      query.trim() ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const groups = useMemo(() => groupResults(data), [data]);
  const items = useMemo(() => flatItems(groups), [groups]);

  function close() {
    setOpen(false);
    setDetail(null);
    setSel(-1);
  }

  function mapUrl(): string {
    return new URL(gp("/"), window.location.origin).toString();
  }

  function go(path: string) {
    close();
    window.location.href = path.startsWith("http") ? path : gp(path);
  }

  function onInputKey(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (detail) setDetail(null);
      else close();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setDetail(null);
      setSel((s) => stepSelection(s, ev.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (ev.key === "Home" || ev.key === "End") {
      if (!items.length || sel < 0) return;
      ev.preventDefault();
      setDetail(null);
      setSel(ev.key === "Home" ? 0 : items.length - 1);
    } else if (ev.key === "Enter") {
      const item = items[sel] ?? (items.length === 1 ? items[0] : undefined);
      if (!item) return;
      ev.preventDefault();
      const jump = ev.shiftKey ? jumpHref(item, mapUrl()) : null;
      if (jump) {
        close();
        window.location.href = jump;
        return;
      }
      // Enter shows a body's or space's card first; Enter again opens it.
      if (cardTargetFor(item) && detail?.key !== item.key) setDetail(item);
      else go(resultPath(item));
    }
  }

  if (!open) return null;

  const empty = !loading && !failed && data && items.length === 0;

  return (
    <PaletteDialog onClose={close}>
        <div className="flex items-center gap-2 border-b border-white/10 px-4 focus-within:border-lantern-400/60">
          <span aria-hidden className="text-lantern-400/70">/</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setDetail(null);
            }}
            onKeyDown={onInputKey}
            placeholder="Search agents, people, spaces, rooms"
            aria-label="Search agents, people, spaces and rooms"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-controls="grove-search-results"
            aria-activedescendant={sel >= 0 && items[sel] ? `grove-search-${sel}` : undefined}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            className="min-h-12 flex-1 bg-transparent py-3 text-base text-white/90 outline-none placeholder:text-white/50 sm:text-sm"
          />
          <button
            type="button"
            onClick={close}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/55 hover:text-white/80 sm:h-8 sm:w-auto sm:px-2 sm:text-xs"
          >
            <span className="sm:hidden" aria-hidden>
              ×
            </span>
            <span className="hidden sm:inline">Esc</span>
            <span className="sr-only">Close search</span>
          </button>
        </div>

        <div className="flex-1 overflow-auto px-2 py-2">
          <div role="status" aria-live="polite" className="empty:hidden">
            {failed ? <p className="px-3 py-4 text-xs text-white/55">Search is not answering. Try again in a moment.</p> : null}
            {empty ? (
              <p className="px-3 py-4 text-xs text-white/55">{query.trim() ? "Nothing by that name." : "Nobody on the map right now."}</p>
            ) : null}
          </div>
          <div id="grove-search-results" role="listbox" aria-label="Results">
            {groups.map((g, gi) => (
              <div key={g.label} role="group" aria-labelledby={`grove-search-group-${gi}`} className="mb-2">
                <p id={`grove-search-group-${gi}`} role="presentation" className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-[0.2em] text-lantern-400/70">
                  {g.label}
                  {g.label === "Online now" ? <span className="ml-1 normal-case tracking-normal text-white/50">· {g.items.length}</span> : null}
                </p>
                {g.items.map((item) => {
                  const idx = items.indexOf(item);
                  const jump = jumpHref(item, mapUrl());
                  const selected = idx === sel;
                  return (
                    <div
                      key={item.key}
                      id={`grove-search-${idx}`}
                      role="option"
                      aria-selected={selected}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 ${selected ? "bg-white/[0.07] ring-1 ring-lantern-400/50" : "hover:bg-white/5"}`}
                      onMouseEnter={() => setSel(idx)}
                      onClick={() => (cardTargetFor(item) ? setDetail(detail?.key === item.key ? null : item) : go(resultPath(item)))}
                    >
                      <span className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center text-left sm:min-h-0">
                        <span className="flex max-w-full items-center gap-2 truncate text-white/85">
                          <KindMark type={item.type} online={"online" in item && item.online} />
                          <span className="truncate">{item.name}</span>
                        </span>
                        {item.detail ? <span className="max-w-full truncate text-xs text-white/55">{item.detail}</span> : null}
                        {jump ? <span className="sr-only">. Shift+Enter follows on the map.</span> : null}
                      </span>
                      {jump ? (
                        <a
                          href={jump}
                          tabIndex={-1}
                          aria-hidden
                          onClick={(e) => {
                            e.stopPropagation();
                            close();
                          }}
                          title={`Follow ${item.name} on the map (Shift+Enter)`}
                          className="flex min-h-11 shrink-0 items-center rounded-full border border-lantern-400/40 px-3 text-xs text-lantern-300 hover:bg-lantern-400/10 sm:min-h-0 sm:py-1"
                        >
                          Jump
                        </a>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {detail ? (
          <section aria-label={`${detail.name}: card`} className="max-h-[40%] shrink-0 overflow-auto border-t border-white/10 px-2 pt-2">
            <ResultDetail item={detail} onOpen={() => go(resultPath(detail))} />
          </section>
        ) : null}
        <p className="hidden border-t border-white/10 px-4 py-2 text-[11px] text-white/50 sm:block">
          ↑↓ to move · Enter for the card, Enter again to open · Shift+Enter or Jump follows on the map
        </p>
    </PaletteDialog>
  );
}

/** The modal shell: backdrop, focus trap, focus back to where `/` was pressed. */
function PaletteDialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // The input answers Escape itself (a card open closes first); from anywhere
  // else in the dialog (the card's buttons) Escape closes.
  useDialogFocus(ref, { modal: true, autoFocus: false, onEscape: (e) => (e.target as HTMLElement).getAttribute("role") === "combobox" ? false : onClose() });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-dusk-950/70 px-4 pt-[10svh] backdrop-blur-sm" onMouseDown={onClose}>
      <div
        ref={ref}
        data-a11y-dialog
        role="dialog"
        aria-modal="true"
        aria-label="Search Glasshouse"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[80svh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-lantern-400/25 bg-dusk-950/[0.97] text-sm shadow-2xl"
      >
        {children}
      </div>
    </div>
  );
}

function KindMark({ type, online }: { type: SearchItem["type"]; online: boolean }) {
  const glyph = type === "agent" ? "◆" : type === "human" ? "●" : type === "space" ? "▣" : "▢";
  const word = type === "agent" ? "Agent" : type === "human" ? "Person" : type === "space" ? "Space" : "Room";
  return (
    <span className={`shrink-0 text-[10px] ${online ? "text-emerald-300" : "text-white/50"}`} title={online ? `${word}, on the map now` : word}>
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{online ? `${word}, on the map now` : word}</span>
    </span>
  );
}

/**
 * A result's card (item #5): fetched on demand, 404 reads as no card. Spaces and
 * agents carry their heart, from the page's shared batch loader (#55).
 */
function ResultDetail({ item, onOpen }: { item: SearchItem; onOpen: () => void }) {
  const lex = useCardLex();
  const target = cardTargetFor(item);
  const { card, loaded } = useCard(target);
  const follow = followTargetFromCard(target);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => setSignedIn(hasSignedInHint(document.cookie)), []);
  const openWord = item.type === "space" ? "Open space" : "Open profile";
  return (
    <div className="mx-3 mb-2 rounded-xl border border-white/10 bg-dusk-800/60 px-3 py-2">
      {!loaded ? <p className="text-xs text-white/50">Reading the card…</p> : <CardFields card={card} lex={lex} />}
      <div className="mt-2 flex flex-wrap gap-2">
        {follow ? <FollowButton target={follow} signedIn={signedIn} lex={lex} name={item.name} /> : null}
        <button
          type="button"
          onClick={onOpen}
          className="min-h-11 rounded-full border border-white/15 px-3 text-xs text-white/70 hover:border-lantern-400/40 hover:text-lantern-300 sm:min-h-0 sm:py-1"
        >
          {openWord}
        </button>
      </div>
    </div>
  );
}
